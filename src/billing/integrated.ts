import type { UploadRequest } from '#shared';
import type { Sql, Tx } from '../db/client.ts';
import { BillingCompatibilityError, catalogueEnabled } from './catalogue.ts';
import { recordAuditEvent } from '../audit/auditEvents.ts';

export const integratedEnabled = async (db: Sql | Tx, facilityId: string) =>
  Boolean(
    (await db`SELECT integrated_billing_version FROM facilities WHERE id=${facilityId}`)[0]
      ?.integrated_billing_version,
  );

export const integratedReadiness = async (db: Sql | Tx, facilityId: string, now = Date.now()) => {
  const devices =
    await db`SELECT d.id,d.label,v.integrated_billing_version,v.pending_mutation_count,v.recorded_on FROM devices d LEFT JOIN workforce_client_versions v ON v.device_id=d.id WHERE d.facility_id=${facilityId} AND d.status='active' ORDER BY d.id`;

  const [migration] = await db`SELECT applied_on FROM schema_migrations WHERE version=42`;

  // Include retired devices: revocation cannot revoke an already issued PowerSync JWT.
  const [tokens] =
    await db`SELECT MAX(legacy_integrated_token_expires_on) AS expires_on FROM workforce_client_versions WHERE facility_id=${facilityId}`;

  const legacyTokensUntil = new Date(
    Math.max(
      new Date(migration?.applied_on ?? now).getTime() + 86400000,
      tokens.expires_on ? new Date(tokens.expires_on).getTime() : 0,
    ),
  ).toISOString();

  return {
    enabled: await integratedEnabled(db, facilityId),
    legacyTokensUntil,
    devices: devices.map((d) => ({
      id: String(d.id),
      label: d.label as string | null,
      blockers: [
        ...(d.integrated_billing_version !== 1 ? ['Upgrade this financial reader'] : []),
        ...(d.pending_mutation_count !== 0 ? ['Upload and review pending work'] : []),
        ...(!d.recorded_on || new Date(d.recorded_on).getTime() < now - 86400000
          ? ['Connect for a fresh status report']
          : []),
      ],
    })),
  };
};

export const negotiateIntegrated = async (
  tx: Tx,
  who: { facilityId: string; deviceId: string },
  version: number | undefined,
  ttl: number,
  now: number,
) => {
  if (version !== 1) {
    if (await integratedEnabled(tx, who.facilityId)) {
      throw new BillingCompatibilityError(
        'Update this financial reader. Pending work is retained.',
      );
    }

    await tx`UPDATE workforce_client_versions SET legacy_integrated_token_expires_on=GREATEST(legacy_integrated_token_expires_on,${new Date(now + ttl * 1000).toISOString()}::timestamptz) WHERE device_id=${who.deviceId}`;

    return false;
  }

  if (await integratedEnabled(tx, who.facilityId)) {
    return true;
  }

  const readiness = await integratedReadiness(tx, who.facilityId, now);

  if (
    (await catalogueEnabled(tx, who.facilityId)) &&
    readiness.devices.length &&
    readiness.devices.every((d) => !d.blockers.length) &&
    Date.parse(readiness.legacyTokensUntil) <= now
  ) {
    await tx`UPDATE facilities SET integrated_billing_version=1 WHERE id=${who.facilityId}`;
    await recordAuditEvent(tx, {
      facilityId: who.facilityId,
      deviceId: who.deviceId,
      action: 'update',
      metadata: { context: 'integrated_billing_compatible_readers' },
    });

    return true;
  }

  return false;
};

export const assertIntegratedUpload = async (
  tx: Tx,
  facilityId: string,
  request: UploadRequest,
) => {
  const enabled = await integratedEnabled(tx, facilityId);

  if (
    enabled &&
    (request.integratedBillingVersion !== 1 ||
      (request.schemaVersion ?? 0) < 7 ||
      (request.policyVersion ?? 0) < 17)
  ) {
    throw new BillingCompatibilityError(
      'Update this financial client before upload. Its queued work is retained.',
    );
  }

  if (
    request.mutations.some(
      (m) =>
        ['service_charge_allocation', 'coverage_financial_summary'].includes(m.table) ||
        (m.table === 'staff' &&
          Array.isArray(m.data.additionalPermissions) &&
          m.data.additionalPermissions.includes('charge:associate')),
    ) &&
    (!enabled || request.integratedBillingVersion !== 1)
  ) {
    throw new BillingCompatibilityError(
      'Service associations are waiting for compatible financial readers and expired older tokens',
    );
  }
};
