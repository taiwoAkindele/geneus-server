-- Self-service administration: no routine operation needs a script or SQL.
--
--   facilities.time_zone_history  — every time zone and when it took effect; a
--                                   correction never re-dates earlier records.
--   staff_email_requests          — a member of staff proved an address they own;
--                                   a verified administrator confirms it is theirs.
--   platform_operators, operator_sessions — Geneus staff who approve platform
--                                   decisions, signing in with a code to their email.
--   insurance_activation_requests — a hospital asks Geneus to switch insurance
--                                   billing on; Geneus approves or rejects in the app.

ALTER TABLE facilities ADD COLUMN time_zone_history jsonb CHECK (time_zone_history IS NULL OR jsonb_typeof(time_zone_history) = 'array');
UPDATE facilities SET time_zone_history = jsonb_build_array(jsonb_build_object('timeZone', time_zone, 'from', '1970-01-01T00:00:00.000Z')) WHERE time_zone IS NOT NULL;

CREATE TABLE facility_time_zone_changes (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  from_zone text, to_zone text NOT NULL, reason text, changed_by text NOT NULL, device_id text NOT NULL, changed_on timestamptz NOT NULL DEFAULT now(),
  CHECK (from_zone IS NULL OR btrim(coalesce(reason, '')) <> '')
);
CREATE TRIGGER facility_time_zone_changes_insert_only BEFORE UPDATE OR DELETE ON facility_time_zone_changes FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

CREATE TABLE staff_email_requests (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), staff_id text NOT NULL,
  email text NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+$'),
  requested_from text NOT NULL, requested_on timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  decided_by text, decided_on timestamptz, decision_note text,
  CHECK ((status = 'pending') = (decided_on IS NULL))
);
-- One open request per person.
CREATE UNIQUE INDEX staff_email_requests_open ON staff_email_requests (facility_id, staff_id) WHERE status = 'pending';

CREATE TABLE platform_operators (
  id text PRIMARY KEY, email text NOT NULL UNIQUE CHECK (email = lower(email)), name text NOT NULL CHECK (btrim(name) <> ''),
  active boolean NOT NULL DEFAULT true, added_by text NOT NULL, added_on timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE operator_sessions (
  token_hash text PRIMARY KEY, operator_id text NOT NULL REFERENCES platform_operators(id),
  created_on timestamptz NOT NULL DEFAULT now(), expires_on timestamptz NOT NULL
);
CREATE TABLE operator_events (
  id text PRIMARY KEY, operator_id text NOT NULL REFERENCES platform_operators(id), action text NOT NULL,
  facility_id text, subject text, metadata jsonb NOT NULL DEFAULT '{}', at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER operator_events_insert_only BEFORE UPDATE OR DELETE ON operator_events FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

CREATE TABLE insurance_activation_requests (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'withdrawn')),
  note text, requested_by text NOT NULL, requested_from text NOT NULL, requested_on timestamptz NOT NULL DEFAULT now(),
  decided_by text, decided_on timestamptz, decision_note text,
  CHECK ((status = 'requested') = (decided_on IS NULL)),
  CHECK (status NOT IN ('approved', 'rejected') OR btrim(coalesce(decision_note, '')) <> '')
);
CREATE UNIQUE INDEX insurance_activation_requests_open ON insurance_activation_requests (facility_id) WHERE status = 'requested';

-- Operators sign in with a code emailed to their registered address.
ALTER TABLE email_verifications DROP CONSTRAINT email_verifications_purpose_check;
ALTER TABLE email_verifications ADD CONSTRAINT email_verifications_purpose_check CHECK (purpose IN ('registration','staff_email','staff_email_current','workforce_access','operator_login'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'powersync') THEN
    REVOKE ALL ON facility_time_zone_changes, staff_email_requests, platform_operators, operator_sessions, operator_events, insurance_activation_requests FROM powersync;
  END IF;
END $$;
