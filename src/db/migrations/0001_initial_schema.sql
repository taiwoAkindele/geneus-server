-- Geneus Health — PostgreSQL schema, v1 (contract SCHEMA_VERSION 3).
--
-- One table per synced record type (SCHEMA.md §3) plus the server-only tables
-- that make sync safe: devices and their credentials, the idempotency ledger,
-- the reconcile queue, invites. Column names are snake_case; the server maps
-- to the contract's camelCase at its boundary (src/db/rows.ts).
--
-- Every synced table carries the same envelope, and every reference between
-- two facility-scoped tables includes facility_id, so a row can never point
-- at another facility's data — isolation is a constraint, not a convention.
--
-- Facilities and devices reference each other (a facility is registered from
-- a device; a device belongs to a facility), so those two constraints are
-- added after both tables exist and are deferred to transaction end.

-- ---------------------------------------------------------------------------
-- Organisation
-- ---------------------------------------------------------------------------

CREATE TABLE facilities (
  id              text PRIMARY KEY,                       -- the facility code, e.g. OOE-PHC
  facility_id     text NOT NULL,                          -- envelope; always equals id
  schema_version  integer NOT NULL CHECK (schema_version > 0),
  created_by      text NOT NULL,
  created_on      timestamptz NOT NULL,
  device_id       text NOT NULL,
  updated_by      text,
  updated_on      timestamptz,
  code            text NOT NULL,
  name            text NOT NULL,
  state           text NOT NULL,
  lga             text NOT NULL,
  level           text NOT NULL CHECK (level IN ('chc', 'phc', 'general_hospital', 'teaching_hospital', 'specialist')),
  CONSTRAINT facilities_self_scoped CHECK (facility_id = id AND code = id)
);

CREATE TABLE staff (
  id              text PRIMARY KEY,
  facility_id     text NOT NULL REFERENCES facilities(id),
  schema_version  integer NOT NULL CHECK (schema_version > 0),
  created_by      text NOT NULL,
  created_on      timestamptz NOT NULL,
  device_id       text NOT NULL,
  updated_by      text,
  updated_on      timestamptz,
  staff_id        text NOT NULL CHECK (staff_id = id),
  full_name       text NOT NULL,
  role            text NOT NULL CHECK (role IN ('chew', 'nurse', 'doctor', 'records_officer', 'facility_admin', 'supervisor')),
  permission      text NOT NULL CHECK (permission IN ('read_only', 'read_write')),
  active          boolean NOT NULL DEFAULT true,
  -- Lets child tables reference staff *within the same facility* (composite FK).
  UNIQUE (facility_id, id)
);
CREATE INDEX staff_facility_active_idx ON staff (facility_id, active);

