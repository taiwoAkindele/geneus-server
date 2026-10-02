-- Device enrollment codes (root §4.3c). An already-enrolled device, with a
-- staff member holding `device:enroll` signed in, asks the server for a short
-- code and reads it out to the joining device; the joining device spends it
-- for its own credential. Short-lived, single-use, facility-bound: the code
-- decides which facility the new device belongs to, so it is never guessable
-- from the outside and never reusable.
CREATE TABLE enrollment_codes (
  code            text PRIMARY KEY,                       -- stored uppercase
  facility_id     text NOT NULL REFERENCES facilities(id),
  issued_by       text NOT NULL,                          -- staff id
  issued_from     text NOT NULL REFERENCES devices(id),   -- the enrolled device that asked
  created_on      timestamptz NOT NULL DEFAULT now(),
  expires_on      timestamptz NOT NULL,
  claimed_on      timestamptz,
  claimed_by      text,                                   -- the device id that spent it
  FOREIGN KEY (facility_id, issued_by) REFERENCES staff (facility_id, id),
  CONSTRAINT enrollment_codes_claim_is_complete CHECK ((claimed_on IS NULL) = (claimed_by IS NULL))
);
CREATE INDEX enrollment_codes_facility_idx ON enrollment_codes (facility_id, created_on);
