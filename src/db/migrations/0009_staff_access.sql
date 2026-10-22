-- Existing single-role staff keep their identity, primary role and access.
ALTER TABLE staff ADD COLUMN additional_roles jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE staff ADD COLUMN additional_permissions jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE staff ADD CONSTRAINT staff_additional_roles_check CHECK (
  jsonb_typeof(additional_roles) = 'array'
  AND additional_roles <@ '["chew","nurse","doctor","records_officer","facility_admin","supervisor","cashier"]'::jsonb
);
ALTER TABLE staff ADD CONSTRAINT staff_additional_permissions_check CHECK (
  jsonb_typeof(additional_permissions) = 'array'
  AND additional_permissions <@ '["patient:create","patient:update","appointment:create","visit:create","encounter:record","handoff:create","handoff:update","referral:create","referral:update","register_entry:create","stock_movement:create","charge:create","payment:receive","payment:waive","payment:reverse","register_definition:publish","unit:manage","stock_item:manage","fee_item:manage","staff:manage","staff:permission","staff:deactivate","roster:assign","roster:extend","device:enroll","device:revoke","sync_rejection:resolve"]'::jsonb
);
