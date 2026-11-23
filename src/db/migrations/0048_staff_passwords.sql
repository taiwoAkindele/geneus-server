-- Staff passwords (SCHEMA.md §10, "Staff passwords").
--
-- A person proves who they are with their verified email and a password, on a
-- new device or after too many wrong PINs; day to day they unlock a device with
-- its PIN, as before. A password belongs to the email, so one person with the
-- same email at several facilities has one password. Server-only: never a
-- record, never synced.

CREATE TABLE staff_passwords (
  email        text PRIMARY KEY CHECK (email = lower(email)),
  salt         text NOT NULL,
  hash         text NOT NULL,
  iterations   integer NOT NULL CHECK (iterations >= 600000),
  failures     integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  locked_until timestamptz,
  set_by       text NOT NULL CHECK (set_by IN ('invitation', 'reset', 'change')),
  set_on       timestamptz NOT NULL DEFAULT now()
);

-- What a password sign-in hands the device: permission to register this
-- person's PIN on this device, once, for a few minutes. Only a hash is kept.
CREATE TABLE staff_pin_grants (
  token_hash  text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id),
  staff_id    text NOT NULL,
  device_id   text NOT NULL REFERENCES devices(id),
  created_on  timestamptz NOT NULL DEFAULT now(),
  expires_on  timestamptz NOT NULL,
  used_on     timestamptz,
  FOREIGN KEY (facility_id, staff_id) REFERENCES staff (facility_id, id)
);

ALTER TABLE staff_device_pins DROP CONSTRAINT staff_device_pins_enrolled_by_check;
ALTER TABLE staff_device_pins ADD CONSTRAINT staff_device_pins_enrolled_by_check
  CHECK (enrolled_by IN ('setup_code', 'email', 'invitation', 'password'));

ALTER TABLE email_verifications DROP CONSTRAINT email_verifications_purpose_check;
ALTER TABLE email_verifications ADD CONSTRAINT email_verifications_purpose_check
  CHECK (purpose IN ('registration', 'staff_email', 'staff_email_current', 'workforce_access', 'operator_login', 'staff_password'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'powersync') THEN
    REVOKE ALL ON staff_passwords, staff_pin_grants FROM powersync;
  END IF;
END $$;
