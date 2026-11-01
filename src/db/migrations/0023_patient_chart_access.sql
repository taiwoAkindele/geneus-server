-- Read access can be assigned independently of clinical writing and front-desk duties.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid = 'staff'::regclass AND conname = 'staff_additional_permissions_check';
  IF definition IS NULL THEN RAISE EXCEPTION 'Expected staff permission constraint'; END IF;
  ALTER TABLE staff DROP CONSTRAINT staff_additional_permissions_check;
  EXECUTE 'ALTER TABLE staff ADD CONSTRAINT staff_additional_permissions_check ' ||
    replace(definition, '"patient:update"', '"patient:update", "patient_chart:read"');
END $$;
