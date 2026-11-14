-- Insurance / HMO foundation (docs/INSURANCE-HMO-PLAN.md, Slice 1).
--
-- Three tiers, kept apart at the table level:
--   commercial  payer_contract_versions, coverage_allocation_details,
--               insurance_requests — never published, unreadable by `powersync`.
--   schedule    cover_schedules — what the patient pays, derived at activation.
--   records     payers, patient_covers, cover_checks, coverage_elections,
--               coverage_allocations (projection only), refunds — published.
-- Money records are insert-only. No payer, price or rule is seeded.

ALTER TABLE staff DROP CONSTRAINT staff_role_check;
ALTER TABLE staff ADD CONSTRAINT staff_role_check CHECK(role IN ('chew','nurse','doctor','records_officer','facility_admin','supervisor','cashier','laboratory_staff','pharmacy_staff','insurance_officer'));
ALTER TABLE staff DROP CONSTRAINT staff_additional_roles_check;
ALTER TABLE staff ADD CONSTRAINT staff_additional_roles_check CHECK(jsonb_typeof(additional_roles) = 'array' AND additional_roles <@ '["chew","nurse","doctor","records_officer","facility_admin","supervisor","cashier","laboratory_staff","pharmacy_staff","insurance_officer"]');

-- The new permissions may be assigned to one person (AssignablePermission).
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid = 'staff'::regclass AND conname = 'staff_additional_permissions_check';
  IF definition IS NULL OR position('"payment:reverse"' IN definition) = 0 THEN RAISE EXCEPTION 'Expected staff permission constraint'; END IF;
  ALTER TABLE staff DROP CONSTRAINT staff_additional_permissions_check;
  EXECUTE 'ALTER TABLE staff ADD CONSTRAINT staff_additional_permissions_check ' ||
    replace(definition, '"payment:reverse"', '"payment:reverse", "payment:refund", "insurance_contract:read", "insurance_contract:manage", "insurance_contract:activate", "cover:record", "cover:verify", "coverage:elect_self_pay", "coverage:confirm"');
END $$;

-- Activation is refused until every active device has negotiated insurance support.
ALTER TABLE workforce_client_versions ADD COLUMN insurance_version integer;

-- Off for every hospital until an operator enables it after the rollout checks.
-- Not a synced column: devices learn it only through the negotiated sync token.
ALTER TABLE facilities ADD COLUMN insurance_enabled boolean NOT NULL DEFAULT false;
-- Every switch, with who ran it and the approval it rests on. Never changed or removed.
CREATE TABLE insurance_operator_commands (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), enabled boolean NOT NULL, time_zone text,
  operator text NOT NULL CHECK (btrim(operator) <> ''), governance_reference text NOT NULL CHECK (btrim(governance_reference) <> ''),
  recorded_on timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER insurance_operator_commands_immutable BEFORE UPDATE OR DELETE ON insurance_operator_commands FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

CREATE TABLE payers (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  schema_version integer NOT NULL CHECK (schema_version > 0), created_by text NOT NULL, created_on timestamptz NOT NULL,
  device_id text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED, updated_by text, updated_on timestamptz,
  name text NOT NULL CHECK (btrim(name) <> ''),
  kind text NOT NULL CHECK (kind IN ('national_scheme','state_scheme','hmo','company','other')),
  code text NOT NULL CHECK (btrim(code) <> ''),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (facility_id, id)
);
CREATE UNIQUE INDEX payers_active_code ON payers(facility_id, lower(code)) WHERE active;

