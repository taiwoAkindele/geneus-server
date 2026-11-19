-- One integrated billing release. Existing money, prices, contracts and account history stand.
ALTER TABLE billing_receiving_accounts ADD CONSTRAINT receiving_account_facility_id UNIQUE(facility_id,id);
ALTER TABLE billing_connections ADD COLUMN receiving_account_id text;
ALTER TABLE billing_connections ADD FOREIGN KEY(facility_id,receiving_account_id) REFERENCES billing_receiving_accounts(facility_id,id);
-- Keep legacy accounts/history. Current credentials may belong to a different provider business:
-- an administrator explicitly re-verifies the general account before selecting it.
ALTER TABLE insurance_remittances ADD COLUMN incoming_transfer_id text;
ALTER TABLE insurance_remittances ADD FOREIGN KEY(facility_id,incoming_transfer_id) REFERENCES incoming_transfers(facility_id,id);
CREATE INDEX insurance_remittance_source ON insurance_remittances(facility_id,incoming_transfer_id);

-- No guessed source relationships and no money/history updates.
CREATE TABLE service_charge_allocations (
 id text PRIMARY KEY,facility_id text NOT NULL REFERENCES facilities(id),
 schema_version integer NOT NULL CHECK(schema_version>=7),created_by text NOT NULL,created_on timestamptz NOT NULL,
 device_id text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,updated_by text,updated_on timestamptz,
 patient_id text NOT NULL,charge_id text NOT NULL,source_kind text NOT NULL CHECK(source_kind IN ('laboratory','pharmacy')),
 source_entry_id text NOT NULL,source_item_id text NOT NULL,
 action text NOT NULL CHECK(action IN ('allocate','release')),quantity numeric NOT NULL CHECK(quantity>0 AND quantity<=1000000),
 unit text NOT NULL CHECK(btrim(unit)<>''),reason text NOT NULL CHECK(length(btrim(reason))>=3),
 reverses_id text,return_entry_id text,credit_returned_units boolean NOT NULL DEFAULT false,
 accepted_on timestamptz NOT NULL,credit_minor integer CHECK(credit_minor>=0),
 UNIQUE(facility_id,id),
 FOREIGN KEY(facility_id,charge_id,patient_id) REFERENCES charges(facility_id,id,patient_id),
 FOREIGN KEY(facility_id,source_entry_id) REFERENCES encounter_entries(facility_id,id),
 FOREIGN KEY(facility_id,reverses_id) REFERENCES service_charge_allocations(facility_id,id),
 FOREIGN KEY(facility_id,return_entry_id) REFERENCES encounter_entries(facility_id,id),
 CHECK((action='release')=(reverses_id IS NOT NULL)),
 CHECK(NOT credit_returned_units OR (action='release' AND return_entry_id IS NOT NULL))
);
CREATE INDEX service_allocation_charge ON service_charge_allocations(facility_id,charge_id);
CREATE INDEX service_allocation_source ON service_charge_allocations(facility_id,source_entry_id,source_item_id);
CREATE TRIGGER service_allocations_insert_only BEFORE UPDATE OR DELETE ON service_charge_allocations FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
ALTER PUBLICATION powersync ADD TABLE service_charge_allocations;
ALTER TABLE facilities ADD COLUMN integrated_billing_version integer CHECK(integrated_billing_version=1);
ALTER TABLE workforce_client_versions ADD COLUMN integrated_billing_version integer CHECK(integrated_billing_version=1);
ALTER TABLE workforce_client_versions ADD COLUMN legacy_integrated_token_expires_on timestamptz;
DO $$ DECLARE tab text; expression text; BEGIN
 FOREACH tab IN ARRAY ARRAY['locations','service_definitions','service_offerings','practitioner_profiles',
 'credentials','capability_decisions','reviewer_delegations','clinical_authority_bootstraps',
 'external_clinical_reviewers','authority_snapshots','staff_assignments','service_sessions',
 'session_events','work_ownership_events','appointment_reservations'] LOOP
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',tab,tab||'_schema_version_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK(schema_version BETWEEN 4 AND 7)',tab,tab||'_schema_version_check');
 END LOOP;
 SELECT pg_get_constraintdef(oid) INTO expression FROM pg_constraint WHERE conrelid='staff'::regclass AND conname='staff_additional_permissions_check';
 ALTER TABLE staff DROP CONSTRAINT staff_additional_permissions_check;
 EXECUTE 'ALTER TABLE staff ADD CONSTRAINT staff_additional_permissions_check '||replace(expression,'additional_permissions <@', '(additional_permissions - ''charge:associate'') <@');
END $$;

