-- Billing 2A/2B only. Existing financial records and legacy associations remain intact.
-- Retain prior writers while accepting the new global envelope on unchanged operational shapes.
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['locations','service_definitions','service_offerings','practitioner_profiles',
 'credentials','capability_decisions','reviewer_delegations','clinical_authority_bootstraps',
 'external_clinical_reviewers','authority_snapshots','staff_assignments','service_sessions',
 'session_events','work_ownership_events','appointment_reservations'] LOOP
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',table_name,table_name||'_schema_version_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK(schema_version BETWEEN 4 AND 6)',table_name,table_name||'_schema_version_check');
 END LOOP;
END $$;
ALTER TABLE fee_items DROP CONSTRAINT fee_items_category_check;
ALTER TABLE fee_items ADD CONSTRAINT fee_items_category_check CHECK(category IN
 ('registration','card','consultation','laboratory','procedure','other','pharmacy','maternity','admission','imaging'));
ALTER TABLE charges DROP CONSTRAINT charges_category_check;
ALTER TABLE charges ADD CONSTRAINT charges_category_check CHECK(category IN
 ('registration','card','consultation','laboratory','procedure','other','pharmacy','maternity','admission','imaging'));
ALTER TABLE facilities ADD COLUMN billing_catalogue_version integer CHECK(billing_catalogue_version=1);
ALTER TABLE workforce_client_versions ADD COLUMN billing_catalogue_version integer CHECK(billing_catalogue_version=1);
ALTER TABLE workforce_client_versions ADD COLUMN legacy_billing_token_expires_on timestamptz;
ALTER TABLE fee_items ADD COLUMN price_evidence_version integer CHECK(price_evidence_version=1);
ALTER TABLE fee_price_versions ADD COLUMN category text;
ALTER TABLE fee_price_versions ADD COLUMN exemptions jsonb;
ALTER TABLE fee_price_versions ADD CONSTRAINT fee_version_facility_item UNIQUE(facility_id,fee_item_id,id);
CREATE OR REPLACE FUNCTION remember_fee_price() RETURNS trigger AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.category IS DISTINCT FROM OLD.category OR NEW.exemptions IS DISTINCT FROM OLD.exemptions OR NEW.price_version IS NULL THEN
   NEW.price_version := 'fee_price:' || md5(random()::text || clock_timestamp()::text);
   INSERT INTO fee_price_versions(id,facility_id,fee_item_id,amount_minor,currency,category,exemptions)
    VALUES(NEW.price_version,NEW.facility_id,NEW.id,NEW.amount_minor,NEW.currency,NEW.category,NEW.exemptions);
 END IF;
 NEW.price_evidence_version := 1;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- Fresh current heads, not guessed edits to immutable old versions. Prices/policies/IDs do not change.
UPDATE fee_items SET price_version=NULL;
ALTER TABLE charges ADD COLUMN fee_price_version text;
ALTER TABLE charges ADD COLUMN quantity numeric CHECK(quantity>0 AND quantity<=1000000);
ALTER TABLE charges ADD COLUMN unit_price_minor bigint CHECK(unit_price_minor>=0);
ALTER TABLE charges ADD COLUMN unit_of_measure text CHECK(btrim(unit_of_measure)<>'');
ALTER TABLE charges ADD COLUMN service_point_id text;
ALTER TABLE charges ADD CONSTRAINT charge_fee_version_ref FOREIGN KEY(facility_id,fee_item_id,fee_price_version)
 REFERENCES fee_price_versions(facility_id,fee_item_id,id);
ALTER TABLE charges ADD CONSTRAINT charge_price_evidence CHECK
 ((fee_price_version IS NULL AND quantity IS NULL AND unit_price_minor IS NULL)
 OR (fee_price_version IS NOT NULL AND quantity IS NOT NULL AND unit_price_minor IS NOT NULL));
-- Totals use the existing shared Math.round quantity calculation at the write boundary.
-- PostgreSQL numeric rounding differs for some valid fractional quantities (100 * 0.145).
ALTER TABLE charges ADD FOREIGN KEY(facility_id,service_point_id) REFERENCES locations(facility_id,id);
ALTER TABLE service_definitions ADD COLUMN fee_item_id text;
ALTER TABLE service_definitions ADD FOREIGN KEY(facility_id,fee_item_id) REFERENCES fee_items(facility_id,id);
CREATE INDEX billing_catalogue_category_name ON fee_items(facility_id,category,name) WHERE active;
