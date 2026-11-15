-- Care services on bookings and visits, and facility details.
--
-- A care service (outpatient consultation, antenatal care…) is an existing
-- service_offering. It now names the visit kinds it records, so booking and
-- registration offer the hospital's own services while the visit type that fee
-- exemptions, registers and reports read is still saved. Bookings and visits
-- keep which care service they were for. All columns are optional or default:
-- existing offerings record no visits until set up, and older bookings and
-- visits keep no care service.

ALTER TABLE service_offerings ADD COLUMN visit_types jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(visit_types) = 'array');

ALTER TABLE appointments ADD COLUMN offering_id text;
ALTER TABLE encounters ADD COLUMN offering_id text;

-- What a hospital says about itself. The code (id) is never changed here.
ALTER TABLE facilities ADD COLUMN country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');
ALTER TABLE facilities ADD COLUMN address text;
ALTER TABLE facilities ADD COLUMN phone text;
ALTER TABLE facilities ADD COLUMN currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');
