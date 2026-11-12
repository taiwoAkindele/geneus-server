import { randomUUID } from 'node:crypto';
import { FacilityTimeZone, type Facility } from '#shared';
import type { Sql } from '../db/client.ts';
import { findRecord } from '../db/records.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';

export type InsuranceSwitch = {
  facilityId: string;
  enabled: boolean;
  /** Who ran it and the approval it rests on: a deployment decision, never a self-service toggle. */
  operator: string;
  governanceReference: string;
  /** Required to enable when the facility has none; must match when it already has one. */
  timeZone?: string;
};

export type InsuranceStatus = {
  facilityId: string; enabled: boolean; timeZone?: string;
  readiness: { kind: string; ok: boolean; detail?: string }[];
};

/** What an operator checks before enabling, and what the command itself reports. */
export const insuranceStatus = async (sql: Sql, facilityId: string): Promise<InsuranceStatus> => {
  const facility = await findRecord<Facility>(sql, 'facility', facilityId);
  if (!facility) throw new Error('Facility not found');
  const [row] = await sql<{ insurance_enabled: boolean }[]>`SELECT insurance_enabled FROM facilities WHERE id = ${facilityId}`;
  const verifiers = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM staff s JOIN staff_contacts c ON c.facility_id = s.facility_id AND c.staff_id = s.id
    WHERE s.facility_id = ${facilityId} AND s.active AND (s.role = 'insurance_officer' OR s.additional_permissions ? 'coverage:confirm')`;
  return {
    facilityId, enabled: row.insurance_enabled, ...(facility.timeZone ? { timeZone: facility.timeZone } : {}),
    readiness: [
      { kind: 'time_zone_recorded', ok: Boolean(facility.timeZone), ...(facility.timeZone ? { detail: facility.timeZone } : {}) },
      { kind: 'officer_with_verified_email', ok: verifiers[0].n > 0, detail: `${verifiers[0].n} staff` },
    ],
  };
};

/**
 * Turns insurance on or off for one hospital. Only a deployment operator runs
 * it (scripts/insurance-enable.ts, with database access), naming the approval
 * it rests on; each run is kept as an immutable command and an audit event the
 * facility can read. Enabling requires the hospital's time zone — recorded here
 * if it has none, never silently changed if it has one, because every insured
 * service is dated in it. Disabling hides insurance again and keeps every record.
 */
export const setInsuranceEnabled = async (sql: Sql, input: InsuranceSwitch): Promise<InsuranceStatus> => {
  if (!input.operator.trim() || !input.governanceReference.trim()) throw new Error('A named operator and an approval reference are required');
  if (input.timeZone) FacilityTimeZone.parse(input.timeZone);
  await sql.begin(async (tx) => {
    const [row] = await tx<{ time_zone: string | null; insurance_enabled: boolean }[]>`SELECT time_zone, insurance_enabled FROM facilities WHERE id = ${input.facilityId} FOR UPDATE`;
    if (!row) throw new Error('Facility not found');
    if (input.enabled) {
      if (row.time_zone && input.timeZone && row.time_zone !== input.timeZone) {
        throw new Error(`The facility already records ${row.time_zone}. Changing a time zone redates services; it is a separate reviewed change`);
      }
      if (!row.time_zone && !input.timeZone) throw new Error('Record the facility time zone (for example Africa/Lagos) to enable insurance');
      // Recording the time zone updates the facility row, so devices receive it with their next sync.
      if (!row.time_zone) await tx`UPDATE facilities SET time_zone = ${input.timeZone!}, updated_by = 'system', updated_on = now() WHERE id = ${input.facilityId}`;
    }
    if (row.insurance_enabled !== input.enabled) await tx`UPDATE facilities SET insurance_enabled = ${input.enabled} WHERE id = ${input.facilityId}`;
    const [device] = await tx<{ id: string }[]>`SELECT id FROM devices WHERE facility_id = ${input.facilityId} ORDER BY enrolled_on LIMIT 1`;
    await tx`INSERT INTO insurance_operator_commands (id, facility_id, enabled, time_zone, operator, governance_reference)
      VALUES (${`insurance_switch:${randomUUID()}`}, ${input.facilityId}, ${input.enabled}, ${input.timeZone ?? row.time_zone}, ${input.operator.trim()}, ${input.governanceReference.trim()})`;
    if (device) await recordAuditEvent(tx, {
      facilityId: input.facilityId, deviceId: device.id, action: 'update', entityType: 'facility', entityId: input.facilityId,
      metadata: { context: input.enabled ? 'insurance_enabled' : 'insurance_disabled', operator: input.operator.trim(), governanceReference: input.governanceReference.trim() },
    });
  });
  return insuranceStatus(sql, input.facilityId);
};
