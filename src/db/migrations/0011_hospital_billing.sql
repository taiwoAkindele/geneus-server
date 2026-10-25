CREATE TABLE billing_departments (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL,
  created_by text NOT NULL, created_on timestamptz NOT NULL, device_id text NOT NULL REFERENCES devices(id),
  updated_by text, updated_on timestamptz, name text NOT NULL CHECK (btrim(name) <> ''), active boolean NOT NULL DEFAULT true,
  UNIQUE(facility_id, id)
);
CREATE UNIQUE INDEX billing_departments_active_name_idx ON billing_departments(facility_id, lower(name)) WHERE active;
ALTER TABLE appointments ADD COLUMN charge_ids jsonb;
ALTER TABLE fee_items ADD COLUMN department_id text;
ALTER TABLE fee_items ADD FOREIGN KEY (facility_id, department_id) REFERENCES billing_departments(facility_id, id);
ALTER TABLE charges ADD COLUMN department_id text;
ALTER TABLE charges ADD FOREIGN KEY (facility_id, department_id) REFERENCES billing_departments(facility_id, id);
CREATE TABLE billing_adjustments (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  schema_version integer NOT NULL, created_by text NOT NULL, created_on timestamptz NOT NULL,
  device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  patient_id text NOT NULL, charge_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('discount', 'waiver')),
  amount_minor integer NOT NULL CHECK (amount_minor > 0), reason text NOT NULL CHECK (btrim(reason) <> ''),
  FOREIGN KEY (facility_id, charge_id, patient_id) REFERENCES charges(facility_id, id, patient_id)
);
CREATE INDEX billing_adjustments_charge_idx ON billing_adjustments(facility_id, charge_id);
CREATE TRIGGER billing_adjustments_insert_only BEFORE UPDATE OR DELETE ON billing_adjustments
  FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

-- Credentials are encrypted and never published to devices.
CREATE TABLE billing_connections (
  facility_id text PRIMARY KEY REFERENCES facilities(id), encrypted_secret text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('test', 'live')), updated_by text NOT NULL,
  updated_on timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE billing_receiving_accounts (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  provider_account_id text NOT NULL, account_number text NOT NULL,
  account_name text NOT NULL, bank_name text NOT NULL, department_id text,
  mode text NOT NULL CHECK (mode IN ('test', 'live')), created_by text NOT NULL,
  created_on timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (facility_id, department_id) REFERENCES billing_departments(facility_id, id),
  UNIQUE(facility_id, mode, provider_account_id), UNIQUE(facility_id, mode, account_number)
);
CREATE TABLE incoming_transfers (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  schema_version integer NOT NULL, created_by text NOT NULL, created_on timestamptz NOT NULL,
  device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  provider text NOT NULL CHECK (provider = 'paystack'), provider_reference text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('test', 'live')),
  amount_minor integer NOT NULL CHECK (amount_minor > 0), currency text NOT NULL,
  received_on timestamptz NOT NULL, payer_name text, receiving_account text, department_id text,
  FOREIGN KEY (facility_id, department_id) REFERENCES billing_departments(facility_id, id),
  UNIQUE(facility_id, provider, mode, provider_reference), UNIQUE(facility_id, id)
);
CREATE INDEX incoming_transfers_facility_idx ON incoming_transfers(facility_id, received_on);
CREATE TRIGGER incoming_transfers_insert_only BEFORE UPDATE OR DELETE ON incoming_transfers
  FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
ALTER TABLE payments ADD COLUMN incoming_transfer_id text;
ALTER TABLE payments ADD FOREIGN KEY (facility_id, incoming_transfer_id) REFERENCES incoming_transfers(facility_id, id);
ALTER PUBLICATION powersync ADD TABLE billing_adjustments, incoming_transfers, billing_departments;
