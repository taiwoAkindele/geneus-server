-- When insurance billing was active (INSURANCE-HMO-2, Milestone 3 corrections).
--
-- A charge is judged against cover only when it was raised inside a billing
-- period, whatever the hospital's state now. Activation opens a period from
-- that moment, so earlier cash charges are never reclassified; deactivation
-- closes it, so charges raised while billing was on keep their insurance
-- treatment, claims and receivables. A period is never edited except to close it once.

CREATE TABLE insurance_billing_periods (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id),
  starts_on timestamptz NOT NULL,
  ends_on timestamptz,
  opened_by text NOT NULL,
  closed_by text,
  CHECK (ends_on IS NULL OR ends_on > starts_on),
  CHECK ((ends_on IS NULL) = (closed_by IS NULL))
);
CREATE UNIQUE INDEX insurance_billing_periods_open ON insurance_billing_periods (facility_id) WHERE ends_on IS NULL;
CREATE INDEX insurance_billing_periods_facility ON insurance_billing_periods (facility_id, starts_on);

CREATE FUNCTION insurance_billing_period_close_once() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'insurance billing periods are permanent'; END IF;
  IF OLD.ends_on IS NOT NULL OR NEW.id <> OLD.id OR NEW.facility_id <> OLD.facility_id OR NEW.starts_on <> OLD.starts_on OR NEW.opened_by <> OLD.opened_by THEN
    RAISE EXCEPTION 'an insurance billing period is only ever closed, once';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER insurance_billing_periods_close_once BEFORE UPDATE OR DELETE ON insurance_billing_periods FOR EACH ROW EXECUTE FUNCTION insurance_billing_period_close_once();

-- Hospitals already billing: their period starts when their first contract was activated, so nothing they billed changes.
INSERT INTO insurance_billing_periods (id, facility_id, starts_on, opened_by)
SELECT 'insurance_billing_period:' || f.id || ':1', f.id,
  COALESCE((SELECT MIN(v.activated_on) FROM payer_contract_versions v WHERE v.facility_id = f.id AND v.activated_on IS NOT NULL), now()), 'migration'
FROM facilities f WHERE f.insurance_state = 'active';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'powersync') THEN
    REVOKE ALL ON insurance_billing_periods FROM powersync;
  END IF;
END $$;
