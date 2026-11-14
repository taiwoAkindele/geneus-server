-- Claims preparation (INSURANCE-HMO-2, Milestone 3).
--
--   service_completions     — synced, insert-only: a clinician's record that a
--                             billed service was done (or not), where no other
--                             clinical record shows it.
--   insurance_authorizations— server-only, insert-only: prior authorizations and
--                             referrals as the hospital obtained them.
--   insurance_claims        — server-only: one claim per payer, patient and care
--                             episode, in revisions. Its state is a projection of
--                             insurance_claim_events, which are never changed.
--   insurance_claim_lines   — server-only, insert-only: one finalised allocation
--                             each. At most one current line per charge, so a
--                             service is never claimed twice.
--   batches, exports, submissions, acknowledgements — server-only records of
--                             what was prepared, sent and received.
-- No claim creates a receivable here: the payer share stays in the confirmed
-- allocation snapshot; Milestone 4 reconciles it.

CREATE TABLE service_completions (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  schema_version integer NOT NULL CHECK (schema_version > 0), created_by text NOT NULL, created_on timestamptz NOT NULL,
  device_id text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED, updated_by text, updated_on timestamptz,
  patient_id text NOT NULL, charge_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('completed', 'not_done')),
  completed_on timestamptz NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('doctor', 'nurse', 'chew', 'laboratory_staff', 'pharmacy_staff', 'supervisor')),
  note text CHECK (note IS NULL OR btrim(note) <> ''),
  replaces text,
  FOREIGN KEY (facility_id, charge_id, patient_id) REFERENCES charges(facility_id, id, patient_id),
  CHECK (status = 'completed' OR note IS NOT NULL),
  UNIQUE (facility_id, id)
);
-- One first record per charge; every later one corrects exactly one earlier record.
CREATE UNIQUE INDEX service_completions_first ON service_completions (facility_id, charge_id) WHERE replaces IS NULL;
CREATE UNIQUE INDEX service_completions_replaces ON service_completions (facility_id, replaces) WHERE replaces IS NOT NULL;
CREATE TRIGGER service_completions_insert_only BEFORE UPDATE OR DELETE ON service_completions FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
ALTER PUBLICATION powersync ADD TABLE service_completions;

CREATE TABLE insurance_authorizations (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  patient_id text NOT NULL, payer_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('pre_authorization', 'referral')),
  status text NOT NULL CHECK (status IN ('requested', 'approved', 'denied')),
  reference text, valid_from date NOT NULL, valid_to date NOT NULL,
  fee_item_ids jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(fee_item_ids) = 'array'),
  categories jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(categories) = 'array'),
  encounter_id text, obtained_via text NOT NULL, referred_from text, note text, evidence_document_id text,
  replaces text, recorded_by text NOT NULL, recorded_on timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (facility_id, payer_id) REFERENCES payers(facility_id, id),
  CHECK (valid_to >= valid_from), CHECK (status <> 'approved' OR btrim(coalesce(reference, '')) <> '')
);
CREATE UNIQUE INDEX insurance_authorizations_replaces ON insurance_authorizations (facility_id, replaces) WHERE replaces IS NOT NULL;
CREATE INDEX insurance_authorizations_patient ON insurance_authorizations (facility_id, patient_id);
CREATE TRIGGER insurance_authorizations_insert_only BEFORE UPDATE OR DELETE ON insurance_authorizations FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

CREATE TABLE insurance_claim_batches (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), payer_id text NOT NULL,
  reference text NOT NULL CHECK (btrim(reference) <> ''),
  period_from date NOT NULL, period_to date NOT NULL CHECK (period_to >= period_from),
  created_by text NOT NULL, created_on timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (facility_id, payer_id) REFERENCES payers(facility_id, id),
  UNIQUE (facility_id, reference)
);

