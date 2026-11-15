-- Staff invitations (SCHEMA.md §10). An invitation is a PIN setup code that is
-- delivered to a contact the administrator entered, instead of being read
-- aloud. It is accepted only online, through POST /staff/session/enrol, where
-- the server checks expiry, revocation, the person and the facility before it
-- registers a PIN. So, unlike a code read aloud, it never syncs to a device:
-- it lives here, with only a slow hash of the code, outside the `powersync`
-- publication.
--
-- Redeeming it proves possession of that contact — the address it was sent to
-- becomes the person's verified email — and nothing more: not who they are in
-- the real world, and no permission at any facility.
--
-- One row per code sent: a resend revokes the earlier row and adds a new one,
-- so the rows are the invitation history and what rate limits count.
CREATE TABLE staff_invitations (
  id                     text PRIMARY KEY,
  facility_id            text NOT NULL REFERENCES facilities(id),
  staff_id               text NOT NULL,
  channel                text NOT NULL CHECK (channel IN ('email')),
  destination            text NOT NULL CHECK (btrim(destination) <> ''),   -- trimmed, lower-case
  code_hash              text NOT NULL,
  code_salt              text NOT NULL,
  code_iterations        integer NOT NULL CHECK (code_iterations >= 100000),
  failed_attempts        integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  created_by             text NOT NULL,
  created_from           text NOT NULL REFERENCES devices(id),
  created_on             timestamptz NOT NULL DEFAULT now(),
  expires_on             timestamptz NOT NULL,
  -- 'provider_accepted' means the email provider took the message, not that it
  -- arrived; 'not_configured' means a development server wrote it to its log.
  delivery_status        text NOT NULL DEFAULT 'sending'
                           CHECK (delivery_status IN ('sending', 'provider_accepted', 'provider_rejected', 'not_configured')),
  provider_message_id    text,
  delivery_error         text,
  delivery_attempted_on  timestamptz,
  accepted_on            timestamptz,
  accepted_on_device     text REFERENCES devices(id),
  revoked_on             timestamptz,
  revoked_by             text,
  revoked_reason         text CHECK (revoked_reason IN ('resent', 'revoked', 'pin_code_issued')),
  FOREIGN KEY (facility_id, staff_id) REFERENCES staff (facility_id, id),
  FOREIGN KEY (facility_id, created_by) REFERENCES staff (facility_id, id),
  CHECK (accepted_on IS NULL OR revoked_on IS NULL),
  CHECK ((accepted_on IS NULL) = (accepted_on_device IS NULL)),
  CHECK ((revoked_on IS NULL) = (revoked_reason IS NULL))
);
-- At most one code waiting per person.
CREATE UNIQUE INDEX staff_invitations_open ON staff_invitations (facility_id, staff_id) WHERE accepted_on IS NULL AND revoked_on IS NULL;
CREATE INDEX staff_invitations_by_staff ON staff_invitations (facility_id, staff_id, created_on);
CREATE INDEX staff_invitations_by_facility ON staff_invitations (facility_id, created_on);

-- A PIN registered by accepting an invitation says so.
ALTER TABLE staff_device_pins DROP CONSTRAINT staff_device_pins_enrolled_by_check;
ALTER TABLE staff_device_pins ADD CONSTRAINT staff_device_pins_enrolled_by_check CHECK (enrolled_by IN ('setup_code', 'email', 'invitation'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'powersync') THEN
    REVOKE ALL ON staff_invitations FROM powersync;
  END IF;
END $$;