-- Commercial terms. A draft may be edited; an active version is frozen apart from ending it once.
CREATE TABLE payer_contract_versions (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  contract_id text NOT NULL, payer_id text NOT NULL, version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft','active')),
  terms jsonb NOT NULL CHECK (jsonb_typeof(terms) = 'object'),
  revision integer NOT NULL CHECK (revision > 0),
  created_by text NOT NULL, created_on timestamptz NOT NULL, updated_by text, updated_on timestamptz,
  activated_by text, activated_on timestamptz,
  ended_on text CHECK (ended_on ~ '^\d{4}-\d{2}-\d{2}$'), ended_by text, end_reason text CHECK (btrim(end_reason) <> ''),
  FOREIGN KEY (facility_id, payer_id) REFERENCES payers(facility_id, id),
  CONSTRAINT contract_version_id CHECK (id = contract_id || ':v' || version),
  CONSTRAINT contract_activation_recorded CHECK ((status = 'active') = (activated_by IS NOT NULL AND activated_on IS NOT NULL)),
  CONSTRAINT contract_end_recorded CHECK ((ended_on IS NULL) = (ended_by IS NULL) AND (ended_on IS NULL) = (end_reason IS NULL) AND (ended_on IS NULL OR status = 'active')),
  UNIQUE (facility_id, contract_id, version),
  UNIQUE (facility_id, id)
);
CREATE UNIQUE INDEX contract_one_draft ON payer_contract_versions(facility_id, contract_id) WHERE status = 'draft';
CREATE FUNCTION freeze_active_contract() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a payer contract version is never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'active' THEN
    -- The one permitted change: recording an end date where none was recorded.
    IF OLD.ended_on IS NULL AND NEW.ended_on IS NOT NULL
       AND (to_jsonb(NEW) - 'ended_on' - 'ended_by' - 'end_reason') = (to_jsonb(OLD) - 'ended_on' - 'ended_by' - 'end_reason') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'an active payer contract version is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.facility_id <> OLD.facility_id OR NEW.contract_id <> OLD.contract_id OR NEW.payer_id <> OLD.payer_id OR NEW.version <> OLD.version OR NEW.created_by <> OLD.created_by OR NEW.created_on <> OLD.created_on THEN
    RAISE EXCEPTION 'a contract version keeps its identity' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER payer_contract_versions_frozen BEFORE UPDATE OR DELETE ON payer_contract_versions FOR EACH ROW EXECUTE FUNCTION freeze_active_contract();

CREATE TABLE cover_schedules (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  schema_version integer NOT NULL CHECK (schema_version > 0), created_by text NOT NULL, created_on timestamptz NOT NULL,
  device_id text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED, updated_by text, updated_on timestamptz,
  payer_id text NOT NULL, contract_id text NOT NULL, contract_version_id text NOT NULL, contract_version integer NOT NULL,
  plan_code text NOT NULL, plan_name text NOT NULL, currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  effective_from text NOT NULL CHECK (effective_from ~ '^\d{4}-\d{2}-\d{2}$'),
  effective_to text CHECK (effective_to ~ '^\d{4}-\d{2}-\d{2}$'),
  ended_on text CHECK (ended_on ~ '^\d{4}-\d{2}-\d{2}$'),
  self_pay_election text CHECK (self_pay_election IN ('allowed','not_allowed')),
  calculation_version integer NOT NULL,
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'object'),
  categories jsonb NOT NULL CHECK (jsonb_typeof(categories) = 'object'),
  FOREIGN KEY (facility_id, payer_id) REFERENCES payers(facility_id, id),
  FOREIGN KEY (facility_id, contract_version_id) REFERENCES payer_contract_versions(facility_id, id),
  UNIQUE (facility_id, contract_version_id, plan_code),
  UNIQUE (facility_id, id)
);
-- A schedule changes only to record its contract's end date, once.
CREATE FUNCTION schedule_end_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.ended_on IS NULL AND NEW.ended_on IS NOT NULL
     AND (to_jsonb(NEW) - 'ended_on' - 'updated_by' - 'updated_on') = (to_jsonb(OLD) - 'ended_on' - 'updated_by' - 'updated_on') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a cover schedule is immutable apart from recording its end' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER cover_schedules_end_only BEFORE UPDATE OR DELETE ON cover_schedules FOR EACH ROW EXECUTE FUNCTION schedule_end_only();

CREATE TABLE patient_covers (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  schema_version integer NOT NULL CHECK (schema_version > 0), created_by text NOT NULL, created_on timestamptz NOT NULL,
  device_id text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED, updated_by text, updated_on timestamptz,
  patient_id text NOT NULL, payer_id text NOT NULL, plan_code text NOT NULL, enrollee_number text NOT NULL CHECK (btrim(enrollee_number) <> ''),
  relationship text NOT NULL CHECK (relationship IN ('principal','dependant')), principal_name text,
  valid_from text CHECK (valid_from ~ '^\d{4}-\d{2}-\d{2}$'), valid_to text CHECK (valid_to ~ '^\d{4}-\d{2}-\d{2}$'),
  active boolean NOT NULL, replaces text,
  FOREIGN KEY (facility_id, patient_id) REFERENCES patients(facility_id, id),
  FOREIGN KEY (facility_id, payer_id) REFERENCES payers(facility_id, id),
  FOREIGN KEY (facility_id, replaces, patient_id) REFERENCES patient_covers(facility_id, id, patient_id),
  CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from <= valid_to),
  UNIQUE (facility_id, replaces),
  UNIQUE (facility_id, id, patient_id)
);
CREATE INDEX patient_covers_patient_idx ON patient_covers(facility_id, patient_id);
CREATE TRIGGER patient_covers_insert_only BEFORE UPDATE OR DELETE ON patient_covers FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

