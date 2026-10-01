import { rosterSignaturePayload } from '#shared';
import type { Sql } from '../db/client.ts';
import type { Signer } from '../lib/signing.ts';

/**
 * Roster signing (PLAN.md §4.5). Shifts are written on devices and arrive
 * unsigned; this pass signs each one so a device can tell, offline, a genuine
 * shift from one edited on the phone. It runs inside the one server process on
 * a plain timer — there is one job, so a scheduler would be a dependency
 * without a purpose.
 *
 * An upload that changes a signed field clears the signature (src/sync/upload.ts),
 * which puts the shift back in this pass's queue.
 */

type UnsignedShift = {
  id: string;
  staff_id: string;
  facility_id: string;
  starts_at: string;
  ends_at: string;
  extended_until: string | null;
};

/** Bounds one pass, so a backlog after downtime is worked through without one long transaction. */
const BATCH_SIZE = 500;

/** Signs up to one batch of unsigned shifts and returns how many it signed. */
export const signPendingShifts = async (sql: Sql, signer: Signer): Promise<number> => {
  const shifts = await sql<UnsignedShift[]>`
    SELECT id, staff_id, facility_id, starts_at, ends_at, extended_until
    FROM roster_shifts
    WHERE signature IS NULL
    ORDER BY created_on
    LIMIT ${BATCH_SIZE}`;

  let signed = 0;
  for (const shift of shifts) {
    const payload = rosterSignaturePayload({
      staffId: shift.staff_id,
      facilityId: shift.facility_id,
      startsAt: shift.starts_at,
      endsAt: shift.ends_at,
      extendedUntil: shift.extended_until ?? undefined,
    });
    const signature = signer.signBytes(Buffer.from(payload, 'utf8')).toString('base64');
    // Written only if the shift still holds the values just signed: an upload
    // that changed it in the meantime leaves it unsigned for the next pass.
    const updated = await sql`
      UPDATE roster_shifts SET signature = ${signature}
      WHERE id = ${shift.id}
        AND signature IS NULL
        AND staff_id = ${shift.staff_id}
        AND starts_at = ${shift.starts_at}
        AND ends_at = ${shift.ends_at}
        AND extended_until IS NOT DISTINCT FROM ${shift.extended_until}`;
    signed += updated.count;
  }
  return signed;
};

export type RosterSigning = { stop: () => Promise<void> };

/**
 * Runs `signPendingShifts` every `intervalMs`. A pass never overlaps the
 * previous one, and `stop` waits for a pass in progress so shutdown does not
 * close the database under it.
 */
export const startRosterSigning = (
  sql: Sql,
  signer: Signer,
  log: { info: (details: object, message: string) => void; error: (details: object, message: string) => void },
  intervalMs = 60_000,
): RosterSigning => {
  let running: Promise<void> | undefined;
  const pass = () => {
    if (running) return;
    running = signPendingShifts(sql, signer)
      .then(
        (signed) => {
          if (signed > 0) log.info({ signed }, 'roster shifts signed');
        },
        (cause: unknown) => log.error({ cause }, 'roster signing pass failed'),
      )
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(pass, intervalMs);
  pass();
  return {
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
};
