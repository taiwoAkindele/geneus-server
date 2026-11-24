-- One PIN per person on a device (SCHEMA.md §10): switching to another facility
-- of the organization registers the PIN the person already uses on this device
-- for their membership there, when they have none. Recorded as its own source.

ALTER TABLE staff_device_pins DROP CONSTRAINT staff_device_pins_enrolled_by_check;
ALTER TABLE staff_device_pins ADD CONSTRAINT staff_device_pins_enrolled_by_check
  CHECK (enrolled_by IN ('setup_code', 'email', 'invitation', 'password', 'facility_switch'));
