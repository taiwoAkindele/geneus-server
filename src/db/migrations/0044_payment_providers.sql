-- Payment providers: a hospital's central receiving account may be held with any registered provider
-- (Paystack, Moniepoint/Monnify, ...). Existing rows are Paystack and keep that label through the defaults;
-- no financial record is rewritten. Provider ids are validated, not listed, so new providers need no migration.
ALTER TABLE billing_connections ADD COLUMN provider text NOT NULL DEFAULT 'paystack' CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$');
ALTER TABLE billing_receiving_accounts ADD COLUMN provider text NOT NULL DEFAULT 'paystack' CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$');

-- Account uniqueness becomes per provider; the Paystack-only check on incoming transfers is replaced.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'billing_receiving_accounts'::regclass AND contype = 'u'
    AND pg_get_constraintdef(oid) IN ('UNIQUE (facility_id, mode, provider_account_id)', 'UNIQUE (facility_id, mode, account_number)') LOOP
    EXECUTE format('ALTER TABLE billing_receiving_accounts DROP CONSTRAINT %I', c.conname);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'incoming_transfers'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%provider%paystack%' LOOP
    EXECUTE format('ALTER TABLE incoming_transfers DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE billing_receiving_accounts ADD CONSTRAINT receiving_account_provider_reference UNIQUE (facility_id, provider, mode, provider_account_id);
ALTER TABLE billing_receiving_accounts ADD CONSTRAINT receiving_account_provider_number UNIQUE (facility_id, provider, mode, account_number);
ALTER TABLE incoming_transfers ADD CONSTRAINT incoming_transfer_provider_id CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$');
