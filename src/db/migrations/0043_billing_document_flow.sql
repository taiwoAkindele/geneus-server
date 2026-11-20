-- Presentation metadata only. Existing financial records are not rewritten.
ALTER TABLE charges ADD COLUMN bill_id text CHECK(bill_id IS NULL OR bill_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$');
CREATE INDEX charge_manual_bill ON charges(facility_id,bill_id) WHERE bill_id IS NOT NULL;
ALTER TABLE fee_items ADD COLUMN description text CHECK(description IS NULL OR length(description)<=1000);