CREATE TABLE insurance_claims (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  claim_number text NOT NULL, revision integer NOT NULL CHECK (revision > 0),
  supersedes text REFERENCES insurance_claims(id),
  superseded_by text REFERENCES insurance_claims(id) DEFERRABLE INITIALLY DEFERRED,
  payer_id text NOT NULL, patient_id text NOT NULL, cover_id text NOT NULL,
  episode_kind text NOT NULL CHECK (episode_kind IN ('admission', 'encounter', 'appointment', 'day')), episode_key text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  state text NOT NULL CHECK (state IN ('draft', 'ready', 'exported', 'submitted', 'acknowledged')),
  batch_id text REFERENCES insurance_claim_batches(id),
  -- What passed validation when an officer marked it ready: evidence, authorizations and diagnosis as they stood.
  ready_snapshot jsonb,
  created_by text NOT NULL, created_on timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (facility_id, payer_id) REFERENCES payers(facility_id, id),
  UNIQUE (facility_id, claim_number, revision),
  CHECK ((state = 'draft') OR ready_snapshot IS NOT NULL)
);
-- New services join one open original claim per payer, patient and episode. A revision corrects a
-- specific earlier claim, so it may be open beside that episode's newer claim.
CREATE UNIQUE INDEX insurance_claims_open_episode ON insurance_claims (facility_id, payer_id, patient_id, episode_kind, episode_key) WHERE state = 'draft' AND superseded_by IS NULL AND supersedes IS NULL;
-- Only the state, the batch, the ready snapshot and a later revision are ever written after creation;
-- a revision once replaced is frozen.
CREATE FUNCTION insurance_claim_projection_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'claims are permanent'; END IF;
  IF OLD.superseded_by IS NOT NULL THEN RAISE EXCEPTION 'a superseded claim revision never changes'; END IF;
  IF (NEW.id, NEW.facility_id, NEW.claim_number, NEW.revision, NEW.payer_id, NEW.patient_id, NEW.cover_id, NEW.episode_kind, NEW.episode_key, NEW.currency, NEW.created_by, NEW.created_on)
     IS DISTINCT FROM (OLD.id, OLD.facility_id, OLD.claim_number, OLD.revision, OLD.payer_id, OLD.patient_id, OLD.cover_id, OLD.episode_kind, OLD.episode_key, OLD.currency, OLD.created_by, OLD.created_on)
     OR NEW.supersedes IS DISTINCT FROM OLD.supersedes THEN
    RAISE EXCEPTION 'a claim''s identity and contents never change; revise it instead';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER insurance_claims_projection_only BEFORE UPDATE OR DELETE ON insurance_claims FOR EACH ROW EXECUTE FUNCTION insurance_claim_projection_only();

CREATE TABLE insurance_claim_lines (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  claim_id text NOT NULL REFERENCES insurance_claims(id),
  charge_id text NOT NULL, allocation_id text NOT NULL, contract_version_id text NOT NULL,
  current boolean NOT NULL DEFAULT true,
  FOREIGN KEY (facility_id, allocation_id) REFERENCES coverage_allocations(facility_id, id),
  UNIQUE (claim_id, charge_id)
);
-- A service is on at most one current claim line: never claimed twice.
CREATE UNIQUE INDEX insurance_claim_lines_one_current ON insurance_claim_lines (facility_id, charge_id) WHERE current;
CREATE FUNCTION insurance_claim_line_retire_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'claim lines are permanent'; END IF;
  IF NOT (OLD.current AND NOT NEW.current) OR (NEW.id, NEW.claim_id, NEW.charge_id, NEW.allocation_id, NEW.contract_version_id) IS DISTINCT FROM (OLD.id, OLD.claim_id, OLD.charge_id, OLD.allocation_id, OLD.contract_version_id) THEN
    RAISE EXCEPTION 'a claim line is only ever retired by a revision';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER insurance_claim_lines_retire_only BEFORE UPDATE OR DELETE ON insurance_claim_lines FOR EACH ROW EXECUTE FUNCTION insurance_claim_line_retire_only();

