-- Schema 4 / policy 10. No legacy ID, financial amount or clinical author is rewritten.
ALTER TABLE facilities ADD COLUMN time_zone text, ADD COLUMN workforce_policy jsonb;
DO $$ DECLARE name text; BEGIN
  SELECT conname INTO name FROM pg_constraint WHERE conrelid='units'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%unit_id = id%';
  IF name IS NOT NULL THEN EXECUTE format('ALTER TABLE units DROP CONSTRAINT %I',name); END IF;
END $$;
ALTER TABLE units ADD CONSTRAINT units_alias_unique UNIQUE(facility_id, unit_id);
ALTER TABLE units ADD COLUMN kind text CHECK(kind IN ('department','unit')),
  ADD COLUMN parent_id text, ADD COLUMN routing_enabled boolean, ADD COLUMN revision integer CHECK(revision > 0);
ALTER TABLE units ADD FOREIGN KEY(facility_id,parent_id) REFERENCES units(facility_id,id);
ALTER TABLE units ADD CHECK(parent_id IS DISTINCT FROM id AND parent_id IS DISTINCT FROM unit_id);
ALTER TABLE billing_departments ADD COLUMN organization_unit_id text, ADD COLUMN revision integer CHECK(revision > 0);
ALTER TABLE billing_departments ADD FOREIGN KEY(facility_id,organization_unit_id) REFERENCES units(facility_id,id);
ALTER TABLE appointments ADD COLUMN allocation jsonb;
ALTER TABLE encounter_entries ADD COLUMN actor_context jsonb;
ALTER TABLE clinical_events ADD COLUMN actor_context jsonb;
ALTER TABLE sync_rejections DROP CONSTRAINT sync_rejections_category_check;
ALTER TABLE sync_rejections ADD CONSTRAINT sync_rejections_category_check CHECK(category IN ('identity','authorization','validation','conflict','dependency'));
ALTER TABLE sync_rejections ADD COLUMN dependencies jsonb, ADD COLUMN visibility text CHECK(visibility IN ('facility','restricted')), ADD COLUMN visible_to_staff_ids jsonb;
ALTER TABLE sync_rejections ADD CHECK(category <> 'dependency' OR (jsonb_array_length(dependencies) > 0 AND (refused_record IS NOT NULL OR refused_changes IS NOT NULL)));

ALTER TABLE staff DROP CONSTRAINT staff_role_check;
ALTER TABLE staff ADD CONSTRAINT staff_role_check CHECK(role IN ('chew','nurse','doctor','records_officer','facility_admin','supervisor','cashier','laboratory_staff','pharmacy_staff'));
ALTER TABLE staff DROP CONSTRAINT staff_additional_roles_check;
ALTER TABLE staff ADD CONSTRAINT staff_additional_roles_check CHECK(jsonb_typeof(additional_roles) = 'array' AND additional_roles <@ '["chew","nurse","doctor","records_officer","facility_admin","supervisor","cashier","laboratory_staff","pharmacy_staff"]');
ALTER TABLE staff DROP CONSTRAINT staff_additional_permissions_check;
ALTER TABLE staff ADD CONSTRAINT staff_additional_permissions_check CHECK(jsonb_typeof(additional_permissions) = 'array' AND additional_permissions <@ '["patient:create","patient:update","patient_identity:review","patient_identity:resolve","appointment:create","appointment:update","visit:create","encounter:record","handoff:create","handoff:update","referral:create","referral:update","register_entry:create","stock_movement:create","charge:create","payment:receive","payment:waive","payment:reverse","register_definition:publish","unit:manage","stock_item:manage","fee_item:manage","staff:manage","staff:permission","staff:deactivate","roster:assign","roster:extend","device:enroll","device:revoke","sync_rejection:resolve","location:manage","service:manage","practitioner:manage","credential:manage","credential:read","staff_assignment:manage","service_session:manage","service_session:operate","work_ownership:claim","work_ownership:manage","clinical:assess","clinical:diagnose","clinical:prescribe","clinical:collect_specimen","clinical:perform_test","clinical:record_result","clinical:verify_result","clinical:release_result","clinical:dispense","clinical:administer"]');
ALTER TABLE encounter_entries DROP CONSTRAINT encounter_entries_actor_role_check;
ALTER TABLE encounter_entries ADD CHECK(actor_role IN ('chew','nurse','doctor','records_officer','facility_admin','supervisor','cashier','laboratory_staff','pharmacy_staff'));
ALTER TABLE clinical_events DROP CONSTRAINT clinical_events_actor_role_check;
ALTER TABLE clinical_events ADD CHECK(actor_role IN ('chew','nurse','doctor','records_officer','facility_admin','supervisor','cashier','laboratory_staff','pharmacy_staff'));

