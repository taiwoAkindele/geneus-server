-- Insurance completion: audit fixes H1–H3 and hospital-side settlement (Slice 4).
--
--   diagnosis_catalogue_*      — server-only: diagnosis code lists a hospital imported
--                                under its own licence. Claims check codes against them.
--   insurance_authorizations   — emergency exceptions, requested date, approved quantities.
--   insurance_claim_decisions  — server-only, insert-only: what the payer decided, per
--                                claim revision and per service. Geneus records it; it
--                                never decides.
--   insurance_remittances      — server-only, insert-only: money received from a payer.
--                                Kept apart from patient payments; never touches a
--                                patient's account.
--   insurance_remittance_allocations / _reversals — how that money settles claims; a
--                                remittance recorded in error is reversed whole.
--   insurance_claim_disputes / _dispute_resolutions / insurance_write_offs — insert-only.
-- Nothing here creates patient debt.

-- New permissions may be assigned to one person.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid = 'staff'::regclass AND conname = 'staff_additional_permissions_check';
  IF definition IS NULL OR position('"coverage:confirm"' IN definition) = 0 THEN RAISE EXCEPTION 'Expected staff permission constraint'; END IF;
  ALTER TABLE staff DROP CONSTRAINT staff_additional_permissions_check;
  EXECUTE 'ALTER TABLE staff ADD CONSTRAINT staff_additional_permissions_check ' ||
    replace(definition, '"coverage:confirm"', '"coverage:confirm", "coverage:approve_liability_change", "insurance_remittance:record", "billing:write_off"');
END $$;

-- H2: emergency exceptions and what exactly was approved.
ALTER TABLE insurance_authorizations DROP CONSTRAINT insurance_authorizations_status_check;
ALTER TABLE insurance_authorizations ADD CONSTRAINT insurance_authorizations_status_check CHECK (status IN ('requested', 'approved', 'denied', 'emergency_exception'));
ALTER TABLE insurance_authorizations ADD COLUMN approved_quantities jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(approved_quantities) = 'object');
ALTER TABLE insurance_authorizations ADD COLUMN requested_on date;
ALTER TABLE insurance_authorizations ADD CONSTRAINT insurance_authorizations_emergency_note CHECK (status <> 'emergency_exception' OR btrim(coalesce(note, '')) <> '');

ALTER TABLE import_mapping_templates DROP CONSTRAINT import_mapping_templates_kind_check;
ALTER TABLE import_mapping_templates ADD CONSTRAINT import_mapping_templates_kind_check CHECK (kind IN ('contract_tariff', 'claim_export', 'diagnosis_catalogue', 'remittance'));

ALTER TABLE insurance_documents DROP CONSTRAINT insurance_documents_document_type_check;
ALTER TABLE insurance_documents ADD CONSTRAINT insurance_documents_document_type_check CHECK (document_type IN (
  'contract','tariff_schedule','benefit_schedule','authorization_policy','claim_template','referral_form','remittance_advice','enrollee_roster','other',
  'authorization_evidence','referral_letter','submission_evidence','acknowledgement','payer_decision','dispute_correspondence'));

-- H1: licensed diagnosis catalogues, one current list per code system.
CREATE TABLE diagnosis_catalogue_imports (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  code_system text NOT NULL CHECK (btrim(code_system) <> ''), edition text NOT NULL CHECK (btrim(edition) <> ''),
  licence_reference text NOT NULL CHECK (length(btrim(licence_reference)) >= 3),
  mode text NOT NULL CHECK (mode IN ('merge', 'replace')), file_name text NOT NULL, file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  rows integer NOT NULL CHECK (rows >= 0), added integer NOT NULL, changed integer NOT NULL, removed integer NOT NULL,
  imported_by text NOT NULL, imported_on timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER diagnosis_catalogue_imports_insert_only BEFORE UPDATE OR DELETE ON diagnosis_catalogue_imports FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
CREATE TABLE diagnosis_catalogue_entries (
  facility_id text NOT NULL REFERENCES facilities(id), code_system text NOT NULL, code text NOT NULL CHECK (code = upper(btrim(code)) AND code <> ''),
  description text NOT NULL CHECK (btrim(description) <> ''), import_id text NOT NULL REFERENCES diagnosis_catalogue_imports(id),
  PRIMARY KEY (facility_id, code_system, code)
);

-- Which files went with a submission, and which earlier submission it corrects.
ALTER TABLE insurance_claim_submissions ADD COLUMN export_ids jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(export_ids) = 'array');
ALTER TABLE insurance_claim_submissions ADD COLUMN resubmission boolean NOT NULL DEFAULT false;

