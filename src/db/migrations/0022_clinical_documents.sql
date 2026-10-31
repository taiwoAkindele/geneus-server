-- Files remain in the authoritative PostgreSQL backup. Only small metadata rides PowerSync.
CREATE TABLE document_files (
  facility_id text NOT NULL REFERENCES facilities(id), id text NOT NULL,
  mime_type text NOT NULL CHECK(mime_type IN ('application/pdf','image/jpeg','image/png','image/webp')),
  byte_size integer NOT NULL CHECK(byte_size > 0 AND byte_size <= 10485760),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), content bytea NOT NULL,
  uploaded_by text NOT NULL, device_id text NOT NULL REFERENCES devices(id), created_on timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(facility_id,id), CHECK(octet_length(content)=byte_size)
);
CREATE TRIGGER document_files_immutable BEFORE UPDATE OR DELETE ON document_files FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

CREATE TABLE library_documents (
  id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id),
  schema_version integer NOT NULL CHECK(schema_version>0),created_by text NOT NULL,created_on timestamptz NOT NULL,
  device_id text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,updated_by text,updated_on timestamptz,
  document_id text NOT NULL,previous_id text,version integer NOT NULL CHECK(version>0),title text NOT NULL,
  file jsonb NOT NULL CHECK(jsonb_typeof(file)='object'), file_id text GENERATED ALWAYS AS (file->>'id') STORED,
  actor_role text NOT NULL,action text NOT NULL CHECK(action IN ('upload','replace','rename','archive','restore')),archived boolean NOT NULL,
  UNIQUE(facility_id,id),UNIQUE(facility_id,document_id,id),UNIQUE(facility_id,document_id,version),
  FOREIGN KEY(facility_id,file_id) REFERENCES document_files(facility_id,id),
  FOREIGN KEY(facility_id,document_id,previous_id) REFERENCES library_documents(facility_id,document_id,id),
  CHECK(previous_id IS DISTINCT FROM id),CHECK((version=1)=(previous_id IS NULL)),
  CHECK(previous_id IS NOT NULL OR (document_id=id AND action='upload' AND NOT archived))
);
CREATE UNIQUE INDEX library_document_successor ON library_documents(previous_id) WHERE previous_id IS NOT NULL;
CREATE INDEX library_document_versions ON library_documents(facility_id,document_id);
CREATE TRIGGER library_documents_immutable BEFORE UPDATE OR DELETE ON library_documents FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();

CREATE TABLE visit_documents (
  id text PRIMARY KEY,facility_id text NOT NULL REFERENCES facilities(id),
  schema_version integer NOT NULL CHECK(schema_version>0),created_by text NOT NULL,created_on timestamptz NOT NULL,
  device_id text NOT NULL REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED,updated_by text,updated_on timestamptz,
  document_id text NOT NULL,previous_id text,version integer NOT NULL CHECK(version>0),title text NOT NULL,
  file jsonb NOT NULL CHECK(jsonb_typeof(file)='object'),file_id text GENERATED ALWAYS AS (file->>'id') STORED,
  actor_role text NOT NULL,patient_id text NOT NULL,encounter_id text NOT NULL,admission_id text NOT NULL,admission_event_id text NOT NULL,
  template_version_id text,action text NOT NULL CHECK(action IN ('attach','signed_copy','status')),
  signature_status text NOT NULL CHECK(signature_status IN ('unsigned','awaiting_signed_copy','signed','not_required')),
  signature_review jsonb,change_reason text,
  UNIQUE(facility_id,document_id,version),
  UNIQUE(facility_id,document_id,patient_id,encounter_id,admission_id,id),
  FOREIGN KEY(facility_id,file_id) REFERENCES document_files(facility_id,id),
  FOREIGN KEY(facility_id,encounter_id,patient_id) REFERENCES encounters(facility_id,id,patient_id),
  FOREIGN KEY(facility_id,admission_event_id) REFERENCES inpatient_events(facility_id,id),
  FOREIGN KEY(facility_id,template_version_id) REFERENCES library_documents(facility_id,id),
  FOREIGN KEY(facility_id,document_id,patient_id,encounter_id,admission_id,previous_id)
    REFERENCES visit_documents(facility_id,document_id,patient_id,encounter_id,admission_id,id),
  CHECK(previous_id IS DISTINCT FROM id),CHECK((version=1)=(previous_id IS NULL)),
  CHECK(previous_id IS NOT NULL OR (document_id=id AND action='attach')),
  CHECK((signature_status='signed')=(signature_review IS NOT NULL))
);
CREATE UNIQUE INDEX visit_document_successor ON visit_documents(previous_id) WHERE previous_id IS NOT NULL;
CREATE INDEX visit_document_visit ON visit_documents(facility_id,encounter_id);
CREATE INDEX visit_document_patient ON visit_documents(facility_id,patient_id);
CREATE INDEX visit_document_versions ON visit_documents(facility_id,document_id);
CREATE TRIGGER visit_documents_immutable BEFORE UPDATE OR DELETE ON visit_documents FOR EACH ROW EXECUTE FUNCTION forbid_clinical_change();
ALTER PUBLICATION powersync ADD TABLE library_documents,visit_documents;
