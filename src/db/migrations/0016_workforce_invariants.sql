-- Nested structured references have the same facility boundary as ordinary composite foreign keys.
CREATE FUNCTION require_workforce_reference(scope_id text, target_table text, target_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE present boolean; BEGIN
  IF target_id IS NULL THEN RETURN; END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE facility_id=$1 AND id=$2)',target_table) INTO present USING scope_id,target_id;
  IF NOT present THEN RAISE EXCEPTION 'Missing facility-scoped workforce reference' USING ERRCODE='foreign_key_violation'; END IF;
END $$;
CREATE FUNCTION check_workforce_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v jsonb:=to_jsonb(NEW); item jsonb; scopes jsonb:='[]'; context jsonb; present boolean; BEGIN
  IF v ? 'location_ids' THEN
    FOR item IN SELECT value FROM jsonb_array_elements(v->'location_ids') LOOP PERFORM require_workforce_reference(NEW.facility_id,'locations',item#>>'{}'); END LOOP;
  END IF;
  IF TG_TABLE_NAME='capability_decisions' THEN
    FOR item IN SELECT value FROM jsonb_array_elements(NEW.credential_revision_ids) LOOP
      PERFORM require_workforce_reference(NEW.facility_id,'credentials',item#>>'{}');
      IF NOT EXISTS(SELECT 1 FROM credentials WHERE facility_id=NEW.facility_id AND id=item#>>'{}' AND staff_id=NEW.staff_id) THEN RAISE EXCEPTION 'Credential subject mismatch' USING ERRCODE='foreign_key_violation'; END IF;
    END LOOP;
  END IF;
  IF TG_TABLE_NAME='service_sessions' THEN
    FOR item IN SELECT value FROM jsonb_array_elements(NEW.participants) LOOP
      PERFORM require_workforce_reference(NEW.facility_id,'staff',item->>'staffId');
      IF NOT EXISTS(SELECT 1 FROM staff_assignments WHERE facility_id=NEW.facility_id AND assignment_id=item->>'assignmentId' AND staff_id=item->>'staffId' AND offering_id=NEW.offering_id) THEN RAISE EXCEPTION 'Session assignment subject/service mismatch' USING ERRCODE='foreign_key_violation'; END IF;
    END LOOP;
    FOR item IN SELECT value FROM jsonb_array_elements(NEW.resources) LOOP PERFORM require_workforce_reference(NEW.facility_id,'locations',item->>'locationId'); END LOOP;
    FOR item IN SELECT value FROM jsonb_array_elements(NEW.roster_shift_ids) LOOP PERFORM require_workforce_reference(NEW.facility_id,'roster_shifts',item#>>'{}'); END LOOP;
  END IF;
  IF v->'scope' IS NOT NULL THEN scopes:=scopes || jsonb_build_array(v->'scope'); END IF;
  IF v->'scopes' IS NOT NULL THEN scopes:=scopes || (v->'scopes'); END IF;
  IF TG_TABLE_NAME='authority_snapshots' THEN
    FOR item IN SELECT value FROM jsonb_array_elements(NEW.grants) LOOP
      scopes:=scopes || jsonb_build_array(item->'scope');
      IF NOT EXISTS(SELECT 1 FROM capability_decisions WHERE facility_id=NEW.facility_id AND id=item->>'decisionId' AND staff_id=NEW.staff_id) THEN RAISE EXCEPTION 'Authority decision subject mismatch' USING ERRCODE='foreign_key_violation'; END IF;
    END LOOP;
    FOR item IN SELECT value FROM jsonb_array_elements(NEW.review_scopes) LOOP
      scopes:=scopes || jsonb_build_array(item->'scope');
      SELECT EXISTS(SELECT 1 FROM reviewer_delegations WHERE facility_id=NEW.facility_id AND id=item->>'decisionId' AND staff_id=NEW.staff_id
        UNION ALL SELECT 1 FROM clinical_authority_bootstraps WHERE facility_id=NEW.facility_id AND id=item->>'decisionId' AND staff_id=NEW.staff_id) INTO present;
      IF NOT present THEN RAISE EXCEPTION 'Reviewer authority subject mismatch' USING ERRCODE='foreign_key_violation'; END IF;
    END LOOP;
  END IF;
  FOR context IN SELECT value FROM jsonb_array_elements(scopes) LOOP
    IF context->>'kind'='offerings' THEN FOR item IN SELECT value FROM jsonb_array_elements(context->'offeringIds') LOOP PERFORM require_workforce_reference(NEW.facility_id,'service_offerings',item#>>'{}'); END LOOP; END IF;
  END LOOP;
  IF TG_TABLE_NAME='appointments' AND v->>'allocation' IS NOT NULL THEN
    context:=NEW.allocation;
    PERFORM require_workforce_reference(NEW.facility_id,'service_offerings',context->>'offeringId');
    PERFORM require_workforce_reference(NEW.facility_id,'staff',context->>'staffId');
    IF context->>'sessionId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM service_sessions WHERE facility_id=NEW.facility_id AND session_id=context->>'sessionId' AND offering_id=context->>'offeringId') THEN RAISE EXCEPTION 'Booking session mismatch' USING ERRCODE='foreign_key_violation'; END IF;
    IF context->>'assignmentId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM staff_assignments WHERE facility_id=NEW.facility_id AND assignment_id=context->>'assignmentId' AND staff_id=context->>'staffId' AND offering_id=context->>'offeringId') THEN RAISE EXCEPTION 'Booking assignment mismatch' USING ERRCODE='foreign_key_violation'; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(context->'locations') LOOP PERFORM require_workforce_reference(NEW.facility_id,'locations',item->>'locationId'); END LOOP;
  END IF;
  IF TG_TABLE_NAME IN ('clinical_events','encounter_entries') AND v->>'actor_context' IS NOT NULL THEN
    context:=NEW.actor_context;
    PERFORM require_workforce_reference(NEW.facility_id,'service_offerings',context->>'offeringId');
    PERFORM require_workforce_reference(NEW.facility_id,'locations',context->>'locationId');
    PERFORM require_workforce_reference(NEW.facility_id,'staff_assignments',context->>'assignmentRevisionId');
    IF NOT EXISTS(SELECT 1 FROM authority_snapshots WHERE facility_id=NEW.facility_id AND id=context->>'authoritySnapshotId' AND staff_id=NEW.created_by) THEN RAISE EXCEPTION 'Clinical authority attribution mismatch' USING ERRCODE='foreign_key_violation'; END IF;
  END IF;
  IF TG_TABLE_NAME='work_ownership_events' AND NOT EXISTS(SELECT 1 FROM handoffs WHERE facility_id=NEW.facility_id AND id=v->>'source_id' AND patient_id=v->>'patient_id') THEN RAISE EXCEPTION 'Owned instruction patient mismatch' USING ERRCODE='foreign_key_violation'; END IF;
  IF TG_TABLE_NAME='appointment_reservations' AND NOT EXISTS(SELECT 1 FROM appointments WHERE facility_id=NEW.facility_id AND id=v->>'appointment_id' AND patient_id=v->>'patient_id') THEN RAISE EXCEPTION 'Reservation patient mismatch' USING ERRCODE='foreign_key_violation'; END IF;
  IF TG_TABLE_NAME='session_events' AND v->>'session_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM service_sessions WHERE facility_id=NEW.facility_id AND session_id=v->>'session_id' AND offering_id=v->>'offering_id') THEN RAISE EXCEPTION 'Intake session mismatch' USING ERRCODE='foreign_key_violation'; END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['service_offerings','staff_assignments','capability_decisions','reviewer_delegations','clinical_authority_bootstraps','external_clinical_reviewers','authority_snapshots','service_sessions','appointments','encounter_entries','clinical_events','work_ownership_events','appointment_reservations','session_events'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION check_workforce_references()',name||'_scope_references',name);
  END LOOP;
END $$;

CREATE FUNCTION check_workforce_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE predecessor jsonb; value jsonb:=to_jsonb(NEW); key text; BEGIN
  IF NEW.previous_id IS NULL THEN RETURN NEW; END IF;
  EXECUTE format('SELECT to_jsonb(t) FROM %I t WHERE facility_id=$1 AND id=$2',TG_TABLE_NAME) INTO predecessor USING NEW.facility_id,NEW.previous_id;
  IF predecessor IS NULL THEN RAISE EXCEPTION 'Revision predecessor is missing' USING ERRCODE='foreign_key_violation'; END IF;
  IF value ? 'version' AND (value->>'version')::integer<>(predecessor->>'version')::integer+1 THEN RAISE EXCEPTION 'Revision must increment once' USING ERRCODE='check_violation'; END IF;
  IF TG_TABLE_NAME IN ('session_events','work_ownership_events') THEN
    FOREACH key IN ARRAY ARRAY['offering_id','session_id','source_id','source_type','patient_id'] LOOP
      IF value ? key AND value->key IS DISTINCT FROM predecessor->key THEN RAISE EXCEPTION 'Causal event stream cannot change' USING ERRCODE='check_violation'; END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['credentials','capability_decisions','reviewer_delegations','clinical_authority_bootstraps','staff_assignments','service_sessions','session_events','work_ownership_events'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION check_workforce_revision()',name||'_revision_sequence',name);
  END LOOP;
END $$;
CREATE FUNCTION check_workforce_tree() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_id text:=NEW.parent_id; parent_active boolean; visited text[]:=ARRAY[NEW.id]; BEGIN
  WHILE next_id IS NOT NULL LOOP
    IF next_id=ANY(visited) THEN RAISE EXCEPTION 'Organization/location cycle' USING ERRCODE='check_violation'; END IF;
    visited:=array_append(visited,next_id);
    EXECUTE format('SELECT parent_id,active FROM %I WHERE facility_id=$1 AND id=$2',TG_TABLE_NAME) INTO next_id,parent_active USING NEW.facility_id,next_id;
    IF NEW.active AND parent_active=false THEN RAISE EXCEPTION 'Active child beneath retired ancestor' USING ERRCODE='check_violation'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER units_tree_guard BEFORE INSERT OR UPDATE ON units FOR EACH ROW EXECUTE FUNCTION check_workforce_tree();
CREATE TRIGGER locations_tree_guard BEFORE INSERT OR UPDATE ON locations FOR EACH ROW EXECUTE FUNCTION check_workforce_tree();
CREATE FUNCTION check_workforce_configuration_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='INSERT' AND NEW.revision IS NOT NULL AND NEW.revision<>1 THEN RAISE EXCEPTION 'Configuration starts at revision one' USING ERRCODE='check_violation'; END IF;
  IF TG_OP='UPDATE' AND NEW.revision IS NOT NULL AND NEW.revision<>COALESCE(OLD.revision,1)+1 THEN RAISE EXCEPTION 'Configuration revision must increment once' USING ERRCODE='check_violation'; END IF;
  IF TG_OP='UPDATE' AND OLD.revision IS NOT NULL AND NEW.revision IS NULL THEN RAISE EXCEPTION 'Configuration revision cannot be removed' USING ERRCODE='check_violation'; END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['units','locations','service_definitions','service_offerings','practitioner_profiles','external_clinical_reviewers','billing_departments'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION check_workforce_configuration_revision()',name||'_configuration_cas',name);
  END LOOP;
END $$;
CREATE UNIQUE INDEX locations_active_sibling_name ON locations(facility_id,COALESCE(parent_id,''),lower(regexp_replace(btrim(normalize(name,NFKC)),'\s+',' ','g'))) WHERE active;
CREATE UNIQUE INDEX units_reviewed_active_sibling_name ON units(facility_id,COALESCE(parent_id,''),lower(regexp_replace(btrim(normalize(name,NFKC)),'\s+',' ','g'))) WHERE active AND kind IS NOT NULL;
CREATE INDEX assignments_facility_staff ON staff_assignments(facility_id,staff_id);
CREATE INDEX sessions_facility_interval ON service_sessions(facility_id,starts_at,ends_at);
CREATE INDEX decisions_facility_staff ON capability_decisions(facility_id,staff_id);
CREATE INDEX ownership_source ON work_ownership_events(facility_id,source_id);
CREATE INDEX reservations_booking ON appointment_reservations(facility_id,appointment_id,revision DESC);
CREATE INDEX authority_due ON authority_snapshots(expires_on) WHERE is_current;
ALTER TABLE authority_snapshots ADD FOREIGN KEY(key_id) REFERENCES workforce_signing_keys(id);
ALTER TABLE units ADD CHECK(kind IS DISTINCT FROM 'department' OR routing_enabled IS DISTINCT FROM true);
ALTER TABLE sync_rejections ADD CHECK(entity_type NOT IN ('credential','capability_decision','reviewer_delegation','clinical_authority_bootstrap','external_clinical_reviewer')
  OR (visibility='restricted' AND visible_to_staff_ids IS NOT NULL AND jsonb_array_length(visible_to_staff_ids)>0));
