import { createHash } from 'node:crypto';
/** Bind reviews/acknowledgements to the entire normalized record, including its original author. */
const instantFields = new Set(['createdOn', 'updatedOn', 'issuedOn', 'expiresOn', 'startsAt', 'endsAt', 'checkedOn', 'occurredOn', 'effectiveOn']);
const canonical = (value: unknown, root = true): unknown => {
  if (Array.isArray(value))
    return value.map((v) => canonical(v, false));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, root && instantFields.has(k) && typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : canonical(v, false)]));
  return value;
};
export const workforcePayloadHash = (record: unknown): string => createHash('sha256').update(JSON.stringify(canonical(record))).digest('hex');
