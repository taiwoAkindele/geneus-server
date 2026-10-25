-- Patient-level clinical records are append-only version chains, never JSON blobs patched in place.
CREATE TABLE clinical_events (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  created_by text NOT NULL,
  created_on timestamptz NOT NULL,
  device_id text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by text,
  updated_on timestamptz,
  patient_id text NOT NULL,
  encounter_id text,
  record_id text NOT NULL,
  previous_id text,
  kind text NOT NULL CHECK (kind IN ('problem', 'history', 'medication', 'allergy', 'care_plan', 'specialty')),
  actor_role text NOT NULL CHECK (actor_role IN ('chew', 'nurse', 'doctor', 'records_officer', 'facility_admin', 'supervisor', 'cashier')),
  "values" jsonb NOT NULL CHECK (jsonb_typeof("values") = 'object'),
  FOREIGN KEY (facility_id, patient_id) REFERENCES patients(facility_id, id),
  FOREIGN KEY (facility_id, encounter_id, patient_id) REFERENCES encounters(facility_id, id, patient_id),
  UNIQUE (facility_id, patient_id, kind, record_id, id),
  FOREIGN KEY (facility_id, patient_id, kind, record_id, previous_id)
    REFERENCES clinical_events(facility_id, patient_id, kind, record_id, id),
  CHECK (previous_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX clinical_events_root ON clinical_events(facility_id, record_id) WHERE previous_id IS NULL;
CREATE UNIQUE INDEX clinical_events_successor ON clinical_events(previous_id) WHERE previous_id IS NOT NULL;
CREATE INDEX clinical_events_patient ON clinical_events(facility_id, patient_id);
CREATE INDEX clinical_events_record ON clinical_events(facility_id, record_id);
CREATE TRIGGER clinical_events_append_only BEFORE UPDATE OR DELETE ON clinical_events
  FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
ALTER PUBLICATION powersync ADD TABLE clinical_events;

-- Competing structured corrections are reconciled, not silently chosen by device time.
CREATE UNIQUE INDEX encounter_correction_root ON encounter_entries(amends)
  WHERE step = 'amendment' AND "values" ? 'correctedValues' AND NOT ("values" ? 'previousAmendmentId');
CREATE UNIQUE INDEX encounter_correction_successor ON encounter_entries(("values"->>'previousAmendmentId'))
  WHERE step = 'amendment' AND "values" ? 'correctedValues' AND "values" ? 'previousAmendmentId';
