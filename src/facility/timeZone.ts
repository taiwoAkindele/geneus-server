import { randomUUID } from 'node:crypto';
import { FacilityTimeZone, timeZoneAt, type Facility } from '#shared';
import type { Sql, Tx } from '../db/client.ts';
import { findRecord } from '../db/records.ts';

export class TimeZoneRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'TimeZoneRefusal'; this.code = code; }
}

type History = { timeZone: string; from: string }[];

/**
 * Records the facility's time zone, or corrects it. A correction applies from
 * now: the history keeps every earlier zone with the moment it took effect,
 * so services raised before keep the date they had, and confirmed splits and
 * claims (which store their service date) never change. A correction needs a
 * reason; every change is kept permanently.
 */
export const recordFacilityTimeZone = async (tx: Tx, input: { facilityId: string; timeZone: string; by: string; deviceId?: string; reason?: string }) => {
  const zone = FacilityTimeZone.parse(input.timeZone);
  const [row] = await tx<{ time_zone: string | null; time_zone_history: History | null }[]>`SELECT time_zone, time_zone_history FROM facilities WHERE id = ${input.facilityId} FOR UPDATE`;
  if (!row) throw new TimeZoneRefusal('not_found', 'Facility not found');
  if (row.time_zone === zone) return { changed: false, timeZone: zone };
  if (row.time_zone && !input.reason?.trim()) throw new TimeZoneRefusal('reason_required', 'Say why the time zone is being corrected');
  const now = new Date().toISOString();
  const history: History = row.time_zone_history?.length ? [...row.time_zone_history] : row.time_zone ? [{ timeZone: row.time_zone, from: '1970-01-01T00:00:00.000Z' }] : [];
  history.push({ timeZone: zone, from: history.length ? now : '1970-01-01T00:00:00.000Z' });
  await tx`UPDATE facilities SET time_zone = ${zone}, time_zone_history = ${tx.json(history)}, updated_by = ${input.by}, updated_on = now() WHERE id = ${input.facilityId}`;
  await tx`INSERT INTO facility_time_zone_changes (id, facility_id, from_zone, to_zone, reason, changed_by, device_id)
    VALUES (${`time_zone_change:${randomUUID()}`}, ${input.facilityId}, ${row.time_zone}, ${zone}, ${input.reason?.trim() || null}, ${input.by}, ${input.deviceId ?? 'none'})`;
  return { changed: true, timeZone: zone, from: row.time_zone ?? undefined };
};

export const timeZoneChanges = async (sql: Sql | Tx, facilityId: string) =>
  (await sql<{ from_zone: string | null; to_zone: string; reason: string | null; changed_by: string; changed_on: Date; full_name: string | null }[]>`
    SELECT c.*, s.full_name FROM facility_time_zone_changes c LEFT JOIN staff s ON s.facility_id = c.facility_id AND s.id = c.changed_by
    WHERE c.facility_id = ${facilityId} ORDER BY c.changed_on DESC LIMIT 50`)
    .map((c) => ({ from: c.from_zone ?? undefined, to: c.to_zone, reason: c.reason ?? undefined, by: c.full_name ?? c.changed_by, on: new Date(c.changed_on).toISOString() }));

/** The zone in force when each moment happened, for dating records raised before a correction. */
export const facilityZones = async (sql: Sql | Tx, facilityId: string) => {
  const facility = await findRecord<Facility>(sql, 'facility', facilityId);
  return { current: facility?.timeZone, at: (moment: string) => timeZoneAt(facility, moment) };
};
