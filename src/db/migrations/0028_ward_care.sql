-- Continuing care belongs to a stay, not another outpatient attendance.
ALTER TABLE encounters ADD COLUMN inpatient_context jsonb CHECK (inpatient_context IS NULL OR jsonb_typeof(inpatient_context) = 'object');
ALTER TABLE encounter_entries ADD COLUMN admission_id text;
ALTER TABLE encounter_entries ADD COLUMN performed_on timestamptz;
ALTER TABLE encounter_entries ADD COLUMN late_reason text;
ALTER TABLE inpatient_events ADD COLUMN discharge_summary_id text;
ALTER TABLE inpatient_events ADD COLUMN departure_exception text;
ALTER TABLE inpatient_events ADD CONSTRAINT inpatient_event_patient_ref UNIQUE(facility_id,id,patient_id);
ALTER TABLE encounters ADD COLUMN ward_admission_id text GENERATED ALWAYS AS (inpatient_context->>'admissionId') STORED;
ALTER TABLE encounters ADD CONSTRAINT ward_admission_patient_ref FOREIGN KEY(facility_id,ward_admission_id,patient_id) REFERENCES inpatient_events(facility_id,id,patient_id);
ALTER TABLE encounters ADD CONSTRAINT ward_context_shape CHECK (inpatient_context IS NULL OR COALESCE((jsonb_typeof(inpatient_context->'admissionId') = 'string' AND inpatient_context->>'purpose' IN ('nursing','review','discharge') AND appointment_id IS NULL AND visit_type IS NULL), false));

CREATE TABLE ward_care_events (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id),
  device_id text NOT NULL,
  created_by text NOT NULL,
  created_on timestamptz NOT NULL,
  updated_by text,
  updated_on timestamptz,
  schema_version integer NOT NULL DEFAULT 5,
  admission_id text NOT NULL,
  encounter_id text NOT NULL,
  patient_id text NOT NULL,
  occurred_on timestamptz NOT NULL,
  actor_context jsonb,
  late_reason text,
  values jsonb NOT NULL CHECK (COALESCE(jsonb_typeof(values) = 'object' AND values->>'kind' IN ('complete','medication','administration','discharge'), false)),
  UNIQUE (facility_id, id),
  FOREIGN KEY (facility_id, admission_id, patient_id) REFERENCES inpatient_events(facility_id, id, patient_id),
  FOREIGN KEY (facility_id, encounter_id, patient_id) REFERENCES encounters(facility_id, id, patient_id),
  FOREIGN KEY (facility_id, patient_id) REFERENCES patients(facility_id, id),
  FOREIGN KEY (facility_id, created_by) REFERENCES staff(facility_id, id),
  FOREIGN KEY (device_id) REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ward_care_stay_idx ON ward_care_events(facility_id, admission_id);
CREATE INDEX encounters_stay_idx ON encounters(facility_id, (inpatient_context->>'admissionId')) WHERE inpatient_context IS NOT NULL;
CREATE UNIQUE INDEX ward_activity_complete ON ward_care_events(facility_id, encounter_id) WHERE values->>'kind' = 'complete';
CREATE UNIQUE INDEX ward_order_successor ON ward_care_events(facility_id, (values->>'previousId')) WHERE values->>'kind' = 'medication' AND values->>'previousId' IS NOT NULL;
CREATE UNIQUE INDEX ward_summary_successor ON ward_care_events(facility_id, (values->>'previousId')) WHERE values->>'kind' = 'discharge' AND values->>'previousId' IS NOT NULL;
CREATE UNIQUE INDEX ward_administration_successor ON ward_care_events(facility_id, (values->>'previousId')) WHERE values->>'kind' = 'administration' AND values->>'previousId' IS NOT NULL;
ALTER PUBLICATION powersync ADD TABLE ward_care_events;
CREATE TRIGGER ward_care_immutable BEFORE UPDATE OR DELETE ON ward_care_events FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
