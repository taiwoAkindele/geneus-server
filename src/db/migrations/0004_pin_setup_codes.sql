-- PIN setup codes (SCHEMA.md §10). An admin asks the server for a one-time
-- code that lets a member of staff set their PIN on a facility device; the
-- plain code is returned once and only its PBKDF2 hash is stored. The row is
-- synced down so a device can check a code offline, which is why it is a
-- record table with the envelope rather than a server-internal one like
-- enrollment_codes. Server-written; a device may only mark a code used.
CREATE TABLE pin_setup_codes (
  id              text PRIMARY KEY,
  facility_id     text NOT NULL REFERENCES facilities(id),
  schema_version  integer NOT NULL CHECK (schema_version > 0),
  created_by      text NOT NULL,                          -- the issuing admin
  created_on      timestamptz NOT NULL,
  device_id       text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by      text,
  updated_on      timestamptz,
  staff_id        text NOT NULL,
  code_hash       text NOT NULL,
  code_salt       text NOT NULL,
  code_iterations integer NOT NULL CHECK (code_iterations > 0),
  expires_on      timestamptz NOT NULL,
  revoked_on      timestamptz,
  used_on         timestamptz,
  used_on_device  text,
  FOREIGN KEY (facility_id, staff_id) REFERENCES staff (facility_id, id),
  CONSTRAINT pin_setup_codes_use_is_complete CHECK ((used_on IS NULL) = (used_on_device IS NULL))
);
CREATE INDEX pin_setup_codes_staff_open_idx ON pin_setup_codes (facility_id, staff_id) WHERE used_on IS NULL AND revoked_on IS NULL;

ALTER PUBLICATION powersync ADD TABLE pin_setup_codes;
