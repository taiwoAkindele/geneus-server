-- Keep legacy identified patients unchanged. Only explicit provisional records
-- may omit demographics, and later identification retains the original ID.
-- Schema 5 retains facility contract 1. Preserve schema-4 writers while allowing
-- upgraded writers to stamp the new global envelope version on those records.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['locations', 'service_definitions', 'service_offerings', 'practitioner_profiles',
    'credentials', 'capability_decisions', 'reviewer_delegations', 'clinical_authority_bootstraps',
    'external_clinical_reviewers', 'authority_snapshots', 'staff_assignments', 'service_sessions',
    'session_events', 'work_ownership_events', 'appointment_reservations']
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', table_name, table_name || '_schema_version_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (schema_version BETWEEN 4 AND 5)', table_name, table_name || '_schema_version_check');
  END LOOP;
END;
$$;

ALTER TABLE patients ALTER COLUMN address DROP NOT NULL;
ALTER TABLE patients ALTER COLUMN sex DROP NOT NULL;
ALTER TABLE patients ADD COLUMN identity_status text NOT NULL DEFAULT 'identified' CHECK (identity_status IN ('identified', 'provisional'));
ALTER TABLE patients ADD COLUMN provisional_reason text CHECK (length(btrim(provisional_reason)) BETWEEN 3 AND 500);
ALTER TABLE patients ADD COLUMN identified_by text;
ALTER TABLE patients ADD COLUMN identified_on timestamptz;
ALTER TABLE patients ADD COLUMN identification_note text CHECK (length(btrim(identification_note)) BETWEEN 3 AND 500);
ALTER TABLE patients ADD COLUMN identification_base jsonb;
ALTER TABLE patients DROP CONSTRAINT patients_have_an_age;
ALTER TABLE patients ADD CONSTRAINT patients_identity_demographics CHECK (
  identity_status = 'provisional' OR
  ((date_of_birth IS NOT NULL OR age_years IS NOT NULL) AND sex IS NOT NULL AND address IS NOT NULL AND length(btrim(address)) > 0)
);
ALTER TABLE patients ADD CONSTRAINT patients_provisional_identity CHECK (
  identity_status <> 'provisional' OR
  (schema_version >= 5 AND full_name = 'Unidentified patient · ' || patient_id AND provisional_reason IS NOT NULL
   AND identified_by IS NULL AND identified_on IS NULL AND identification_note IS NULL AND identification_base IS NULL)
);
ALTER TABLE patients ADD CONSTRAINT patients_identification_attribution CHECK (
  identity_status <> 'identified' OR
  (provisional_reason IS NULL AND identified_by IS NULL AND identified_on IS NULL AND identification_note IS NULL AND identification_base IS NULL) OR
  (provisional_reason IS NOT NULL AND identified_by IS NOT NULL AND identified_on IS NOT NULL AND identification_note IS NOT NULL
   AND identification_base IS NOT NULL AND full_name <> 'Unidentified patient · ' || patient_id)
);

CREATE FUNCTION protect_patient_identification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.identity_status = 'identified' AND NEW.provisional_reason IS NOT NULL THEN
      RAISE EXCEPTION 'Identification history must follow a provisional registration' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.provisional_reason IS DISTINCT FROM OLD.provisional_reason THEN
    RAISE EXCEPTION 'Original provisional registration circumstances cannot change' USING ERRCODE = '23514';
  END IF;
  IF OLD.identity_status = 'identified' AND
    (NEW.identity_status <> 'identified' OR NEW.identified_by IS DISTINCT FROM OLD.identified_by
     OR NEW.identified_on IS DISTINCT FROM OLD.identified_on OR NEW.identification_note IS DISTINCT FROM OLD.identification_note
     OR NEW.identification_base IS DISTINCT FROM OLD.identification_base) THEN
    RAISE EXCEPTION 'Completed identification history cannot change' USING ERRCODE = '23514';
  END IF;
  IF OLD.identity_status = 'provisional' AND NEW.identity_status = 'identified' AND
    (NEW.identified_by IS DISTINCT FROM NEW.updated_by OR NEW.identified_on IS DISTINCT FROM NEW.updated_on) THEN
    RAISE EXCEPTION 'Identification must be attributed to this change' USING ERRCODE = '23514';
  END IF;
  IF OLD.identity_status = 'provisional' AND NEW.identity_status = 'identified' AND NEW.identification_base IS DISTINCT FROM
    jsonb_build_object('fullName', OLD.full_name, 'sex', OLD.sex, 'address', OLD.address, 'dateOfBirth', OLD.date_of_birth,
      'ageYears', OLD.age_years, 'ageObservedOn', OLD.age_observed_on, 'phone', OLD.phone, 'nin', OLD.nin, 'legacyPaperRef', OLD.legacy_paper_ref) THEN
    RAISE EXCEPTION 'Patient identity details changed since review' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER patients_identification_history BEFORE INSERT OR UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION protect_patient_identification();
