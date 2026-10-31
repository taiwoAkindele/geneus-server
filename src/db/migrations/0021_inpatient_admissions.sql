-- Admission operations are immutable events, distinct from signed consultation closure.
CREATE TABLE inpatient_events (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id),
  schema_version integer NOT NULL CHECK(schema_version > 0),
  created_by text NOT NULL, created_on timestamptz NOT NULL,
  device_id text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by text, updated_on timestamptz,
  admission_id text NOT NULL, patient_id text NOT NULL, encounter_id text NOT NULL,
  request_entry_id text NOT NULL, previous_id text,
  action text NOT NULL CHECK(action IN ('confirm','reserve','arrive','transfer','ready_for_discharge','continue_care','discharge','cancel')),
  receiving_unit_id text NOT NULL, ward_id text, bed_id text,
  actor_role text NOT NULL CHECK(actor_role IN ('chew','nurse','doctor','records_officer','facility_admin','supervisor','cashier','laboratory_staff','pharmacy_staff')),
  note text,
  UNIQUE(facility_id, id),
  UNIQUE(facility_id, admission_id, patient_id, encounter_id, request_entry_id, id),
  FOREIGN KEY(facility_id, encounter_id, patient_id) REFERENCES encounters(facility_id,id,patient_id),
  FOREIGN KEY(facility_id, encounter_id, request_entry_id) REFERENCES encounter_entries(facility_id,encounter_id,id),
  FOREIGN KEY(facility_id, receiving_unit_id) REFERENCES units(facility_id,id),
  FOREIGN KEY(facility_id, ward_id) REFERENCES locations(facility_id,id),
  FOREIGN KEY(facility_id, bed_id) REFERENCES locations(facility_id,id),
  FOREIGN KEY(facility_id, admission_id, patient_id, encounter_id, request_entry_id, previous_id)
    REFERENCES inpatient_events(facility_id,admission_id,patient_id,encounter_id,request_entry_id,id),
  CHECK((action = 'confirm') = (previous_id IS NULL)),
  CHECK(previous_id IS DISTINCT FROM id),
  CHECK(action <> 'confirm' OR (admission_id = id AND ward_id IS NULL AND bed_id IS NULL)),
  CHECK((ward_id IS NULL) = (bed_id IS NULL)),
  CHECK(action NOT IN ('reserve','arrive','transfer','ready_for_discharge','continue_care','discharge') OR bed_id IS NOT NULL)
);
CREATE UNIQUE INDEX inpatient_one_successor ON inpatient_events(previous_id) WHERE previous_id IS NOT NULL;
CREATE UNIQUE INDEX inpatient_one_request ON inpatient_events(request_entry_id) WHERE action = 'confirm';
CREATE INDEX inpatient_patient ON inpatient_events(facility_id,patient_id);
CREATE INDEX inpatient_visit ON inpatient_events(facility_id,encounter_id);
CREATE INDEX inpatient_admission ON inpatient_events(facility_id,admission_id);
CREATE INDEX inpatient_bed ON inpatient_events(facility_id,bed_id);
CREATE TRIGGER inpatient_append_only BEFORE UPDATE OR DELETE ON inpatient_events FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

CREATE TABLE bed_ready_events (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  schema_version integer NOT NULL CHECK(schema_version > 0),
  created_by text NOT NULL, created_on timestamptz NOT NULL,
  device_id text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by text, updated_on timestamptz,
  bed_id text NOT NULL, release_event_id text NOT NULL,
  actor_role text NOT NULL CHECK(actor_role IN ('chew','nurse','doctor','records_officer','facility_admin','supervisor','cashier','laboratory_staff','pharmacy_staff')),
  note text,
  FOREIGN KEY(facility_id,bed_id) REFERENCES locations(facility_id,id),
  FOREIGN KEY(facility_id,release_event_id) REFERENCES inpatient_events(facility_id,id),
  UNIQUE(facility_id,bed_id,release_event_id)
);
CREATE TRIGGER bed_ready_append_only BEFORE UPDATE OR DELETE ON bed_ready_events FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
ALTER PUBLICATION powersync ADD TABLE inpatient_events, bed_ready_events;

-- Extend the existing assignable-permission vocabulary; protected approvals remain excluded.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid = 'staff'::regclass AND conname = 'staff_additional_permissions_check';
  IF definition IS NULL THEN RAISE EXCEPTION 'Expected staff permission constraint'; END IF;
  ALTER TABLE staff DROP CONSTRAINT staff_additional_permissions_check;
  EXECUTE 'ALTER TABLE staff ADD CONSTRAINT staff_additional_permissions_check ' ||
    replace(definition, '"encounter:record"', '"encounter:record", "admission:manage"');
END $$;
