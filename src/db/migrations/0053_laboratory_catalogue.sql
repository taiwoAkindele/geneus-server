ALTER TABLE service_definitions ADD COLUMN laboratory_catalogue jsonb;

ALTER TABLE service_definitions ADD CONSTRAINT classified_laboratory_definition CHECK (
  laboratory_catalogue IS NULL OR (
    category = 'laboratory' AND investigation IS NOT NULL
    AND CASE laboratory_catalogue->>'pricingCategory'
      WHEN 'billable' THEN NOT orderable OR fee_item_id IS NOT NULL
      WHEN 'non_billable' THEN fee_item_id IS NULL
      ELSE false
    END
  )
);

CREATE UNIQUE INDEX classified_laboratory_fee
  ON service_definitions(facility_id, fee_item_id)
  WHERE laboratory_catalogue IS NOT NULL AND fee_item_id IS NOT NULL;
