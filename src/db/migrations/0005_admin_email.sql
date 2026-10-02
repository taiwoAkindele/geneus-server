-- Admin recovery email (SCHEMA.md §10). A facility admin's email is personal
-- data needed by the server alone — to email them a PIN setup code if they
-- forget their PIN — so it lives here, outside the record tables: no envelope,
-- not in the `powersync` publication, never on a phone.
CREATE TABLE staff_contacts (
  facility_id     text NOT NULL REFERENCES facilities(id),
  staff_id        text NOT NULL,
  email           text NOT NULL,                          -- trimmed, lower-case
  verified_on     timestamptz NOT NULL,                   -- only proven addresses are stored
  updated_on      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (facility_id, staff_id),
  FOREIGN KEY (facility_id, staff_id) REFERENCES staff (facility_id, id)
);

-- A 6-digit code emailed to prove an address. `purpose` and `subject` say what
-- it unlocks: a registration (subject = the invite token), a staff member's new
-- email, or — when replacing one — control of the email already on file
-- (subject = facility and staff id for both). Only a hash is kept; a code dies
-- after a few wrong guesses, its expiry, or one use.
CREATE TABLE email_verifications (
  id              text PRIMARY KEY,
  purpose         text NOT NULL CHECK (purpose IN ('registration', 'staff_email', 'staff_email_current')),
  subject         text NOT NULL,
  email           text NOT NULL,
  code_hash       text NOT NULL,
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_on      timestamptz NOT NULL DEFAULT now(),
  expires_on      timestamptz NOT NULL,
  consumed_on     timestamptz
);
CREATE INDEX email_verifications_open_idx ON email_verifications (purpose, subject) WHERE consumed_on IS NULL;

-- The `powersync` role reads every table by default privilege (docker/postgres,
-- README "Managed PostgreSQL"); it has no reason to read these. Where the role
-- does not exist (a database with no PowerSync), there is nothing to revoke.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'powersync') THEN
    REVOKE ALL ON staff_contacts, email_verifications FROM powersync;
  END IF;
END $$;
