-- Server-verified staff sessions (online configuration and administration).
--
-- A PIN used to exist only on each device, so the server could not tell which
-- member of staff held a shared device. Now, when a PIN is set from an
-- administrator's PIN setup code (or confirmed once with the person's own
-- verified email), the device also registers it here for that device. Signing
-- in online proves the PIN to the server and opens a short session bound to
-- the person and the device; a new sign-in on the device ends the previous one.

CREATE TABLE staff_device_pins (
  facility_id text NOT NULL REFERENCES facilities(id), staff_id text NOT NULL, device_id text NOT NULL REFERENCES devices(id),
  salt text NOT NULL, hash text NOT NULL, iterations integer NOT NULL CHECK (iterations >= 100000),
  failures integer NOT NULL DEFAULT 0, locked_until timestamptz,
  enrolled_by text NOT NULL CHECK (enrolled_by IN ('setup_code', 'email')), enrolled_on timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (facility_id, staff_id, device_id)
);

CREATE TABLE staff_sessions (
  token_hash text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), staff_id text NOT NULL, device_id text NOT NULL REFERENCES devices(id),
  created_on timestamptz NOT NULL DEFAULT now(), last_used_on timestamptz NOT NULL DEFAULT now(), expires_on timestamptz NOT NULL, ended_on timestamptz
);
CREATE INDEX staff_sessions_device ON staff_sessions (device_id) WHERE ended_on IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'powersync') THEN
    REVOKE ALL ON staff_device_pins, staff_sessions FROM powersync;
  END IF;
END $$;