CREATE TABLE insurance_claim_events (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), claim_id text NOT NULL REFERENCES insurance_claims(id),
  state text NOT NULL CHECK (state IN ('draft', 'ready', 'exported', 'submitted', 'acknowledged')),
  staff_id text NOT NULL, at timestamptz NOT NULL DEFAULT now(), note text, ref text
);
CREATE INDEX insurance_claim_events_claim ON insurance_claim_events (claim_id, at);
CREATE TRIGGER insurance_claim_events_insert_only BEFORE UPDATE OR DELETE ON insurance_claim_events FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

CREATE TABLE insurance_claim_attachments (
  facility_id text NOT NULL REFERENCES facilities(id), claim_id text NOT NULL REFERENCES insurance_claims(id),
  document_id text NOT NULL REFERENCES insurance_documents(id), added_by text NOT NULL, added_on timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_id, document_id)
);

CREATE TABLE insurance_claim_exports (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  claim_ids jsonb NOT NULL CHECK (jsonb_typeof(claim_ids) = 'array'), batch_id text REFERENCES insurance_claim_batches(id),
  draft boolean NOT NULL, format text NOT NULL CHECK (format IN ('csv', 'xlsx', 'pdf')), template_id text,
  rows integer NOT NULL, payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  exported_by text NOT NULL, exported_on timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER insurance_claim_exports_insert_only BEFORE UPDATE OR DELETE ON insurance_claim_exports FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

CREATE TABLE insurance_claim_submissions (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), payer_id text NOT NULL,
  claim_ids jsonb NOT NULL CHECK (jsonb_typeof(claim_ids) = 'array' AND jsonb_array_length(claim_ids) > 0),
  channel text NOT NULL CHECK (channel IN ('portal', 'email', 'physical', 'other')),
  reference text NOT NULL CHECK (btrim(reference) <> ''), submitted_on date NOT NULL,
  evidence_document_id text REFERENCES insurance_documents(id), note text,
  submitted_by text NOT NULL, recorded_on timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (facility_id, payer_id) REFERENCES payers(facility_id, id)
);
CREATE TRIGGER insurance_claim_submissions_insert_only BEFORE UPDATE OR DELETE ON insurance_claim_submissions FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

CREATE TABLE insurance_claim_acknowledgements (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  submission_id text NOT NULL REFERENCES insurance_claim_submissions(id),
  reference text, acknowledged_on date NOT NULL, evidence_document_id text REFERENCES insurance_documents(id), note text,
  recorded_by text NOT NULL, recorded_on timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id)
);
CREATE TRIGGER insurance_claim_acknowledgements_insert_only BEFORE UPDATE OR DELETE ON insurance_claim_acknowledgements FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

-- Claim evidence document types, and export templates beside import mappings.
ALTER TABLE insurance_documents DROP CONSTRAINT insurance_documents_document_type_check;
ALTER TABLE insurance_documents ADD CONSTRAINT insurance_documents_document_type_check CHECK (document_type IN (
  'contract','tariff_schedule','benefit_schedule','authorization_policy','claim_template','referral_form','remittance_advice','enrollee_roster','other',
  'authorization_evidence','referral_letter','submission_evidence','acknowledgement'));
ALTER TABLE import_mapping_templates DROP CONSTRAINT import_mapping_templates_kind_check;
ALTER TABLE import_mapping_templates ADD CONSTRAINT import_mapping_templates_kind_check CHECK (kind IN ('contract_tariff', 'claim_export'));
ALTER TABLE import_mapping_templates ADD COLUMN formats jsonb CHECK (formats IS NULL OR jsonb_typeof(formats) = 'object');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'powersync') THEN
    REVOKE ALL ON insurance_authorizations, insurance_claim_batches, insurance_claims, insurance_claim_lines, insurance_claim_events,
      insurance_claim_attachments, insurance_claim_exports, insurance_claim_submissions, insurance_claim_acknowledgements FROM powersync;
  END IF;
END $$;