CREATE TABLE devices (
  id              text PRIMARY KEY,
  facility_id     text NOT NULL REFERENCES facilities(id),
  schema_version  integer NOT NULL CHECK (schema_version > 0),
  created_by      text NOT NULL,
  created_on      timestamptz NOT NULL,
  device_id       text NOT NULL,                          -- the device that enrolled this one
  updated_by      text,
  updated_on      timestamptz,
  label           text,
  enrolled_by     text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  wipe_requested  boolean NOT NULL DEFAULT false,
  enrolled_on     timestamptz NOT NULL,
  revoked_on      timestamptz,
  last_seen_on    timestamptz,
  CONSTRAINT devices_revoked_have_a_time CHECK (status <> 'revoked' OR revoked_on IS NOT NULL),
  FOREIGN KEY (facility_id, enrolled_by) REFERENCES staff (facility_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (facility_id, id)
);
CREATE INDEX devices_facility_status_idx ON devices (facility_id, status);

-- The secret a device proves itself with, hashed. Kept apart from `devices` so
-- that table can be synced with a plain SELECT and no column ever needs to be
-- remembered as "do not sync" (SCHEMA.md §10).
CREATE TABLE device_credentials (
  device_id        text PRIMARY KEY REFERENCES devices(id),
  credential_hash  text NOT NULL,
  issued_on        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (credential_hash)
);

-- A facility is registered from a device, and that device belongs to the
-- facility: both directions are real, so both are constrained (deferred).
ALTER TABLE facilities
  ADD CONSTRAINT facilities_device_fk FOREIGN KEY (device_id) REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE staff
  ADD CONSTRAINT staff_device_fk FOREIGN KEY (device_id) REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE devices
  ADD CONSTRAINT devices_device_fk FOREIGN KEY (device_id) REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE units (
  id              text PRIMARY KEY,
  facility_id     text NOT NULL REFERENCES facilities(id),
  schema_version  integer NOT NULL CHECK (schema_version > 0),
  created_by      text NOT NULL,
  created_on      timestamptz NOT NULL,
  device_id       text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by      text,
  updated_on      timestamptz,
  unit_id         text NOT NULL CHECK (unit_id = id),
  name            text NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  UNIQUE (facility_id, id)
);

CREATE TABLE roster_shifts (
  id              text PRIMARY KEY,
  facility_id     text NOT NULL REFERENCES facilities(id),
  schema_version  integer NOT NULL CHECK (schema_version > 0),
  created_by      text NOT NULL,
  created_on      timestamptz NOT NULL,
  device_id       text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by      text,
  updated_on      timestamptz,
  staff_id        text NOT NULL,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  signature       text,                                   -- server-owned; NULL until signed
  extended_until  timestamptz,
  CONSTRAINT roster_shifts_window CHECK (ends_at > starts_at),
  FOREIGN KEY (facility_id, staff_id) REFERENCES staff (facility_id, id)
);
CREATE INDEX roster_shifts_facility_staff_idx ON roster_shifts (facility_id, staff_id, starts_at);

-- ---------------------------------------------------------------------------
-- Patients and care
-- ---------------------------------------------------------------------------

CREATE TABLE patients (
  id                text PRIMARY KEY,                     -- the Patient ID, e.g. OOE-PHC-000047-K2
  facility_id       text NOT NULL REFERENCES facilities(id),
  schema_version    integer NOT NULL CHECK (schema_version > 0),
  created_by        text NOT NULL,
  created_on        timestamptz NOT NULL,
  device_id         text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by        text,
  updated_on        timestamptz,
  patient_id        text NOT NULL CHECK (patient_id = id),
  full_name         text NOT NULL,
  address           text NOT NULL,
  sex               text NOT NULL CHECK (sex IN ('male', 'female')),
  date_of_birth     date,
  dob_estimated     boolean NOT NULL DEFAULT false,
  age_years         integer CHECK (age_years BETWEEN 0 AND 130),
  occupation        text,
  religion          text,
  allergies         text[] NOT NULL DEFAULT '{}',
  phone             text,
  nin               text,
  legacy_paper_ref  text,
  CONSTRAINT patients_have_an_age CHECK (date_of_birth IS NOT NULL OR age_years IS NOT NULL),
  UNIQUE (facility_id, id)
);
CREATE INDEX patients_facility_name_idx ON patients (facility_id, full_name);
CREATE INDEX patients_facility_phone_idx ON patients (facility_id, phone) WHERE phone IS NOT NULL;

CREATE TABLE visits (
  id              text PRIMARY KEY,
  facility_id     text NOT NULL REFERENCES facilities(id),
  schema_version  integer NOT NULL CHECK (schema_version > 0),
  created_by      text NOT NULL,
  created_on      timestamptz NOT NULL,
  device_id       text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by      text,
  updated_on      timestamptz,
  patient_id      text NOT NULL,
  unit_id         text NOT NULL,
  visit_date      timestamptz NOT NULL,
  setting         text NOT NULL DEFAULT 'facility' CHECK (setting IN ('facility', 'outreach')),
  symptoms        text[] NOT NULL DEFAULT '{}',
  diagnosis       text[] NOT NULL DEFAULT '{}',
  treatment       text,
  referral_id     text,
  notes           text,
  FOREIGN KEY (facility_id, patient_id) REFERENCES patients (facility_id, id),
  FOREIGN KEY (facility_id, unit_id) REFERENCES units (facility_id, id)
);
CREATE INDEX visits_facility_patient_idx ON visits (facility_id, patient_id, visit_date);

CREATE TABLE handoffs (
  id              text PRIMARY KEY,
  facility_id     text NOT NULL REFERENCES facilities(id),
  schema_version  integer NOT NULL CHECK (schema_version > 0),
  created_by      text NOT NULL,
  created_on      timestamptz NOT NULL,
  device_id       text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by      text,
  updated_on      timestamptz,
  patient_id      text NOT NULL,
  from_unit_id    text NOT NULL,
  to_unit_id      text NOT NULL,
  instruction     text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'received', 'done')),
  FOREIGN KEY (facility_id, patient_id) REFERENCES patients (facility_id, id),
  FOREIGN KEY (facility_id, from_unit_id) REFERENCES units (facility_id, id),
  FOREIGN KEY (facility_id, to_unit_id) REFERENCES units (facility_id, id)
);
CREATE INDEX handoffs_facility_status_idx ON handoffs (facility_id, status);

