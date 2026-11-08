-- Explicit supplies reuse signed encounter entries; companion records are atomic on upload.
ALTER TABLE encounter_entries ADD COLUMN pharmacy_version integer CHECK (pharmacy_version IS NULL OR pharmacy_version = 1);
ALTER TABLE encounter_entries ADD CONSTRAINT pharmacy_entry_patient_ref UNIQUE(facility_id,id,patient_id);
ALTER TABLE encounter_entries ADD CONSTRAINT pharmacy_entry_facility_ref UNIQUE(facility_id,id);
ALTER TABLE stock_items ADD COLUMN fee_item_id text;
ALTER TABLE stock_items ADD CONSTRAINT stock_fee_ref FOREIGN KEY(facility_id,fee_item_id) REFERENCES fee_items(facility_id,id);
ALTER TABLE stock_movements ADD COLUMN dispense_entry_id text;
ALTER TABLE charges ADD COLUMN dispense_entry_id text;
ALTER TABLE billing_adjustments ADD COLUMN dispense_entry_id text;
ALTER TABLE stock_movements ADD CONSTRAINT stock_dispense_ref FOREIGN KEY(facility_id,dispense_entry_id) REFERENCES encounter_entries(facility_id,id);
ALTER TABLE charges ADD CONSTRAINT charge_dispense_ref FOREIGN KEY(facility_id,dispense_entry_id,patient_id) REFERENCES encounter_entries(facility_id,id,patient_id);
ALTER TABLE billing_adjustments ADD CONSTRAINT credit_dispense_ref FOREIGN KEY(facility_id,dispense_entry_id,patient_id) REFERENCES encounter_entries(facility_id,id,patient_id);
CREATE UNIQUE INDEX pharmacy_line_first ON encounter_entries(facility_id, (values->'supply'->>'prescriptionEntryId'), (values->'supply'->>'lineId')) WHERE pharmacy_version=1 AND values->'supply'->>'previousEntryId' IS NULL;
CREATE UNIQUE INDEX pharmacy_line_next ON encounter_entries(facility_id, (values->'supply'->>'previousEntryId')) WHERE pharmacy_version=1 AND values->'supply'->>'previousEntryId' IS NOT NULL;
CREATE UNIQUE INDEX pharmacy_price_once ON encounter_entries(facility_id, (values->'supply'->>'priceFor')) WHERE pharmacy_version=1 AND values->'supply'->>'priceFor' IS NOT NULL;
CREATE UNIQUE INDEX pharmacy_stock_once ON stock_movements(facility_id,dispense_entry_id) WHERE dispense_entry_id IS NOT NULL;
CREATE UNIQUE INDEX pharmacy_charge_once ON charges(facility_id,dispense_entry_id) WHERE dispense_entry_id IS NOT NULL;
CREATE UNIQUE INDEX pharmacy_credit_once ON billing_adjustments(facility_id,dispense_entry_id) WHERE dispense_entry_id IS NOT NULL;
