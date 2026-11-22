import { createHash } from 'node:crypto';

/** Code-unit order (not locale order), so the device and the server hash the same bytes. */
const compareKeys = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }

  return a > b ? 1 : 0;
};

/** Bind reviews/acknowledgements to the entire normalized record, including its original author. */
const instantFields = new Set([
  'createdOn',
  'updatedOn',
  'issuedOn',
  'expiresOn',
  'startsAt',
  'endsAt',
  'checkedOn',
  'occurredOn',
  'performedOn',
  'effectiveOn',
]);

const canonical = (value: unknown, root = true): unknown => {
  if (Array.isArray(value)) {
    return value.map((v) => canonical(v, false));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => compareKeys(a, b))
        .map(([k, v]) => [
          k,
          root && instantFields.has(k) && typeof v === 'string' && Number.isFinite(Date.parse(v))
            ? new Date(v).toISOString()
            : canonical(v, false),
        ]),
    );
  }

  return value;
};

export const workforcePayloadHash = (record: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonical(record)))
    .digest('hex');
