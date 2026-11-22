-- Receipts go to the patient automatically once the server accepts a payment, however it arrived (a device upload,
-- a bank transfer linked to a bill, an online checkout). The trigger queues it in the same transaction as the
-- payment; the server's messaging loop sends it on the channels the patient can receive. Waivers and reversals
-- are not money received and are not sent. Only payments accepted from now on are queued.
CREATE TABLE patient_receipt_queue (
  payment_id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id),
  queued_on timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION queue_patient_receipt() RETURNS trigger AS $$
BEGIN
  IF NEW.method <> 'waiver' AND NEW.reverses IS NULL THEN
    INSERT INTO patient_receipt_queue (payment_id, facility_id) VALUES (NEW.id, NEW.facility_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER payments_queue_receipt AFTER INSERT ON payments FOR EACH ROW EXECUTE FUNCTION queue_patient_receipt();

-- Paying a bill online (plan step 6): the contract's new transfer fields and payment method. Added now because the
-- sync rules select every contract field. Existing rows are bank transfers and keep that meaning (channel NULL).
ALTER TABLE incoming_transfers ADD COLUMN channel text CHECK (channel IN ('bank_transfer', 'checkout'));
ALTER TABLE incoming_transfers ADD COLUMN bill_key text CHECK (bill_key IS NULL OR length(bill_key) BETWEEN 5 AND 300);
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'payments'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%method%' AND pg_get_constraintdef(oid) LIKE '%waiver%' AND pg_get_constraintdef(oid) NOT LIKE '%reason%' LOOP
    EXECUTE format('ALTER TABLE payments DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
-- An online payment is always the applied part of a checkout the server verified with the provider.
ALTER TABLE payments ADD CONSTRAINT payments_method CHECK (method IN ('cash', 'transfer', 'pos', 'waiver', 'online'));
ALTER TABLE payments ADD CONSTRAINT payments_online_verified CHECK (method <> 'online' OR incoming_transfer_id IS NOT NULL);

-- A patient paying their bill online from its link (plan step 6). The reference is what the provider's checkout
-- and webhook report back. Never synced: the verified money becomes an incoming transfer (channel 'checkout') and,
-- in live mode, an 'online' payment applied to the bill; anything above what was due waits for staff.
CREATE TABLE checkout_sessions (
  reference text PRIMARY KEY CHECK (reference ~ '^geneus-co-[a-f0-9-]{36}$'),
  facility_id text NOT NULL REFERENCES facilities(id),
  bill_key text NOT NULL CHECK (length(bill_key) BETWEEN 5 AND 300),
  patient_id text NOT NULL,
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  mode text NOT NULL CHECK (mode IN ('test', 'live')),
  -- Preserve the connection and exact charges used at initialization, even after hospital settings change.
  encrypted_secret text NOT NULL,
  charge_ids text[] NOT NULL CHECK (cardinality(charge_ids) > 0),
  link_id text NOT NULL REFERENCES patient_document_links(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')),
  created_on timestamptz NOT NULL DEFAULT now(),
  expires_on timestamptz NOT NULL,
  paid_on timestamptz,
  checked_on timestamptz,
  incoming_transfer_id text,
  held_minor integer CHECK (held_minor IS NULL OR held_minor >= 0),
  FOREIGN KEY (facility_id, patient_id) REFERENCES patients(facility_id, id),
  CHECK ((status = 'paid') = (incoming_transfer_id IS NOT NULL))
);
CREATE INDEX checkout_sessions_bill_idx ON checkout_sessions(facility_id, bill_key);
