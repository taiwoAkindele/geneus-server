-- Billing (SCHEMA.md §14, PRD §9.13). A facility's fee schedule, the fees
-- raised against patients, and the payments that settle them. Charges and
-- payments are held to the same rule as encounter entries: never changed once
-- saved, so a mistake is a reversing payment, not an edit. Nothing here stores
-- whether something is paid — balances are worked out from these rows.
--
-- Amounts are whole minor units (kobo for NGN) in `integer`, which comes back
-- from postgres.js as a number; the largest single charge or payment a
-- facility takes is far below its 2,147,483,647 ceiling.

-- The cashier role (PRD §9.13.4). The role checks were declared inline in
-- 0001 and 0006, so these are PostgreSQL's own names for them.
ALTER TABLE staff DROP CONSTRAINT staff_role_check;
ALTER TABLE staff ADD CONSTRAINT staff_role_check
  CHECK (role IN ('chew', 'nurse', 'doctor', 'records_officer', 'facility_admin', 'supervisor', 'cashier'));
ALTER TABLE encounter_entries DROP CONSTRAINT encounter_entries_actor_role_check;
ALTER TABLE encounter_entries ADD CONSTRAINT encounter_entries_actor_role_check
  CHECK (actor_role IN ('chew', 'nurse', 'doctor', 'records_officer', 'facility_admin', 'supervisor', 'cashier'));

-- What the visit is for, chosen at booking; exemption rules are written against it.
ALTER TABLE appointments ADD COLUMN visit_type text CHECK (visit_type IN (
  'general', 'follow_up', 'antenatal', 'postnatal', 'delivery', 'immunisation',
  'family_planning', 'child_welfare', 'tb_programme', 'hiv_programme', 'emergency'));
-- Lets an encounter or a charge name an appointment *of the same patient*.
ALTER TABLE appointments ADD CONSTRAINT appointments_facility_id_patient_key UNIQUE (facility_id, id, patient_id);

-- The appointment an encounter was booked as, and why it went ahead unpaid
-- (PRD §9.13.5). Adding columns is not an UPDATE, so the insert-only trigger
-- on encounters is untouched.
ALTER TABLE encounters ADD COLUMN appointment_id text;
ALTER TABLE encounters ADD COLUMN collect_later_reason text CHECK (btrim(collect_later_reason) <> '');
ALTER TABLE encounters
  ADD FOREIGN KEY (facility_id, appointment_id, patient_id) REFERENCES appointments (facility_id, id, patient_id);

CREATE TABLE fee_items (
  id              text PRIMARY KEY,
  facility_id     text NOT NULL REFERENCES facilities(id),
  schema_version  integer NOT NULL CHECK (schema_version > 0),
  created_by      text NOT NULL,
  created_on      timestamptz NOT NULL,
  device_id       text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by      text,
  updated_on      timestamptz,
  name            text NOT NULL CHECK (btrim(name) <> ''),
  category        text NOT NULL CHECK (category IN ('registration', 'card', 'consultation', 'laboratory', 'procedure', 'other')),
  amount_minor    integer NOT NULL CHECK (amount_minor >= 0),
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  charge_when     text NOT NULL CHECK (charge_when IN ('first_visit', 'every_visit', 'when_ordered')),
  exemptions      jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(exemptions) = 'array'),
  active          boolean NOT NULL DEFAULT true,
  UNIQUE (facility_id, id)
);

CREATE TABLE charges (
  id                text PRIMARY KEY,
  facility_id       text NOT NULL REFERENCES facilities(id),
  schema_version    integer NOT NULL CHECK (schema_version > 0),
  created_by        text NOT NULL,
  created_on        timestamptz NOT NULL,
  device_id         text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by        text,
  updated_on        timestamptz,
  patient_id        text NOT NULL,
  fee_item_id       text NOT NULL,
  description       text NOT NULL CHECK (btrim(description) <> ''),
  category          text NOT NULL CHECK (category IN ('registration', 'card', 'consultation', 'laboratory', 'procedure', 'other')),
  list_price_minor  integer NOT NULL CHECK (list_price_minor >= 0),
  amount_minor      integer NOT NULL CHECK (amount_minor >= 0),
  currency          text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  exemption_reason  text CHECK (btrim(exemption_reason) <> ''),
  appointment_id    text,
  encounter_id      text,
  FOREIGN KEY (facility_id, patient_id) REFERENCES patients (facility_id, id),
  FOREIGN KEY (facility_id, fee_item_id) REFERENCES fee_items (facility_id, id),
  FOREIGN KEY (facility_id, appointment_id, patient_id) REFERENCES appointments (facility_id, id, patient_id),
  FOREIGN KEY (facility_id, encounter_id, patient_id) REFERENCES encounters (facility_id, id, patient_id),
  -- The full price, or nothing when an exemption applies — never anything in between.
  CONSTRAINT charges_owe_price_or_nothing
    CHECK (amount_minor = CASE WHEN exemption_reason IS NULL THEN list_price_minor ELSE 0 END),
  UNIQUE (facility_id, id, patient_id)
);
CREATE INDEX charges_facility_patient_idx ON charges (facility_id, patient_id, created_on);
CREATE INDEX charges_facility_appointment_idx ON charges (facility_id, appointment_id);

CREATE TRIGGER charges_insert_only
  BEFORE UPDATE OR DELETE ON charges
  FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

-- Allocations are JSONB because the contract carries them inside the payment
-- record; that each names a charge of this patient, in this currency, is
-- checked on upload (src/sync/upload.ts), where a foreign key cannot reach.
CREATE TABLE payments (
  id              text PRIMARY KEY,
  facility_id     text NOT NULL REFERENCES facilities(id),
  schema_version  integer NOT NULL CHECK (schema_version > 0),
  created_by      text NOT NULL,
  created_on      timestamptz NOT NULL,
  device_id       text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by      text,
  updated_on      timestamptz,
  patient_id      text NOT NULL,
  receipt_number  text NOT NULL,
  method          text NOT NULL CHECK (method IN ('cash', 'transfer', 'pos', 'waiver')),
  amount_minor    integer NOT NULL CHECK (amount_minor > 0),
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  allocations     jsonb NOT NULL CHECK (jsonb_typeof(allocations) = 'array' AND jsonb_array_length(allocations) > 0),
  reference       text CHECK (btrim(reference) <> ''),
  reason          text CHECK (btrim(reason) <> ''),
  reverses        text,
  FOREIGN KEY (facility_id, patient_id) REFERENCES patients (facility_id, id),
  -- A reversal cancels a payment of the same patient, and a payment is reversed at most once.
  FOREIGN KEY (facility_id, reverses, patient_id) REFERENCES payments (facility_id, id, patient_id),
  UNIQUE (facility_id, reverses),
  UNIQUE (facility_id, receipt_number),
  CONSTRAINT payments_explain_waivers_and_reversals
    CHECK ((method <> 'waiver' AND reverses IS NULL) OR reason IS NOT NULL),
  UNIQUE (facility_id, id, patient_id)
);
CREATE INDEX payments_facility_patient_idx ON payments (facility_id, patient_id, created_on);

CREATE TRIGGER payments_insert_only
  BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

ALTER PUBLICATION powersync ADD TABLE fee_items, charges, payments;
