-- Lab result templates, their shared parts and answer lists. The server writes all
-- three; devices receive them read-only. Every template revision is kept, because a
-- published result names the revision it was entered against.
CREATE TABLE result_templates (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL CHECK(schema_version=5),
  created_by text NOT NULL, created_on timestamptz NOT NULL, device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  name text NOT NULL, status text NOT NULL CHECK(status IN ('draft','active','archived')),
  parts jsonb NOT NULL CHECK(jsonb_typeof(parts)='array' AND jsonb_array_length(parts)>0),
  service_definition_ids jsonb NOT NULL CHECK(jsonb_typeof(service_definition_ids)='array'),
  source text NOT NULL CHECK(source IN ('standard','own')), standard_key text,
  revision integer NOT NULL CHECK(revision>0), UNIQUE(facility_id,id),
  CHECK(status='active' OR jsonb_array_length(service_definition_ids)=0)
);
CREATE UNIQUE INDEX result_templates_standard_key ON result_templates(facility_id,standard_key) WHERE standard_key IS NOT NULL;
CREATE TABLE result_template_versions (
  facility_id text NOT NULL, source_id text NOT NULL, revision integer NOT NULL, snapshot jsonb NOT NULL,
  PRIMARY KEY(facility_id,source_id,revision), FOREIGN KEY(facility_id,source_id) REFERENCES result_templates(facility_id,id)
);
CREATE FUNCTION remember_result_template() RETURNS trigger AS $$
BEGIN
  INSERT INTO result_template_versions VALUES(NEW.facility_id,NEW.id,NEW.revision,to_jsonb(NEW)) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER result_template_history AFTER INSERT OR UPDATE ON result_templates FOR EACH ROW EXECUTE FUNCTION remember_result_template();
CREATE TRIGGER result_template_versions_immutable BEFORE UPDATE OR DELETE ON result_template_versions FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

CREATE TABLE result_parts (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL CHECK(schema_version=5),
  created_by text NOT NULL, created_on timestamptz NOT NULL, device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  part jsonb NOT NULL CHECK(jsonb_typeof(part)='object'), active boolean NOT NULL, revision integer NOT NULL CHECK(revision>0), UNIQUE(facility_id,id)
);
CREATE TABLE answer_lists (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL CHECK(schema_version=5),
  created_by text NOT NULL, created_on timestamptz NOT NULL, device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  name text NOT NULL, answers jsonb NOT NULL CHECK(jsonb_typeof(answers)='array'), active boolean NOT NULL, revision integer NOT NULL CHECK(revision>0), UNIQUE(facility_id,id)
);
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['result_templates','result_parts','answer_lists'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION check_workforce_configuration_revision()',name||'_configuration_cas',name);
  END LOOP;
END $$;
-- Settings are retired by status or flag, never removed.
CREATE TRIGGER result_templates_kept BEFORE DELETE ON result_templates FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
CREATE TRIGGER result_parts_kept BEFORE DELETE ON result_parts FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
CREATE TRIGGER answer_lists_kept BEFORE DELETE ON answer_lists FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

-- The structured result beside a lab result's plain summary.
ALTER TABLE encounter_entries ADD COLUMN lab_report jsonb CHECK(lab_report IS NULL OR jsonb_typeof(lab_report)='object');
ALTER TABLE encounter_entries ADD CONSTRAINT encounter_entries_lab_report_step CHECK(lab_report IS NULL OR step IN ('lab_results','amendment'));

DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid = 'staff'::regclass AND conname = 'staff_additional_permissions_check';
  IF definition IS NULL OR position('"service:manage"' IN definition) = 0 THEN RAISE EXCEPTION 'Expected staff permission constraint'; END IF;
  ALTER TABLE staff DROP CONSTRAINT staff_additional_permissions_check;
  EXECUTE 'ALTER TABLE staff ADD CONSTRAINT staff_additional_permissions_check ' ||
    replace(definition, '"service:manage"', '"service:manage", "result_template:manage"');
END $$;

ALTER PUBLICATION powersync ADD TABLE result_templates,result_parts,answer_lists;