CREATE TABLE appointments (
  id              text PRIMARY KEY,
  facility_id     text NOT NULL REFERENCES facilities(id),
  schema_version  integer NOT NULL CHECK (schema_version > 0),
  created_by      text NOT NULL,
  created_on      timestamptz NOT NULL,
  device_id       text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by      text,
  updated_on      timestamptz,
  patient_id      text NOT NULL,
  reason          text NOT NULL,
  scheduled_for   timestamptz,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'scheduled')),
  CONSTRAINT appointments_scheduled_have_a_time CHECK (status <> 'scheduled' OR scheduled_for IS NOT NULL),
  FOREIGN KEY (facility_id, patient_id) REFERENCES patients (facility_id, id)
);
CREATE INDEX appointments_facility_patient_idx ON appointments (facility_id, patient_id);
CREATE INDEX appointments_facility_scheduled_idx ON appointments (facility_id, scheduled_for);

-- `tier1` is the frozen snapshot that travels with the patient (PRD §11.2): it is
-- copied at send time, never queried by field, and its shape is the PRD's to
-- evolve — the one place in this section where JSONB is the honest type.
CREATE TABLE referrals (
  id                        text PRIMARY KEY,             -- equals referral_id
  facility_id               text NOT NULL REFERENCES facilities(id),
  schema_version            integer NOT NULL CHECK (schema_version > 0),
  created_by                text NOT NULL,
  created_on                timestamptz NOT NULL,
  device_id                 text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by                text,
  updated_on                timestamptz,
  referral_id               text NOT NULL CHECK (referral_id = id),
  patient_id                text NOT NULL,
  from_facility_id          text NOT NULL,
  to_facility_id            text NOT NULL,
  tier1                     jsonb NOT NULL,
  status                    text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'seen', 'arrived', 'closed')),
  delivery_status           text NOT NULL DEFAULT 'alert_pending' CHECK (delivery_status IN ('alert_sent', 'alert_pending')),
  sent_on                   timestamptz NOT NULL,
  seen_on                   timestamptz,
  arrived_on                timestamptz,
  closed_on                 timestamptz,
  not_yet_arrived_flagged   boolean NOT NULL DEFAULT false,
  FOREIGN KEY (facility_id, patient_id) REFERENCES patients (facility_id, id)
);
CREATE INDEX referrals_facility_status_idx ON referrals (facility_id, status);

-- ---------------------------------------------------------------------------
-- Registers — data-driven (SCHEMA.md §11): fields and values are JSONB because
-- a column per field would need DDL every time a facility added one.
-- ---------------------------------------------------------------------------

