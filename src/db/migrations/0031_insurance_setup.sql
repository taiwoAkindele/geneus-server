-- Insurance setup separate from insurance billing (INSURANCE-HMO-2, Milestone 1).
--
-- One state replaces the on/off flag: off → setup → active. `setup` lets a
-- hospital prepare payers, contracts, documents, imports and submission
-- settings without changing any balance; only `active` applies cover to bills.
-- Every hospital keeps its current meaning: enabled becomes active.

ALTER TABLE facilities ADD COLUMN insurance_state text NOT NULL DEFAULT 'off' CHECK (insurance_state IN ('off', 'setup', 'active'));
UPDATE facilities SET insurance_state = 'active' WHERE insurance_enabled;
ALTER TABLE facilities DROP COLUMN insurance_enabled;

-- 0030 gained this table after some databases had already applied it; create it where it is missing.
CREATE TABLE IF NOT EXISTS insurance_operator_commands (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), enabled boolean NOT NULL, time_zone text,
  operator text NOT NULL CHECK (btrim(operator) <> ''), governance_reference text NOT NULL CHECK (btrim(governance_reference) <> ''),
  recorded_on timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE TRIGGER insurance_operator_commands_immutable BEFORE UPDATE OR DELETE ON insurance_operator_commands FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

-- Each operator command records the state it set; `enabled` stays for the commands already recorded.
ALTER TABLE insurance_operator_commands ADD COLUMN state text CHECK (state IN ('off', 'setup', 'active'));

-- Supporting documents: evidence, never configuration. Server-held and never published to devices.
CREATE TABLE insurance_documents (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  payer_id text NOT NULL, document_type text NOT NULL CHECK (document_type IN ('contract','tariff_schedule','benefit_schedule','authorization_policy','claim_template','referral_form','remittance_advice','enrollee_roster','other')),
  title text NOT NULL CHECK (btrim(title) <> ''), file_name text NOT NULL CHECK (btrim(file_name) <> ''),
  mime_type text NOT NULL CHECK (mime_type IN ('application/pdf','image/jpeg','image/png','image/webp')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'), content bytea NOT NULL,
  version integer NOT NULL CHECK (version > 0), replaces text,
  effective_from text CHECK (effective_from ~ '^\d{4}-\d{2}-\d{2}$'), notes text,
  verification text NOT NULL DEFAULT 'unverified' CHECK (verification IN ('unverified','verified','rejected')),
  verified_by text, verified_on timestamptz, verification_note text,
  uploaded_by text NOT NULL, uploaded_on timestamptz NOT NULL DEFAULT now(), device_id text NOT NULL,
  FOREIGN KEY (facility_id, payer_id) REFERENCES payers(facility_id, id),
  FOREIGN KEY (facility_id, uploaded_by) REFERENCES staff(facility_id, id),
  UNIQUE (facility_id, replaces),
  UNIQUE (facility_id, id),
  CHECK ((verification = 'unverified') = (verified_by IS NULL AND verified_on IS NULL))
);
CREATE INDEX insurance_documents_payer_idx ON insurance_documents(facility_id, payer_id);
-- A document never changes; only its verification is recorded, once.
CREATE FUNCTION insurance_document_verification_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.verification = 'unverified' AND NEW.verification <> 'unverified'
     AND (to_jsonb(NEW) - 'verification' - 'verified_by' - 'verified_on' - 'verification_note') = (to_jsonb(OLD) - 'verification' - 'verified_by' - 'verified_on' - 'verification_note') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'an insurance document is immutable apart from recording its verification once' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER insurance_documents_immutable BEFORE UPDATE OR DELETE ON insurance_documents FOR EACH ROW EXECUTE FUNCTION insurance_document_verification_only();

-- How each payer's claims leave the hospital. Operational, editable, every change audited.
CREATE TABLE payer_submission_profiles (
  facility_id text NOT NULL REFERENCES facilities(id), payer_id text NOT NULL,
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile) = 'object' AND profile->>'method' = 'manual'),
  revision integer NOT NULL CHECK (revision > 0), updated_by text NOT NULL, updated_on timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (facility_id, payer_id),
  FOREIGN KEY (facility_id, payer_id) REFERENCES payers(facility_id, id)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'powersync') THEN
    REVOKE ALL ON insurance_documents, payer_submission_profiles, insurance_operator_commands FROM powersync;
  END IF;
END $$;
