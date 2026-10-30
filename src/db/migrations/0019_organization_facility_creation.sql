-- A receipt binds a retried creation to the original source administrator and payload.
-- Device secrets are never stored here; device_credentials holds only their hashes.
CREATE TABLE organization_facility_creations (
  source_facility_id text NOT NULL REFERENCES facilities(id),
  actor_staff_id text NOT NULL,
  request_id uuid NOT NULL,
  payload_hash text NOT NULL,
  target_facility_id text NOT NULL UNIQUE REFERENCES facilities(id),
  target_staff_id text NOT NULL,
  device_id text NOT NULL UNIQUE REFERENCES devices(id),
  created_on timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_facility_id, actor_staff_id, request_id),
  FOREIGN KEY (source_facility_id, actor_staff_id) REFERENCES staff(facility_id, id),
  FOREIGN KEY (target_facility_id, target_staff_id) REFERENCES staff(facility_id, id),
  FOREIGN KEY (target_facility_id, device_id) REFERENCES devices(facility_id, id)
);
