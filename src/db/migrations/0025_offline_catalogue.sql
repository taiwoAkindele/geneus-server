-- The server's standard tests and result templates, copied into every facility so
-- devices can adopt them offline. The server writes and refreshes these rows at
-- start-up and when a facility is created; devices only read them, and the server
-- checks on upload that an adopted test or template matches them exactly.
CREATE TABLE standard_tests (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL CHECK(schema_version=5),
  created_by text NOT NULL, created_on timestamptz NOT NULL, device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  key text NOT NULL, name text NOT NULL, specimen text NOT NULL, classification text NOT NULL,
  aliases jsonb NOT NULL CHECK(jsonb_typeof(aliases)='array'), concept jsonb NOT NULL CHECK(jsonb_typeof(concept)='object'),
  UNIQUE(facility_id,id), UNIQUE(facility_id,key)
);
CREATE TABLE standard_templates (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL CHECK(schema_version=5),
  created_by text NOT NULL, created_on timestamptz NOT NULL, device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  key text NOT NULL, name text NOT NULL,
  tests jsonb NOT NULL CHECK(jsonb_typeof(tests)='array'), parts jsonb NOT NULL CHECK(jsonb_typeof(parts)='array' AND jsonb_array_length(parts)>0),
  UNIQUE(facility_id,id), UNIQUE(facility_id,key)
);
ALTER PUBLICATION powersync ADD TABLE standard_tests,standard_templates;
