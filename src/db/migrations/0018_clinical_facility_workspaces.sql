-- Organization ownership never changes the facility boundary of operational tables.
CREATE TABLE organizations (
  id text PRIMARY KEY, name text NOT NULL, created_on timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE organization_facilities (
  facility_id text PRIMARY KEY REFERENCES facilities(id), organization_id text NOT NULL REFERENCES organizations(id),
  joined_by text NOT NULL, joined_on timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (facility_id, joined_by) REFERENCES staff(facility_id, id)
);
CREATE TABLE organization_invitations (
  code_hash text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
  issued_from text NOT NULL REFERENCES facilities(id), issued_by text NOT NULL,
  expires_on timestamptz NOT NULL, claimed_by text REFERENCES facilities(id), claimed_on timestamptz,
  FOREIGN KEY (issued_from, issued_by) REFERENCES staff(facility_id, id)
);
ALTER TABLE staff ADD COLUMN person_id text;
CREATE UNIQUE INDEX staff_person_membership ON staff(facility_id, person_id) WHERE person_id IS NOT NULL;
CREATE TABLE staff_provision_requests (
  id text PRIMARY KEY, from_facility_id text NOT NULL REFERENCES facilities(id),
  to_facility_id text NOT NULL REFERENCES facilities(id), source_staff_id text NOT NULL,
  person_id text NOT NULL, full_name text NOT NULL, requested_by text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  local_staff_id text, decided_by text, created_on timestamptz NOT NULL DEFAULT now(), decided_on timestamptz,
  CHECK (from_facility_id <> to_facility_id),
  FOREIGN KEY (from_facility_id, source_staff_id) REFERENCES staff(facility_id, id),
  FOREIGN KEY (from_facility_id, requested_by) REFERENCES staff(facility_id, id),
  FOREIGN KEY (to_facility_id, local_staff_id) REFERENCES staff(facility_id, id),
  FOREIGN KEY (to_facility_id, decided_by) REFERENCES staff(facility_id, id)
);
CREATE UNIQUE INDEX staff_provision_pending ON staff_provision_requests(from_facility_id, to_facility_id, source_staff_id) WHERE status='pending';

ALTER TABLE facilities ADD COLUMN allow_custom_investigations boolean;
ALTER TABLE fee_items ADD COLUMN price_version text;
CREATE TABLE fee_price_versions (
  id text PRIMARY KEY, facility_id text NOT NULL, fee_item_id text NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor >= 0), currency text NOT NULL,
  recorded_on timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(facility_id,fee_item_id) REFERENCES fee_items(facility_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE FUNCTION remember_fee_price() RETURNS trigger AS $$
BEGIN
  IF TG_OP='INSERT' OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.price_version IS NULL THEN
    NEW.price_version := 'fee_price:' || md5(random()::text || clock_timestamp()::text);
    INSERT INTO fee_price_versions(id,facility_id,fee_item_id,amount_minor,currency)
      VALUES(NEW.price_version,NEW.facility_id,NEW.id,NEW.amount_minor,NEW.currency);
  ELSE
    NEW.price_version := OLD.price_version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER fee_price_history BEFORE INSERT OR UPDATE ON fee_items FOR EACH ROW EXECUTE FUNCTION remember_fee_price();
UPDATE fee_items SET price_version=NULL;
CREATE TRIGGER fee_prices_immutable BEFORE UPDATE OR DELETE ON fee_price_versions FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
ALTER TABLE service_definitions ADD COLUMN investigation jsonb;
ALTER TABLE service_offerings ADD COLUMN fee_item_id text;
ALTER TABLE service_offerings ADD FOREIGN KEY (facility_id, fee_item_id) REFERENCES fee_items(facility_id, id);
CREATE TABLE service_definition_versions (
  facility_id text NOT NULL, source_id text NOT NULL, revision integer NOT NULL, snapshot jsonb NOT NULL,
  PRIMARY KEY(facility_id,source_id,revision), FOREIGN KEY(facility_id,source_id) REFERENCES service_definitions(facility_id,id)
);
CREATE TABLE service_offering_versions (
  facility_id text NOT NULL, source_id text NOT NULL, revision integer NOT NULL, snapshot jsonb NOT NULL,
  PRIMARY KEY(facility_id,source_id,revision), FOREIGN KEY(facility_id,source_id) REFERENCES service_offerings(facility_id,id)
);
INSERT INTO service_definition_versions SELECT facility_id,id,revision,to_jsonb(d) FROM service_definitions d;
INSERT INTO service_offering_versions SELECT facility_id,id,revision,to_jsonb(o) FROM service_offerings o;
CREATE FUNCTION remember_service_definition() RETURNS trigger AS $$
BEGIN
  INSERT INTO service_definition_versions VALUES(NEW.facility_id,NEW.id,NEW.revision,to_jsonb(NEW)) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE FUNCTION remember_service_offering() RETURNS trigger AS $$
BEGIN
  INSERT INTO service_offering_versions VALUES(NEW.facility_id,NEW.id,NEW.revision,to_jsonb(NEW)) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER service_definition_history AFTER INSERT OR UPDATE ON service_definitions FOR EACH ROW EXECUTE FUNCTION remember_service_definition();
CREATE TRIGGER service_offering_history AFTER INSERT OR UPDATE ON service_offerings FOR EACH ROW EXECUTE FUNCTION remember_service_offering();
CREATE TRIGGER definition_versions_immutable BEFORE UPDATE OR DELETE ON service_definition_versions FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
CREATE TRIGGER offering_versions_immutable BEFORE UPDATE OR DELETE ON service_offering_versions FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
ALTER TABLE charges ADD COLUMN order_item_id text, ADD COLUMN order_entry_id text;
ALTER TABLE charges ADD FOREIGN KEY (facility_id, encounter_id, order_entry_id) REFERENCES encounter_entries(facility_id, encounter_id, id);
ALTER TABLE charges ADD CONSTRAINT charges_order_source CHECK ((order_item_id IS NULL) = (order_entry_id IS NULL));
CREATE UNIQUE INDEX charges_order_item ON charges(facility_id, order_item_id) WHERE order_item_id IS NOT NULL;
ALTER TABLE encounters ADD COLUMN workflow_version integer CHECK(workflow_version=1);
ALTER TABLE encounter_entries ADD COLUMN workflow_version integer CHECK(workflow_version=1);
ALTER TABLE encounter_entries DROP CONSTRAINT encounter_entries_step_check;
ALTER TABLE encounter_entries ADD CONSTRAINT encounter_entries_step_check CHECK (step IN (
  'vitals','complaint','lab_order','lab_results','diagnosis','injection','dispense','admission','follow_up','amendment',
  'investigation_review','result_review','prescription','injection_order','disposition'
));
CREATE UNIQUE INDEX encounter_disposition_successor ON encounter_entries(facility_id, ("values"->>'previousEntryId'))
  WHERE step='disposition' AND "values" ? 'previousEntryId';
CREATE UNIQUE INDEX encounter_disposition_root ON encounter_entries(facility_id, encounter_id)
  WHERE step='disposition' AND NOT ("values" ? 'previousEntryId');

-- The inbound handover has no foreign key to the sender's patient in this facility.
CREATE TABLE inbound_referrals (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  schema_version integer NOT NULL, created_by text NOT NULL, created_on timestamptz NOT NULL,
  device_id text NOT NULL, updated_by text, updated_on timestamptz,
  source_referral_id text NOT NULL REFERENCES referrals(id), from_facility_id text NOT NULL REFERENCES facilities(id),
  sender_patient_id text NOT NULL, tier1 jsonb NOT NULL, sent_on timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','arrived','closed')),
  local_patient_id text, local_encounter_id text, arrived_on timestamptz, closed_on timestamptz,
  UNIQUE(facility_id,id), UNIQUE(facility_id,source_referral_id),
  FOREIGN KEY(facility_id,device_id) REFERENCES devices(facility_id,id),
  FOREIGN KEY(facility_id,local_patient_id) REFERENCES patients(facility_id,id),
  FOREIGN KEY(facility_id,local_encounter_id,local_patient_id) REFERENCES encounters(facility_id,id,patient_id),
  CHECK (facility_id <> from_facility_id),
  CHECK (local_encounter_id IS NULL OR local_patient_id IS NOT NULL),
  CHECK (status='received' OR (local_patient_id IS NOT NULL AND arrived_on IS NOT NULL)),
  CHECK (status <> 'closed' OR closed_on IS NOT NULL)
);
ALTER PUBLICATION powersync ADD TABLE inbound_referrals;
