-- Saved spreadsheet column mappings (INSURANCE-HMO-2, Milestone 2).
--
-- Generic by kind: a template remembers which column held each field for one
-- sheet layout, so the next file in that layout maps itself. Imported files
-- are never stored; only the mapping a person confirmed. Server-held and never
-- published to devices.

CREATE TABLE import_mapping_templates (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id),
  kind text NOT NULL CHECK (kind IN ('contract_tariff')),
  payer_id text,
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  headers jsonb NOT NULL CHECK (jsonb_typeof(headers) = 'array'),
  header_row integer NOT NULL CHECK (header_row BETWEEN 0 AND 50),
  mapping jsonb NOT NULL CHECK (jsonb_typeof(mapping) = 'object'),
  revision integer NOT NULL CHECK (revision > 0),
  updated_by text NOT NULL,
  updated_on timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (facility_id, payer_id) REFERENCES payers(facility_id, id)
);
-- One template per name, per payer (or hospital-wide), per kind.
CREATE UNIQUE INDEX import_mapping_templates_name ON import_mapping_templates (facility_id, kind, COALESCE(payer_id, ''), lower(name));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'powersync') THEN
    REVOKE ALL ON import_mapping_templates FROM powersync;
  END IF;
END $$;