CREATE TABLE cover_checks (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  schema_version integer NOT NULL CHECK (schema_version > 0), created_by text NOT NULL, created_on timestamptz NOT NULL,
  device_id text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED, updated_by text, updated_on timestamptz,
  patient_id text NOT NULL, cover_id text NOT NULL,
  method text NOT NULL CHECK (method IN ('portal','phone','email','card_seen','letter','other')),
  reference text, result text NOT NULL CHECK (result IN ('verified','pending','not_eligible')),
  covers_from text NOT NULL CHECK (covers_from ~ '^\d{4}-\d{2}-\d{2}$'), covers_to text NOT NULL CHECK (covers_to ~ '^\d{4}-\d{2}-\d{2}$'),
  note text,
  FOREIGN KEY (facility_id, cover_id, patient_id) REFERENCES patient_covers(facility_id, id, patient_id),
  CHECK (covers_from <= covers_to),
  UNIQUE (facility_id, id, patient_id)
);
CREATE INDEX cover_checks_patient_idx ON cover_checks(facility_id, patient_id);
CREATE TRIGGER cover_checks_insert_only BEFORE UPDATE OR DELETE ON cover_checks FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

CREATE TABLE coverage_elections (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  schema_version integer NOT NULL CHECK (schema_version > 0), created_by text NOT NULL, created_on timestamptz NOT NULL,
  device_id text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED, updated_by text, updated_on timestamptz,
  patient_id text NOT NULL, kind text NOT NULL CHECK (kind IN ('use_cover','self_pay')), cover_id text NOT NULL,
  charge_ids jsonb NOT NULL CHECK (jsonb_typeof(charge_ids) = 'array' AND jsonb_array_length(charge_ids) > 0),
  reason text CHECK (reason IN ('patient_choice','not_eligible')), cover_check_id text, patient_agreed boolean, note text,
  FOREIGN KEY (facility_id, cover_id, patient_id) REFERENCES patient_covers(facility_id, id, patient_id),
  FOREIGN KEY (facility_id, cover_check_id, patient_id) REFERENCES cover_checks(facility_id, id, patient_id),
  CHECK ((kind = 'self_pay') = (reason IS NOT NULL AND patient_agreed IS TRUE)),
  CHECK (reason <> 'not_eligible' OR cover_check_id IS NOT NULL)
);
CREATE INDEX coverage_elections_patient_idx ON coverage_elections(facility_id, patient_id);
CREATE TRIGGER coverage_elections_insert_only BEFORE UPDATE OR DELETE ON coverage_elections FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

-- The synced projection of a confirmed split: the patient's share only.
CREATE TABLE coverage_allocations (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  schema_version integer NOT NULL CHECK (schema_version > 0), created_by text NOT NULL, created_on timestamptz NOT NULL,
  device_id text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED, updated_by text, updated_on timestamptz,
  patient_id text NOT NULL, charge_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('finalised','self_pay_confirmed')),
  payer_id text, arrangement text CHECK (arrangement IN ('per_service','capitation')),
  patient_share_minor integer NOT NULL CHECK (patient_share_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  basis text NOT NULL CHECK (basis IN ('visit','routine_bulk','exception')),
  supersedes text,
  FOREIGN KEY (facility_id, charge_id, patient_id) REFERENCES charges(facility_id, id, patient_id),
  FOREIGN KEY (facility_id, payer_id) REFERENCES payers(facility_id, id),
  FOREIGN KEY (facility_id, supersedes) REFERENCES coverage_allocations(facility_id, id),
  CHECK ((state = 'finalised') = (arrangement IS NOT NULL AND payer_id IS NOT NULL)),
  UNIQUE (facility_id, supersedes),
  UNIQUE (facility_id, id)
);
-- One first decision per charge; every later one names what it replaces.
CREATE UNIQUE INDEX coverage_allocation_first ON coverage_allocations(facility_id, charge_id) WHERE supersedes IS NULL;
CREATE TRIGGER coverage_allocations_insert_only BEFORE UPDATE OR DELETE ON coverage_allocations FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

