-- Missing/NULL access retains the existing shift-based login rule.
ALTER TABLE staff ADD COLUMN login_access text;
ALTER TABLE staff ADD CONSTRAINT staff_login_access_check
  CHECK (login_access IN ('shift', 'always'));
