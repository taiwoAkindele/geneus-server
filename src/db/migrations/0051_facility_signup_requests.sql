-- Facility sign-up ("Create an account"), replacing invite codes minted by a script.
--
--   facility_signup_requests      — someone with a proven email asks Geneus for a
--                                   facility. A Geneus operator approves or rejects
--                                   it; an approval mints the single-use invite that
--                                   the emailed registration link carries.
--   facility_signup_review_links  — one link per operator per request, sent to that
--                                   operator's address, so a decision made from the
--                                   email is still recorded against a named operator.
--                                   Only a hash of each link's token is kept.
--
-- Both are server-only: never synced. An invite minted by the old script has no
-- request behind it and can no longer register a facility.

CREATE TABLE facility_signup_requests (
  id              text PRIMARY KEY,
  code            text NOT NULL,
  name            text NOT NULL CHECK (btrim(name) <> ''),
  state           text NOT NULL CHECK (btrim(state) <> ''),
  lga             text NOT NULL CHECK (btrim(lga) <> ''),
  level           text NOT NULL,
  admin_full_name text NOT NULL CHECK (btrim(admin_full_name) <> ''),
  email           text NOT NULL CHECK (email = lower(email)),
  requested_on    timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'requested'
                  CHECK (status IN ('requested', 'approved', 'rejected')),
  decided_by      text REFERENCES platform_operators(id),
  decided_on      timestamptz,
  decision_note   text,
  -- The invite an approval mints; registering claims it.
  invite_token    text UNIQUE REFERENCES facility_invites(token),
  -- Whether the email telling the requester the decision went out.
  requester_email text CHECK (requester_email IN ('sent', 'failed', 'not_configured')),
  CHECK ((status = 'requested') = (decided_on IS NULL)),
  CHECK ((status = 'requested') = (decided_by IS NULL)),
  CHECK (status <> 'approved' OR invite_token IS NOT NULL),
  CHECK (status <> 'rejected' OR btrim(coalesce(decision_note, '')) <> '')
);

-- One open request per email: asking again while one waits is refused, not queued.
CREATE UNIQUE INDEX facility_signup_requests_open ON facility_signup_requests (email)
  WHERE status = 'requested';

CREATE TABLE facility_signup_review_links (
  token_hash  text PRIMARY KEY,
  request_id  text NOT NULL REFERENCES facility_signup_requests(id),
  operator_id text NOT NULL REFERENCES platform_operators(id),
  created_on  timestamptz NOT NULL DEFAULT now(),
  expires_on  timestamptz NOT NULL,
  UNIQUE (request_id, operator_id)
);

-- The first admin chooses their password when registering the facility.
ALTER TABLE staff_passwords DROP CONSTRAINT staff_passwords_set_by_check;
ALTER TABLE staff_passwords ADD CONSTRAINT staff_passwords_set_by_check
  CHECK (set_by IN ('invitation', 'reset', 'change', 'registration'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'powersync') THEN
    REVOKE ALL ON facility_signup_requests, facility_signup_review_links FROM powersync;
  END IF;
END $$;