CREATE TABLE locations (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL CHECK(schema_version=4),
  created_by text NOT NULL, created_on timestamptz NOT NULL, device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  name text NOT NULL, kind text NOT NULL CHECK(kind IN ('site','building','room','ward','bed','store','service_point','mobile','virtual')),
  parent_id text, unit_id text, active boolean NOT NULL DEFAULT true, revision integer NOT NULL CHECK(revision>0), description text, capacity integer CHECK(capacity>0),
  UNIQUE(facility_id,id), FOREIGN KEY(facility_id,parent_id) REFERENCES locations(facility_id,id), FOREIGN KEY(facility_id,unit_id) REFERENCES units(facility_id,id),
  CHECK(parent_id IS DISTINCT FROM id), CHECK(kind <> 'bed' OR capacity IS NULL OR capacity=1)
);
CREATE TABLE service_definitions (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL CHECK(schema_version=4),
  created_by text NOT NULL, created_on timestamptz NOT NULL, device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  name text NOT NULL, category text NOT NULL, concept jsonb NOT NULL, orderable boolean NOT NULL, active boolean NOT NULL, revision integer NOT NULL CHECK(revision>0), UNIQUE(facility_id,id)
);
CREATE TABLE service_offerings (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL CHECK(schema_version=4),
  created_by text NOT NULL, created_on timestamptz NOT NULL, device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  service_definition_id text NOT NULL, unit_id text NOT NULL, name text NOT NULL, location_ids jsonb NOT NULL,
  delivery text NOT NULL CHECK(delivery IN ('physical','mobile','virtual')), required_actions jsonb NOT NULL,
  intake_policy text NOT NULL CHECK(intake_policy IN ('walk_in','scheduled','both')), time_zone text NOT NULL,
  configuration text NOT NULL CHECK(configuration IN ('draft','proposed','active','retired')), revision integer NOT NULL CHECK(revision>0),
  resource_readiness text NOT NULL CHECK(resource_readiness IN ('unassessed','available','unavailable')),
  UNIQUE(facility_id,id), FOREIGN KEY(facility_id,unit_id) REFERENCES units(facility_id,id), FOREIGN KEY(facility_id,service_definition_id) REFERENCES service_definitions(facility_id,id)
);
CREATE TABLE practitioner_profiles (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL CHECK(schema_version=4),
  created_by text NOT NULL, created_on timestamptz NOT NULL, device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  staff_id text NOT NULL, profession jsonb NOT NULL, specialties jsonb NOT NULL, active boolean NOT NULL, revision integer NOT NULL CHECK(revision>0),
  UNIQUE(facility_id,id), UNIQUE(facility_id,staff_id), FOREIGN KEY(facility_id,staff_id) REFERENCES staff(facility_id,id)
);
CREATE TABLE external_clinical_reviewers (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL CHECK(schema_version=4),
  created_by text NOT NULL CHECK(created_by='system'), created_on timestamptz NOT NULL, device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  external_subject_reference text NOT NULL, display_name text NOT NULL, governance_reference text NOT NULL, authorized_by text NOT NULL,
  scopes jsonb NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(ends_at>starts_at), linked_staff_id text,
  active boolean NOT NULL, revision integer NOT NULL CHECK(revision>0), UNIQUE(facility_id,id), FOREIGN KEY(facility_id,linked_staff_id) REFERENCES staff(facility_id,id)
);
CREATE TABLE credentials (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL CHECK(schema_version=4),
  created_by text NOT NULL, created_on timestamptz NOT NULL, device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  credential_id text NOT NULL, version integer NOT NULL CHECK(version>0), previous_id text, staff_id text NOT NULL,
  kind text NOT NULL, issuer text NOT NULL, label text NOT NULL, identifier text, evidence_reference text, issued_on date, valid_through date,
  time_zone text NOT NULL, external_reviewer_id text, verification text NOT NULL CHECK(verification IN ('unverified','verified','rejected','withdrawn')),
  checked_by text, checked_on timestamptz, reason text,
  UNIQUE(facility_id,id), UNIQUE(facility_id,credential_id,version), UNIQUE(facility_id,credential_id,staff_id,id),
  FOREIGN KEY(facility_id,credential_id,staff_id,previous_id) REFERENCES credentials(facility_id,credential_id,staff_id,id),
  FOREIGN KEY(facility_id,staff_id) REFERENCES staff(facility_id,id), FOREIGN KEY(facility_id,external_reviewer_id) REFERENCES external_clinical_reviewers(facility_id,id),
  CHECK((version=1)=(previous_id IS NULL)), CHECK(previous_id IS DISTINCT FROM id)
);
CREATE TABLE capability_decisions (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL CHECK(schema_version=4),
  created_by text NOT NULL, created_on timestamptz NOT NULL, device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  capability_id text NOT NULL, version integer NOT NULL CHECK(version>0), previous_id text, staff_id text NOT NULL, scope jsonb NOT NULL,
  starts_at timestamptz NOT NULL, ends_at timestamptz CHECK(ends_at>starts_at), decision text NOT NULL CHECK(decision IN ('approve','reject','restrict','suspend','revoke')),
  credential_revision_ids jsonb NOT NULL, supervisor_id text, independent_check boolean NOT NULL, reason text NOT NULL, external_reviewer_id text,
  UNIQUE(facility_id,id), UNIQUE(facility_id,capability_id,version), UNIQUE(facility_id,capability_id,staff_id,id),
  FOREIGN KEY(facility_id,capability_id,staff_id,previous_id) REFERENCES capability_decisions(facility_id,capability_id,staff_id,id),
  FOREIGN KEY(facility_id,staff_id) REFERENCES staff(facility_id,id), FOREIGN KEY(facility_id,supervisor_id) REFERENCES staff(facility_id,id),
  FOREIGN KEY(facility_id,external_reviewer_id) REFERENCES external_clinical_reviewers(facility_id,id),
  CHECK((version=1)=(previous_id IS NULL)), CHECK(previous_id IS DISTINCT FROM id), CHECK(created_by<>staff_id AND supervisor_id IS DISTINCT FROM staff_id)
);
CREATE TABLE reviewer_delegations (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL CHECK(schema_version=4),
  created_by text NOT NULL, created_on timestamptz NOT NULL, device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  delegation_id text NOT NULL, version integer NOT NULL CHECK(version>0), previous_id text, staff_id text NOT NULL, scopes jsonb NOT NULL,
  starts_at timestamptz NOT NULL, ends_at timestamptz CHECK(ends_at>starts_at), decision text NOT NULL CHECK(decision IN ('approve','revoke')), reason text NOT NULL,
  UNIQUE(facility_id,id), UNIQUE(facility_id,delegation_id,version), UNIQUE(facility_id,delegation_id,staff_id,id),
  FOREIGN KEY(facility_id,delegation_id,staff_id,previous_id) REFERENCES reviewer_delegations(facility_id,delegation_id,staff_id,id),
  FOREIGN KEY(facility_id,staff_id) REFERENCES staff(facility_id,id), CHECK(created_by<>staff_id), CHECK((version=1)=(previous_id IS NULL)), CHECK(previous_id IS DISTINCT FROM id)
);
CREATE TABLE clinical_authority_bootstraps (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL CHECK(schema_version=4),
  created_by text NOT NULL CHECK(created_by='system'), created_on timestamptz NOT NULL, device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  bootstrap_id text NOT NULL, version integer NOT NULL CHECK(version>0), previous_id text, decision text NOT NULL CHECK(decision IN ('approve','revoke')),
  staff_id text NOT NULL, scopes jsonb NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
  governance_reference text NOT NULL, authorized_by text NOT NULL, reason text NOT NULL,
  UNIQUE(facility_id,id), UNIQUE(facility_id,bootstrap_id,version), UNIQUE(facility_id,bootstrap_id,staff_id,id),
  FOREIGN KEY(facility_id,bootstrap_id,staff_id,previous_id) REFERENCES clinical_authority_bootstraps(facility_id,bootstrap_id,staff_id,id),
  FOREIGN KEY(facility_id,staff_id) REFERENCES staff(facility_id,id), CHECK((version=1)=(previous_id IS NULL)), CHECK(previous_id IS DISTINCT FROM id)
);
CREATE TABLE authority_snapshots (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL CHECK(schema_version=4),
  created_by text NOT NULL CHECK(created_by='system'), created_on timestamptz NOT NULL, device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  staff_id text NOT NULL, revision integer NOT NULL CHECK(revision>0), policy_version integer NOT NULL CHECK(policy_version>=10),
  issued_on timestamptz NOT NULL, expires_on timestamptz NOT NULL CHECK(expires_on>issued_on AND expires_on<=issued_on+interval '7 days'),
  grants jsonb NOT NULL, review_scopes jsonb NOT NULL, source_decision_ids jsonb NOT NULL, key_id text NOT NULL, signature text NOT NULL,
  is_current boolean NOT NULL DEFAULT true, UNIQUE(facility_id,id), UNIQUE(facility_id,staff_id,revision), FOREIGN KEY(facility_id,staff_id) REFERENCES staff(facility_id,id)
);
CREATE UNIQUE INDEX authority_current_worker ON authority_snapshots(facility_id,staff_id) WHERE is_current;
CREATE TABLE staff_assignments (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL CHECK(schema_version=4),
  created_by text NOT NULL, created_on timestamptz NOT NULL, device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  assignment_id text NOT NULL, version integer NOT NULL CHECK(version>0), previous_id text, staff_id text NOT NULL, offering_id text NOT NULL,
  location_ids jsonb NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz CHECK(ends_at>starts_at),
  duty text NOT NULL CHECK(duty IN ('lead','member','supervisor','on_call','support')), required_actions jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('proposed','active','suspended','ended')), supervisor_id text, temporary_cover boolean NOT NULL, covering_assignment_id text, reason text,
  UNIQUE(facility_id,id), UNIQUE(facility_id,assignment_id,version), UNIQUE(facility_id,assignment_id,staff_id,id),
  FOREIGN KEY(facility_id,assignment_id,staff_id,previous_id) REFERENCES staff_assignments(facility_id,assignment_id,staff_id,id),
  FOREIGN KEY(facility_id,staff_id) REFERENCES staff(facility_id,id), FOREIGN KEY(facility_id,supervisor_id) REFERENCES staff(facility_id,id),
  FOREIGN KEY(facility_id,offering_id) REFERENCES service_offerings(facility_id,id), CHECK((version=1)=(previous_id IS NULL)), CHECK(previous_id IS DISTINCT FROM id), CHECK(supervisor_id IS DISTINCT FROM staff_id)
);
CREATE TABLE service_sessions (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL CHECK(schema_version=4),
  created_by text NOT NULL, created_on timestamptz NOT NULL, device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  session_id text NOT NULL, version integer NOT NULL CHECK(version>0), previous_id text, offering_id text NOT NULL,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(ends_at>starts_at), time_zone text NOT NULL,
  status text NOT NULL CHECK(status IN ('draft','published','cancelled')), series_id text, participants jsonb NOT NULL, resources jsonb NOT NULL,
  max_appointments integer CHECK(max_appointments>0), roster_shift_ids jsonb NOT NULL, reason text,
  UNIQUE(facility_id,id), UNIQUE(facility_id,session_id,version), UNIQUE(facility_id,session_id,id),
  FOREIGN KEY(facility_id,session_id,previous_id) REFERENCES service_sessions(facility_id,session_id,id),
  FOREIGN KEY(facility_id,offering_id) REFERENCES service_offerings(facility_id,id), CHECK((version=1)=(previous_id IS NULL)), CHECK(previous_id IS DISTINCT FROM id)
);
CREATE TABLE session_events (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL CHECK(schema_version=4),
  created_by text NOT NULL, created_on timestamptz NOT NULL, device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  offering_id text NOT NULL, session_id text, previous_id text, action text NOT NULL CHECK(action IN ('open','pause','resume','close')), observed_on timestamptz NOT NULL, reason text,
  UNIQUE(facility_id,id), FOREIGN KEY(facility_id,offering_id) REFERENCES service_offerings(facility_id,id), FOREIGN KEY(facility_id,previous_id) REFERENCES session_events(facility_id,id), CHECK(previous_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX intake_event_root ON session_events(facility_id,offering_id,COALESCE(session_id,'')) WHERE previous_id IS NULL;
ALTER TABLE handoffs ADD CONSTRAINT handoffs_facility_id_unique UNIQUE(facility_id,id);
CREATE TABLE work_ownership_events (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL CHECK(schema_version=4),
  created_by text NOT NULL, created_on timestamptz NOT NULL, device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  source_type text NOT NULL CHECK(source_type='handoff'), source_id text NOT NULL, patient_id text NOT NULL, offering_id text NOT NULL, previous_id text,
  action text NOT NULL CHECK(action IN ('claim','offer_transfer','accept_transfer','decline_transfer','release')), owner_staff_id text, recipient_staff_id text, reason text,
  UNIQUE(facility_id,id), FOREIGN KEY(facility_id,source_id) REFERENCES handoffs(facility_id,id), FOREIGN KEY(facility_id,patient_id) REFERENCES patients(facility_id,id),
  FOREIGN KEY(facility_id,offering_id) REFERENCES service_offerings(facility_id,id), FOREIGN KEY(facility_id,previous_id) REFERENCES work_ownership_events(facility_id,id),
  FOREIGN KEY(facility_id,owner_staff_id) REFERENCES staff(facility_id,id), FOREIGN KEY(facility_id,recipient_staff_id) REFERENCES staff(facility_id,id), CHECK(previous_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX ownership_event_root ON work_ownership_events(facility_id,source_type,source_id) WHERE previous_id IS NULL;
ALTER TABLE appointments ADD CONSTRAINT appointments_facility_id_unique UNIQUE(facility_id,id);
CREATE TABLE appointment_reservations (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), schema_version integer NOT NULL CHECK(schema_version=4),
  created_by text NOT NULL CHECK(created_by='system'), created_on timestamptz NOT NULL, device_id text NOT NULL REFERENCES devices(id), updated_by text, updated_on timestamptz,
  appointment_id text NOT NULL, patient_id text NOT NULL, offering_id text NOT NULL, allocation_fingerprint text NOT NULL,
  status text NOT NULL CHECK(status IN ('accepted','conflict','released')), revision integer NOT NULL CHECK(revision>0), reason text,
  UNIQUE(facility_id,id), UNIQUE(facility_id,appointment_id,revision), FOREIGN KEY(facility_id,appointment_id) REFERENCES appointments(facility_id,id),
  FOREIGN KEY(facility_id,patient_id) REFERENCES patients(facility_id,id), FOREIGN KEY(facility_id,offering_id) REFERENCES service_offerings(facility_id,id)
);

-- Public keys are retained for verification of historical proof across key rotation; no private key is stored here.
CREATE TABLE workforce_signing_keys (id text PRIMARY KEY, public_jwk jsonb NOT NULL, trusted boolean NOT NULL DEFAULT true, created_on timestamptz NOT NULL DEFAULT now());
CREATE TABLE workforce_client_versions (
  device_id text PRIMARY KEY, facility_id text NOT NULL, contract_version integer NOT NULL, schema_version integer NOT NULL, policy_version integer NOT NULL,
  pending_mutation_count integer NOT NULL CHECK(pending_mutation_count>=0), recorded_on timestamptz NOT NULL,
  FOREIGN KEY(facility_id,device_id) REFERENCES devices(facility_id,id)
);
CREATE TABLE workforce_migration_reviews (facility_id text NOT NULL REFERENCES facilities(id), revision integer NOT NULL CHECK(revision>0), inventory jsonb NOT NULL, reviewed_by text NOT NULL, reviewed_on timestamptz NOT NULL, PRIMARY KEY(facility_id,revision));
CREATE TRIGGER workforce_migration_reviews_immutable BEFORE UPDATE OR DELETE ON workforce_migration_reviews FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
CREATE TABLE workforce_operator_commands (id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), payload_hash text NOT NULL, operator text NOT NULL, recorded_on timestamptz NOT NULL DEFAULT now());
CREATE TABLE workforce_historical_reviews (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), rejection_id text NOT NULL REFERENCES sync_rejections(id),
  payload_hash text NOT NULL, reviewed_by text NOT NULL, reason text NOT NULL, reviewed_on timestamptz NOT NULL, expires_on timestamptz NOT NULL,
  FOREIGN KEY(facility_id,reviewed_by) REFERENCES staff(facility_id,id)
);
CREATE TABLE workforce_private_sessions (
  token_hash text PRIMARY KEY, facility_id text NOT NULL, staff_id text NOT NULL, device_id text NOT NULL REFERENCES devices(id), expires_on timestamptz NOT NULL,
  email text NOT NULL, FOREIGN KEY(facility_id,staff_id) REFERENCES staff(facility_id,id)
);
ALTER TABLE email_verifications DROP CONSTRAINT email_verifications_purpose_check;
ALTER TABLE email_verifications ADD CHECK(purpose IN ('registration','staff_email','staff_email_current','workforce_access'));

-- Database guards complement, rather than replace, the shared validation and serialized write boundary.
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['credentials','capability_decisions','reviewer_delegations','clinical_authority_bootstraps','staff_assignments','service_sessions','session_events','work_ownership_events','appointment_reservations'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change()',table_name||'_immutable',table_name);
    IF table_name <> 'appointment_reservations' THEN
      EXECUTE format('CREATE UNIQUE INDEX %I ON %I(previous_id) WHERE previous_id IS NOT NULL',table_name||'_successor',table_name);
    END IF;
  END LOOP;
END $$;
CREATE FUNCTION protect_authority_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'is_current') IS DISTINCT FROM (to_jsonb(OLD)-'is_current') OR (NOT OLD.is_current AND NEW.is_current) THEN
    RAISE EXCEPTION 'Authority history is immutable' USING ERRCODE='insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER authority_history_immutable BEFORE UPDATE OR DELETE ON authority_snapshots FOR EACH ROW EXECUTE FUNCTION protect_authority_snapshot();
-- Restricted evidence/governance tables deliberately stay OUT of the publication.
ALTER PUBLICATION powersync ADD TABLE locations,service_definitions,service_offerings,practitioner_profiles,authority_snapshots,staff_assignments,service_sessions,session_events,work_ownership_events,appointment_reservations;
