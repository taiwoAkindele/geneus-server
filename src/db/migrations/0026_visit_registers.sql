-- Registers that fill themselves from visits. A definition may name which visits
-- fill it; an entry in such a register completes one visit's row with the fields
-- staff record, so it names that visit. Both columns are optional: every existing
-- register and entry stays as it was.
ALTER TABLE register_definitions ADD COLUMN visit_link jsonb CHECK (visit_link IS NULL OR jsonb_typeof(visit_link) = 'object');
ALTER TABLE register_entries ADD COLUMN encounter_id text;
CREATE INDEX register_entries_facility_visit_idx ON register_entries (facility_id, register_id, encounter_id) WHERE encounter_id IS NOT NULL;
