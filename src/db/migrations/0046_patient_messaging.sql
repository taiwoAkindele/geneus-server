-- Links a patient opens without signing in, to their bill (with a way to pay) or a receipt
-- (docs/PATIENT-BILL-DELIVERY-PLAN-2026-11-21.md, step 2). The link's secret is never stored, only its SHA-256.
-- Links expire and staff can stop them; nothing here is synced to devices.
CREATE TABLE patient_document_links (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id),
  kind text NOT NULL CHECK (kind IN ('bill', 'receipt')),
  -- The bill key (patient|currency|source) or the payment id.
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 300),
  patient_id text NOT NULL,
  token_hash bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  created_by text NOT NULL,
  created_on timestamptz NOT NULL DEFAULT now(),
  expires_on timestamptz NOT NULL,
  stopped_on timestamptz,
  stopped_by text,
  FOREIGN KEY (facility_id, patient_id) REFERENCES patients(facility_id, id),
  CHECK (expires_on > created_on),
  CHECK ((stopped_on IS NULL) = (stopped_by IS NULL))
);
CREATE INDEX patient_document_links_subject_idx ON patient_document_links(facility_id, kind, subject) WHERE stopped_on IS NULL;

-- Shown on bills and receipts, and the reply-to address of patient emails.
ALTER TABLE facilities ADD COLUMN email text CHECK (email IS NULL OR (length(email) <= 200 AND email = lower(btrim(email)) AND email LIKE '%_@_%'));

-- Each SMS or email of a bill or receipt to a patient (docs/PATIENT-BILL-DELIVERY-PLAN-2026-11-21.md, steps 3-5).
-- Written and updated only by the server; synced so the send shows in the bill's or receipt's Activity.
-- The recipient is masked and the message text is never stored.
CREATE TABLE patient_messages (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  schema_version integer NOT NULL CHECK (schema_version > 0), created_by text NOT NULL, created_on timestamptz NOT NULL,
  device_id text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED, updated_by text, updated_on timestamptz,
  patient_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bill', 'receipt')),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 300),
  reference text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  "to" text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'failed')),
  automatic boolean NOT NULL,
  reason text CHECK (reason IS NULL OR length(reason) <= 300),
  attempts integer NOT NULL CHECK (attempts BETWEEN 0 AND 10),
  sent_on timestamptz, delivered_on timestamptz,
  FOREIGN KEY (facility_id, patient_id) REFERENCES patients(facility_id, id)
);
CREATE INDEX patient_messages_subject_idx ON patient_messages(facility_id, kind, subject);
ALTER PUBLICATION powersync ADD TABLE patient_messages;
