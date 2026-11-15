-- Invitation links (SCHEMA.md §10). An invitation email now leads with an
-- "Accept invitation" link; the PIN setup code stays in the email as a fallback.
--
-- The link carries a random 256-bit token in its URL fragment, so it never
-- reaches a server log or another site. Only its SHA-256 is stored: a token that
-- long cannot be guessed, so a slow hash adds nothing. The token proves only that
-- its holder read the invitation email. It is never a device credential, a PIN or
-- a session.
--
-- On a device already enrolled at the facility, the link is exchanged for a
-- fresh one-time PIN setup code (it replaces the stored code hash), and the
-- existing PIN enrolment accepts the invitation as before.
--
-- A new device is enrolled from the link only when the administrator who sent
-- it chose to allow one, and held `device:enroll` to do so. The allowance covers
-- one device, expires with the invitation and is spent by enrolling. Like any
-- other enrollment, it is recorded as a claimed row in enrollment_codes.
ALTER TABLE staff_invitations
  ADD COLUMN link_hash          text,
  ADD COLUMN allows_new_device  boolean NOT NULL DEFAULT false,
  ADD COLUMN device_enrolled_on timestamptz,
  ADD COLUMN device_enrolled_id text REFERENCES devices(id),
  ADD CONSTRAINT staff_invitations_device_allowed CHECK (device_enrolled_on IS NULL OR allows_new_device),
  ADD CONSTRAINT staff_invitations_device_complete CHECK ((device_enrolled_on IS NULL) = (device_enrolled_id IS NULL));

CREATE UNIQUE INDEX staff_invitations_link ON staff_invitations (link_hash) WHERE link_hash IS NOT NULL;
