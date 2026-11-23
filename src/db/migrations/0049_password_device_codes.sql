-- Two more emailed 6-digit codes (SCHEMA.md §10):
-- `staff_account`: proves a person accepting an invitation already owns the
--   password of that email (subject = the invitation id), so it is never replaced;
-- `device_sign_in`: confirms a new device after the right password
--   (subject = email and the device id the device chose).

ALTER TABLE email_verifications DROP CONSTRAINT email_verifications_purpose_check;
ALTER TABLE email_verifications ADD CONSTRAINT email_verifications_purpose_check
  CHECK (purpose IN (
    'registration', 'staff_email', 'staff_email_current', 'workforce_access', 'operator_login',
    'staff_password', 'staff_account', 'device_sign_in'
  ));
