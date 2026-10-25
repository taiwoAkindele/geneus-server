-- Additive: legacy ages keep their original registration-date anchor.
ALTER TABLE patients ADD COLUMN age_observed_on date;
ALTER TABLE patients ADD COLUMN identity_evidence text CHECK (identity_evidence IN ('reported', 'document_seen'));
ALTER TABLE patients ADD COLUMN identity_evidence_note text;

CREATE TABLE patient_identity_events (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL,
  created_by text NOT NULL, created_on timestamptz NOT NULL,
  device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  patient_id text NOT NULL, other_patient_id text,
  outcome text NOT NULL CHECK (outcome IN ('existing_selected', 'registration_distinct', 'review_requested', 'linked', 'distinct', 'unlinked')),
  reason text NOT NULL CHECK (length(btrim(reason)) >= 3),
  revision integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  FOREIGN KEY (facility_id, patient_id) REFERENCES patients(facility_id, id),
  FOREIGN KEY (facility_id, other_patient_id) REFERENCES patients(facility_id, id),
  CHECK (outcome = 'existing_selected' OR (other_patient_id IS NOT NULL AND other_patient_id <> patient_id))
);
CREATE INDEX patient_identity_events_facility_idx ON patient_identity_events(facility_id, revision);
CREATE TRIGGER patient_identity_events_insert_only BEFORE UPDATE OR DELETE ON patient_identity_events
  FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
ALTER PUBLICATION powersync ADD TABLE patient_identity_events;