ALTER TABLE coverage_allocation_details ADD COLUMN return_adjustment_minor integer NOT NULL DEFAULT 0 CHECK(return_adjustment_minor>=0);
ALTER TABLE coverage_allocation_details DROP CONSTRAINT allocation_balances;
ALTER TABLE coverage_allocation_details ADD CONSTRAINT allocation_balances CHECK(patient_share_minor+payer_share_minor+contract_adjustment_minor+capitation_covered_minor+return_adjustment_minor=list_price_minor);

-- Public patient amounts copied from the existing immutable allocation; no terms.
CREATE TABLE coverage_financial_summaries (
 id text PRIMARY KEY,facility_id text NOT NULL REFERENCES facilities(id),schema_version integer NOT NULL DEFAULT 7,
 created_by text NOT NULL,created_on timestamptz NOT NULL,device_id text NOT NULL REFERENCES devices(id),updated_by text,updated_on timestamptz,
 allocation_id text NOT NULL,patient_id text NOT NULL,charge_id text NOT NULL,currency text NOT NULL,
 list_price_minor integer NOT NULL,patient_share_minor integer NOT NULL,payer_share_minor integer NOT NULL,
 contract_adjustment_minor integer NOT NULL,capitation_covered_minor integer NOT NULL,return_adjustment_minor integer NOT NULL DEFAULT 0,
 FOREIGN KEY(facility_id,allocation_id) REFERENCES coverage_allocations(facility_id,id),
 CHECK(list_price_minor=patient_share_minor+payer_share_minor+contract_adjustment_minor+capitation_covered_minor+return_adjustment_minor),UNIQUE(facility_id,allocation_id)
);
INSERT INTO coverage_financial_summaries(id,facility_id,created_by,created_on,device_id,allocation_id,patient_id,charge_id,currency,
 list_price_minor,patient_share_minor,payer_share_minor,contract_adjustment_minor,capitation_covered_minor,return_adjustment_minor)
 SELECT 'coverage_summary:'||a.id,a.facility_id,a.created_by,a.created_on,a.device_id,a.id,a.patient_id,a.charge_id,a.currency,
 d.list_price_minor,d.patient_share_minor,d.payer_share_minor,d.contract_adjustment_minor,d.capitation_covered_minor,d.return_adjustment_minor
 FROM coverage_allocations a JOIN coverage_allocation_details d ON d.allocation_id=a.id AND d.facility_id=a.facility_id;
CREATE FUNCTION publish_coverage_financial_summary() RETURNS trigger AS $$ BEGIN
 INSERT INTO coverage_financial_summaries(id,facility_id,created_by,created_on,device_id,allocation_id,patient_id,charge_id,currency,
 list_price_minor,patient_share_minor,payer_share_minor,contract_adjustment_minor,capitation_covered_minor,return_adjustment_minor)
 SELECT 'coverage_summary:'||a.id,a.facility_id,a.created_by,a.created_on,a.device_id,a.id,a.patient_id,a.charge_id,a.currency,
 NEW.list_price_minor,NEW.patient_share_minor,NEW.payer_share_minor,NEW.contract_adjustment_minor,NEW.capitation_covered_minor,NEW.return_adjustment_minor
 FROM coverage_allocations a WHERE a.id=NEW.allocation_id AND a.facility_id=NEW.facility_id;RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER coverage_financial_summary_publish AFTER INSERT ON coverage_allocation_details FOR EACH ROW EXECUTE FUNCTION publish_coverage_financial_summary();
CREATE TRIGGER coverage_financial_summaries_insert_only BEFORE UPDATE OR DELETE ON coverage_financial_summaries FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
ALTER PUBLICATION powersync ADD TABLE coverage_financial_summaries;
-- Legacy line membership had no event clock. This is first-observed time, not a guessed service date.
ALTER TABLE insurance_claim_lines ADD COLUMN statement_recorded_on timestamptz NOT NULL DEFAULT now();
CREATE OR REPLACE FUNCTION insurance_claim_line_retire_only() RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'claim lines are permanent';END IF;
 IF NOT(OLD.current AND NOT NEW.current) OR
 (NEW.id,NEW.facility_id,NEW.claim_id,NEW.charge_id,NEW.allocation_id,NEW.contract_version_id,NEW.statement_recorded_on)
 IS DISTINCT FROM
 (OLD.id,OLD.facility_id,OLD.claim_id,OLD.charge_id,OLD.allocation_id,OLD.contract_version_id,OLD.statement_recorded_on)
 THEN RAISE EXCEPTION 'a claim line is only ever retired by a revision';END IF;
 RETURN NEW;
END $$ LANGUAGE plpgsql;