-- The confidential half of each snapshot: inputs, payer share and adjustments.
CREATE TABLE coverage_allocation_details (
  allocation_id text PRIMARY KEY, facility_id text NOT NULL,
  calculation_version integer NOT NULL,
  inputs jsonb NOT NULL CHECK (jsonb_typeof(inputs) = 'object'),
  list_price_minor integer NOT NULL CHECK (list_price_minor >= 0),
  patient_share_minor integer NOT NULL CHECK (patient_share_minor >= 0),
  payer_share_minor integer NOT NULL CHECK (payer_share_minor >= 0),
  contract_adjustment_minor integer NOT NULL,
  capitation_covered_minor integer NOT NULL CHECK (capitation_covered_minor >= 0),
  reason text CHECK (btrim(reason) <> ''),
  request_key text NOT NULL,
  FOREIGN KEY (facility_id, allocation_id) REFERENCES coverage_allocations(facility_id, id),
  -- The parts account for the list price exactly, and capitation is never a receivable.
  CONSTRAINT allocation_balances CHECK (patient_share_minor + payer_share_minor + contract_adjustment_minor + capitation_covered_minor = list_price_minor),
  CONSTRAINT allocation_one_payer_part CHECK (payer_share_minor = 0 OR capitation_covered_minor = 0)
);
CREATE TRIGGER coverage_allocation_details_insert_only BEFORE UPDATE OR DELETE ON coverage_allocation_details FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
-- A snapshot must describe the charge it confirms: its price, currency and patient
-- share agree with the billing record and the synced projection, whatever code wrote it.
CREATE FUNCTION allocation_matches_charge() RETURNS trigger AS $$
DECLARE projection coverage_allocations%ROWTYPE; billed charges%ROWTYPE;
BEGIN
  SELECT * INTO projection FROM coverage_allocations WHERE facility_id = NEW.facility_id AND id = NEW.allocation_id;
  SELECT * INTO billed FROM charges WHERE facility_id = projection.facility_id AND id = projection.charge_id;
  IF billed.id IS NULL OR NEW.list_price_minor <> billed.list_price_minor OR projection.currency <> billed.currency
     OR NEW.patient_share_minor <> projection.patient_share_minor
     OR (projection.state = 'self_pay_confirmed' AND projection.patient_share_minor <> billed.amount_minor) THEN
    RAISE EXCEPTION 'a confirmed split must match its charge and projection' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER coverage_allocation_details_match_charge BEFORE INSERT ON coverage_allocation_details FOR EACH ROW EXECUTE FUNCTION allocation_matches_charge();

CREATE TABLE refunds (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  schema_version integer NOT NULL CHECK (schema_version > 0), created_by text NOT NULL, created_on timestamptz NOT NULL,
  device_id text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED, updated_by text, updated_on timestamptz,
  patient_id text NOT NULL, refund_number text NOT NULL,
  method text NOT NULL CHECK (method IN ('cash','transfer','pos')),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  allocations jsonb NOT NULL CHECK (jsonb_typeof(allocations) = 'array' AND jsonb_array_length(allocations) > 0),
  reason text NOT NULL CHECK (btrim(reason) <> ''), reference text,
  FOREIGN KEY (facility_id, patient_id) REFERENCES patients(facility_id, id),
  UNIQUE (facility_id, refund_number),
  UNIQUE (facility_id, id)
);
CREATE INDEX refunds_patient_idx ON refunds(facility_id, patient_id);
CREATE TRIGGER refunds_insert_only BEFORE UPDATE OR DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

-- Replay protection for online insurance and refund actions.
CREATE TABLE insurance_requests (
  facility_id text NOT NULL REFERENCES facilities(id), request_key text NOT NULL CHECK (length(request_key) BETWEEN 8 AND 200),
  operation text NOT NULL, staff_id text NOT NULL, body_hash text NOT NULL, response jsonb NOT NULL,
  created_on timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (facility_id, request_key)
);

ALTER PUBLICATION powersync ADD TABLE payers, cover_schedules, patient_covers, cover_checks, coverage_elections, coverage_allocations, refunds;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'powersync') THEN
    REVOKE ALL ON payer_contract_versions, coverage_allocation_details, insurance_requests, insurance_operator_commands FROM powersync;
  END IF;
END $$;
