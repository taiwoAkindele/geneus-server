-- What a visit is for (antenatal, immunisation, family planning…), chosen when it
-- starts, so registers can take the visits of a type. Optional: visits recorded
-- before this keep no type and count as general visits.
ALTER TABLE encounters ADD COLUMN visit_type text CHECK (visit_type IS NULL OR visit_type IN ('general', 'follow_up', 'antenatal', 'postnatal', 'delivery', 'immunisation', 'family_planning', 'child_welfare', 'tb_programme', 'hiv_programme', 'emergency'));
