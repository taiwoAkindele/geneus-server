-- Staff sign in with email and password, then a PIN per device (SCHEMA.md §10).
-- PIN setup codes read aloud by an administrator are retired, with the record
-- that synced their hashes to devices. Invitations keep their own codes in
-- staff_invitations.
DROP TABLE pin_setup_codes;

-- Account events with no facility device to record them against: a password
-- reset from a phone or computer set up nowhere yet. Access to the email is the
-- proof. Events on a facility device stay in audit_events, which every event
-- there ties to a device. Server-only: never synced.
CREATE TABLE staff_account_events (
  id          text PRIMARY KEY,
  email       text NOT NULL CHECK (email = lower(email)),
  action      text NOT NULL CHECK (action IN ('password_reset')),
  facility_id text REFERENCES facilities(id),
  staff_id    text,
  occurred_on timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_account_events_email ON staff_account_events (email, occurred_on DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'powersync') THEN
    REVOKE ALL ON staff_account_events FROM powersync;
  END IF;
END $$;
