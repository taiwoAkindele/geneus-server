-- Encounters (SCHEMA.md §13, PRD §9.8). One episode of care is a header plus
-- append-only entries, one per saved step. "Saved means saved" is held here as
-- well as in the upload path: neither table accepts an UPDATE or a DELETE, and
-- the foreign keys make an amendment of another encounter's entry, or an entry
-- naming a different patient from its encounter, impossible to store.

CREATE FUNCTION forbid_clinical_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are never changed once saved (attempted %)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TABLE encounters (
  id              text PRIMARY KEY,
  facility_id     text NOT NULL REFERENCES facilities(id),
  schema_version  integer NOT NULL CHECK (schema_version > 0),
  created_by      text NOT NULL,
  created_on      timestamptz NOT NULL,
  device_id       text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by      text,
  updated_on      timestamptz,
  patient_id      text NOT NULL,
  opened_on       timestamptz NOT NULL,
  setting         text NOT NULL DEFAULT 'facility' CHECK (setting IN ('facility', 'outreach')),
  FOREIGN KEY (facility_id, patient_id) REFERENCES patients (facility_id, id),
  UNIQUE (facility_id, id),
  UNIQUE (facility_id, id, patient_id)
);
CREATE INDEX encounters_facility_patient_idx ON encounters (facility_id, patient_id, opened_on);

CREATE TRIGGER encounters_insert_only
  BEFORE UPDATE OR DELETE ON encounters
  FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

CREATE TABLE encounter_entries (
  id              text PRIMARY KEY,
  facility_id     text NOT NULL REFERENCES facilities(id),
  schema_version  integer NOT NULL CHECK (schema_version > 0),
  created_by      text NOT NULL,
  created_on      timestamptz NOT NULL,
  device_id       text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by      text,
  updated_on      timestamptz,
  encounter_id    text NOT NULL,
  patient_id      text NOT NULL,
  step            text NOT NULL CHECK (step IN (
                    'vitals', 'complaint', 'lab_order', 'lab_results', 'diagnosis',
                    'injection', 'dispense', 'admission', 'follow_up', 'amendment')),
  actor_role      text NOT NULL CHECK (actor_role IN ('chew', 'nurse', 'doctor', 'records_officer', 'facility_admin', 'supervisor')),
  amends          text,
  "values"        jsonb NOT NULL CHECK (jsonb_typeof("values") = 'object'),
  FOREIGN KEY (facility_id, encounter_id, patient_id) REFERENCES encounters (facility_id, id, patient_id),
  -- An amendment corrects an entry of its own encounter, never another's.
  FOREIGN KEY (facility_id, encounter_id, amends) REFERENCES encounter_entries (facility_id, encounter_id, id),
  UNIQUE (facility_id, encounter_id, id),
  CONSTRAINT encounter_entries_amendment_links CHECK ((step = 'amendment') = (amends IS NOT NULL))
);
CREATE INDEX encounter_entries_facility_encounter_idx ON encounter_entries (facility_id, encounter_id, created_on);
CREATE INDEX encounter_entries_facility_patient_idx ON encounter_entries (facility_id, patient_id);

CREATE TRIGGER encounter_entries_append_only
  BEFORE UPDATE OR DELETE ON encounter_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

-- A handoff may move the patient within an encounter, so the receiving unit
-- opens the same one (PRD §9.7) — an encounter of the same patient.
ALTER TABLE handoffs ADD COLUMN encounter_id text;
ALTER TABLE handoffs
  ADD FOREIGN KEY (facility_id, encounter_id, patient_id) REFERENCES encounters (facility_id, id, patient_id);

-- A refused insert keeps the record the device sent, so it can be recovered
-- from the reconcile queue rather than lost (SCHEMA.md §7).
ALTER TABLE sync_rejections
  ADD COLUMN refused_record jsonb CHECK (refused_record IS NULL OR jsonb_typeof(refused_record) = 'object');

ALTER PUBLICATION powersync ADD TABLE encounters, encounter_entries;