CREATE TABLE register_definitions (
  id                text PRIMARY KEY,                     -- `${register_id}:v${version}`
  facility_id       text NOT NULL REFERENCES facilities(id),
  schema_version    integer NOT NULL CHECK (schema_version > 0),
  created_by        text NOT NULL,
  created_on        timestamptz NOT NULL,
  device_id         text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by        text,
  updated_on        timestamptz,
  register_id       text NOT NULL,
  version           integer NOT NULL CHECK (version > 0),
  name              text NOT NULL,
  category          text NOT NULL,
  description       text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  fields            jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array'),
  CONSTRAINT register_definitions_id_convention CHECK (id = register_id || ':v' || version),
  -- Two devices publishing the same version offline collide here; the second is
  -- rejected into the reconcile queue, never merged (SCHEMA.md §7).
  UNIQUE (facility_id, register_id, version)
);

CREATE TABLE register_entries (
  id                text PRIMARY KEY,
  facility_id       text NOT NULL REFERENCES facilities(id),
  schema_version    integer NOT NULL CHECK (schema_version > 0),
  created_by        text NOT NULL,
  created_on        timestamptz NOT NULL,
  device_id         text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by        text,
  updated_on        timestamptz,
  register_id       text NOT NULL,
  register_version  integer NOT NULL,
  entry_date        date NOT NULL,
  setting           text NOT NULL DEFAULT 'facility' CHECK (setting IN ('facility', 'outreach')),
  patient_id        text,
  "values"          jsonb NOT NULL CHECK (jsonb_typeof("values") = 'object'),
  FOREIGN KEY (facility_id, register_id, register_version)
    REFERENCES register_definitions (facility_id, register_id, version),
  FOREIGN KEY (facility_id, patient_id) REFERENCES patients (facility_id, id)
);
CREATE INDEX register_entries_facility_register_idx ON register_entries (facility_id, register_id, entry_date);
CREATE INDEX register_entries_facility_patient_idx ON register_entries (facility_id, patient_id) WHERE patient_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Stock
-- ---------------------------------------------------------------------------

CREATE TABLE stock_items (
  id                text PRIMARY KEY,
  facility_id       text NOT NULL REFERENCES facilities(id),
  schema_version    integer NOT NULL CHECK (schema_version > 0),
  created_by        text NOT NULL,
  created_on        timestamptz NOT NULL,
  device_id         text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by        text,
  updated_on        timestamptz,
  name              text NOT NULL,
  category          text NOT NULL DEFAULT 'other' CHECK (category IN ('drug', 'vaccine', 'test_kit', 'fp_commodity', 'consumable', 'other')),
  unit_of_measure   text,
  quantity_on_hand  numeric NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  reorder_level     numeric CHECK (reorder_level >= 0),
  UNIQUE (facility_id, id)
);

CREATE TABLE stock_movements (
  id              text PRIMARY KEY,
  facility_id     text NOT NULL REFERENCES facilities(id),
  schema_version  integer NOT NULL CHECK (schema_version > 0),
  created_by      text NOT NULL,
  created_on      timestamptz NOT NULL,
  device_id       text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by      text,
  updated_on      timestamptz,
  item_id         text NOT NULL,
  change          numeric NOT NULL,
  reason          text NOT NULL CHECK (reason IN ('received', 'dispensed', 'adjustment', 'expired', 'transfer')),
  moved_on        timestamptz NOT NULL,
  note            text,
  FOREIGN KEY (facility_id, item_id) REFERENCES stock_items (facility_id, id)
);
CREATE INDEX stock_movements_facility_item_idx ON stock_movements (facility_id, item_id, moved_on);

-- ---------------------------------------------------------------------------
-- Audit — append-only, enforced by the database itself (PRD §14)
-- ---------------------------------------------------------------------------

