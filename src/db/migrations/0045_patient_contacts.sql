-- Where a patient receives bills and receipts: an optional email (the phone stays on the patient) and the
-- channels the patient has stopped. Insert-only; each change replaces the previous record, so the history of
-- who stopped or changed what is kept. Staff records come from devices; patient records are server-written.
CREATE TABLE patient_contacts (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  schema_version integer NOT NULL CHECK (schema_version > 0), created_by text NOT NULL, created_on timestamptz NOT NULL,
  device_id text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED, updated_by text, updated_on timestamptz,
  patient_id text NOT NULL,
  email text CHECK (email IS NULL OR (length(email) <= 200 AND email = lower(btrim(email)) AND email LIKE '%_@_%')),
  sms_stopped boolean NOT NULL, email_stopped boolean NOT NULL,
  source text NOT NULL CHECK (source IN ('staff','patient')),
  replaces text,
  FOREIGN KEY (facility_id, patient_id) REFERENCES patients(facility_id, id),
  FOREIGN KEY (facility_id, replaces, patient_id) REFERENCES patient_contacts(facility_id, id, patient_id),
  UNIQUE (facility_id, replaces),
  UNIQUE (facility_id, id, patient_id)
);
-- One chain per patient: only the first record may replace nothing.
CREATE UNIQUE INDEX patient_contacts_first_idx ON patient_contacts(facility_id, patient_id) WHERE replaces IS NULL;
CREATE TRIGGER patient_contacts_insert_only BEFORE UPDATE OR DELETE ON patient_contacts FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

ALTER PUBLICATION powersync ADD TABLE patient_contacts;