-- Slice 4: the payer's decisions.
CREATE TABLE insurance_claim_decisions (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), claim_id text NOT NULL REFERENCES insurance_claims(id),
  decision text NOT NULL CHECK (decision IN ('approved', 'partially_approved', 'queried', 'returned', 'denied')),
  decided_on date NOT NULL, approved_minor bigint NOT NULL CHECK (approved_minor >= 0),
  payer_reference text, reason_code text, reason text, evidence_document_id text REFERENCES insurance_documents(id),
  supersedes text REFERENCES insurance_claim_decisions(id),
  recorded_by text NOT NULL, recorded_on timestamptz NOT NULL DEFAULT now(),
  CHECK (decision = 'approved' OR btrim(coalesce(reason, '') || coalesce(reason_code, '')) <> ''),
  CHECK (decision NOT IN ('queried', 'returned') OR approved_minor = 0)
);
CREATE UNIQUE INDEX insurance_claim_decisions_supersedes ON insurance_claim_decisions (supersedes) WHERE supersedes IS NOT NULL;
CREATE UNIQUE INDEX insurance_claim_decisions_first ON insurance_claim_decisions (claim_id) WHERE supersedes IS NULL;
CREATE TRIGGER insurance_claim_decisions_insert_only BEFORE UPDATE OR DELETE ON insurance_claim_decisions FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
CREATE TABLE insurance_claim_line_decisions (
  decision_id text NOT NULL REFERENCES insurance_claim_decisions(id), facility_id text NOT NULL REFERENCES facilities(id),
  charge_id text NOT NULL, claimed_minor bigint NOT NULL CHECK (claimed_minor >= 0),
  approved_minor bigint NOT NULL CHECK (approved_minor >= 0 AND approved_minor <= claimed_minor),
  reason_code text, reason text,
  PRIMARY KEY (decision_id, charge_id)
);
CREATE TRIGGER insurance_claim_line_decisions_insert_only BEFORE UPDATE OR DELETE ON insurance_claim_line_decisions FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

-- Slice 4: money from payers.
CREATE TABLE insurance_remittances (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), payer_id text NOT NULL,
  received_on date NOT NULL, reference text NOT NULL CHECK (btrim(reference) <> ''),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0), currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  method text NOT NULL CHECK (method IN ('transfer', 'cheque', 'cash', 'other')), receiving_account text,
  evidence_document_id text REFERENCES insurance_documents(id), note text,
  source jsonb CHECK (source IS NULL OR jsonb_typeof(source) = 'object'),
  recorded_by text NOT NULL, recorded_on timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (facility_id, payer_id) REFERENCES payers(facility_id, id)
);
CREATE INDEX insurance_remittances_payer ON insurance_remittances (facility_id, payer_id, reference);
CREATE TRIGGER insurance_remittances_insert_only BEFORE UPDATE OR DELETE ON insurance_remittances FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
CREATE TABLE insurance_remittance_allocations (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  remittance_id text NOT NULL REFERENCES insurance_remittances(id), claim_id text NOT NULL REFERENCES insurance_claims(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  recorded_by text NOT NULL, recorded_on timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX insurance_remittance_allocations_claim ON insurance_remittance_allocations (facility_id, claim_id);
CREATE INDEX insurance_remittance_allocations_remittance ON insurance_remittance_allocations (remittance_id);
CREATE TRIGGER insurance_remittance_allocations_insert_only BEFORE UPDATE OR DELETE ON insurance_remittance_allocations FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
CREATE TABLE insurance_remittance_reversals (
  remittance_id text PRIMARY KEY REFERENCES insurance_remittances(id), facility_id text NOT NULL REFERENCES facilities(id),
  reason text NOT NULL CHECK (length(btrim(reason)) >= 3), reversed_by text NOT NULL, reversed_on timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER insurance_remittance_reversals_insert_only BEFORE UPDATE OR DELETE ON insurance_remittance_reversals FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

-- Slice 4: disputes and write-offs, against a claim number through any of its revisions.
CREATE TABLE insurance_claim_disputes (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), claim_id text NOT NULL REFERENCES insurance_claims(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0), reason text NOT NULL CHECK (length(btrim(reason)) >= 3), payer_reference text,
  opened_by text NOT NULL, opened_on timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER insurance_claim_disputes_insert_only BEFORE UPDATE OR DELETE ON insurance_claim_disputes FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
CREATE TABLE insurance_claim_dispute_resolutions (
  dispute_id text PRIMARY KEY REFERENCES insurance_claim_disputes(id), facility_id text NOT NULL REFERENCES facilities(id),
  outcome text NOT NULL CHECK (outcome IN ('payer_agreed', 'payer_upheld', 'withdrawn')), note text NOT NULL CHECK (length(btrim(note)) >= 3),
  resolved_by text NOT NULL, resolved_on timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER insurance_claim_dispute_resolutions_insert_only BEFORE UPDATE OR DELETE ON insurance_claim_dispute_resolutions FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
CREATE TABLE insurance_write_offs (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), claim_id text NOT NULL REFERENCES insurance_claims(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0), reason text NOT NULL CHECK (length(btrim(reason)) >= 3),
  written_off_by text NOT NULL, written_off_on timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER insurance_write_offs_insert_only BEFORE UPDATE OR DELETE ON insurance_write_offs FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'powersync') THEN
    REVOKE ALL ON diagnosis_catalogue_imports, diagnosis_catalogue_entries, insurance_claim_decisions, insurance_claim_line_decisions,
      insurance_remittances, insurance_remittance_allocations, insurance_remittance_reversals,
      insurance_claim_disputes, insurance_claim_dispute_resolutions, insurance_write_offs FROM powersync;
  END IF;
END $$;