CREATE TABLE audit_events (
  id              text PRIMARY KEY,
  facility_id     text NOT NULL REFERENCES facilities(id),
  schema_version  integer NOT NULL CHECK (schema_version > 0),
  created_by      text NOT NULL,
  created_on      timestamptz NOT NULL,
  device_id       text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by      text,
  updated_on      timestamptz,
  actor_staff_id  text,
  action          text NOT NULL CHECK (action IN ('view', 'create', 'update', 'login', 'logout', 'sync', 'enroll', 'revoke', 'export', 'reject')),
  entity_type     text,
  entity_id       text,
  result          text NOT NULL DEFAULT 'ok' CHECK (result IN ('ok', 'rejected')),
  occurred_on     timestamptz NOT NULL,                   -- the device's clock
  received_on     timestamptz NOT NULL DEFAULT now(),     -- the server's clock
  metadata        jsonb CHECK (metadata IS NULL OR jsonb_typeof(metadata) = 'object'),
  -- Audit rows are never edited, so the update trail is meaningless here.
  CONSTRAINT audit_events_are_never_updated CHECK (updated_by IS NULL AND updated_on IS NULL)
);
CREATE INDEX audit_events_facility_received_idx ON audit_events (facility_id, received_on);

CREATE FUNCTION forbid_audit_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only (attempted %)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_change();

-- ---------------------------------------------------------------------------
-- Sync machinery
-- ---------------------------------------------------------------------------

-- The reconcile queue (SCHEMA.md §7): every uploaded mutation the server would
-- not apply, kept so a records officer can act on it. Synced back to the facility.
CREATE TABLE sync_rejections (
  id              text PRIMARY KEY,
  facility_id     text NOT NULL REFERENCES facilities(id),
  schema_version  integer NOT NULL CHECK (schema_version > 0),
  created_by      text NOT NULL,
  created_on      timestamptz NOT NULL,
  device_id       text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,
  updated_by      text,
  updated_on      timestamptz,
  entity_type     text NOT NULL,
  entity_id       text NOT NULL,
  operation       text NOT NULL CHECK (operation IN ('put', 'patch', 'delete')),
  category        text NOT NULL CHECK (category IN ('identity', 'authorization', 'validation', 'conflict')),
  reason          text NOT NULL,
  attributed_to   text,
  occurred_on     timestamptz,
  conflicts       jsonb CHECK (conflicts IS NULL OR jsonb_typeof(conflicts) = 'array'),
  resolved_on     timestamptz,
  resolved_by     text,
  resolution      text
);
CREATE INDEX sync_rejections_facility_open_idx ON sync_rejections (facility_id, created_on) WHERE resolved_on IS NULL;

-- The idempotency ledger (root §12). PowerSync numbers every queued write per
-- device (client_id); recording that number in the same transaction as the
-- write makes a retried upload a no-op rather than a duplicate record.
CREATE TABLE applied_mutations (
  device_id       text NOT NULL REFERENCES devices(id),
  client_id       bigint NOT NULL,
  transaction_id  bigint,
  entity_type     text NOT NULL,
  entity_id       text NOT NULL,
  outcome         text NOT NULL CHECK (outcome IN ('applied', 'rejected')),
  applied_on      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, client_id)
);

-- Server-only: facility registration is gated by a single-use invite minted out
-- of band (scripts/create-invite.ts). Not synced, not part of the contract.
CREATE TABLE facility_invites (
  token           text PRIMARY KEY,                       -- stored uppercase
  label           text NOT NULL,
  created_on      timestamptz NOT NULL DEFAULT now(),
  expires_on      timestamptz NOT NULL,
  claimed_on      timestamptz,
  claimed_for     text,                                   -- facility code; no FK, the facility is created after the claim
  CONSTRAINT facility_invites_claim_is_complete CHECK ((claimed_on IS NULL) = (claimed_for IS NULL))
);
