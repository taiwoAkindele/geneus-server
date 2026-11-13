import { randomUUID } from 'node:crypto';
import type { InsuranceBillingPeriod } from '#shared';
import type { Sql, Tx } from '../db/client.ts';

/** Every span during which this hospital's insurance billing was active, oldest first. */
export const billingPeriods = async (sql: Sql | Tx, facilityId: string): Promise<InsuranceBillingPeriod[]> =>
  (await sql<{ starts_on: Date; ends_on: Date | null }[]>`SELECT starts_on, ends_on FROM insurance_billing_periods WHERE facility_id = ${facilityId} ORDER BY starts_on`)
    .map((r) => ({ from: new Date(r.starts_on).toISOString(), ...(r.ends_on ? { to: new Date(r.ends_on).toISOString() } : {}) }));

/** Billing becomes active from now: nothing raised before this moment is reclassified. */
export const openBillingPeriod = async (tx: Tx, facilityId: string, by: string) =>
  tx`INSERT INTO insurance_billing_periods (id, facility_id, starts_on, opened_by) VALUES (${`insurance_billing_period:${randomUUID()}`}, ${facilityId}, now(), ${by})`;

/** Billing stops from now; charges raised while it was on keep their insurance treatment. */
export const closeBillingPeriod = async (tx: Tx, facilityId: string, by: string) =>
  tx`UPDATE insurance_billing_periods SET ends_on = now(), closed_by = ${by} WHERE facility_id = ${facilityId} AND ends_on IS NULL`;
