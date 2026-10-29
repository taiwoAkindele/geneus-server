-- A private review may precede the first upload of a retained unsigned draft.
-- It authorizes exact resubmission only; clinical records still enter via sync upload.
ALTER TABLE workforce_historical_reviews ALTER COLUMN rejection_id DROP NOT NULL;
CREATE TRIGGER practitioner_identity_immutable BEFORE UPDATE OF staff_id ON practitioner_profiles
  FOR EACH ROW WHEN (OLD.staff_id IS DISTINCT FROM NEW.staff_id) EXECUTE FUNCTION forbid_clinical_change();
