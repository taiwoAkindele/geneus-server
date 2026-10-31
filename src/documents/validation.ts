import { libraryDocumentIssues,visitDocumentIssues,type ClinicalDocument,type LibraryDocument,type VisitDocument,type InpatientEvent,type Encounter } from '#shared';
import type { Tx } from '../db/client.ts';
import { fromRow,findRecord } from '../db/records.ts';
export const clinicalDocumentIssues = async (tx:Tx,record:ClinicalDocument):Promise<string[]> => {
  const [file]=await tx`SELECT mime_type,byte_size,sha256 FROM document_files WHERE facility_id=${record.facilityId} AND id=${record.file.id}`;
  if(!file)return ['The document file has not reached this hospital’s server. The retained file and metadata need sync review'];
  if(file.mime_type!==record.file.mimeType || Number(file.byte_size)!==record.file.byteSize || file.sha256!==record.file.sha256)return ['The file metadata does not match the stored document bytes'];
  if(record.type==='library_document'){
    const rows=await tx`SELECT * FROM library_documents WHERE facility_id=${record.facilityId} AND document_id=${record.documentId}`;
    return libraryDocumentIssues(record,rows.map(row=>fromRow<LibraryDocument>('library_document',row)));
  }
  const [rows,admissions,encounter,template]=await Promise.all([
    tx`SELECT * FROM visit_documents WHERE facility_id=${record.facilityId} AND document_id=${record.documentId}`,
    tx`SELECT * FROM inpatient_events WHERE facility_id=${record.facilityId} AND admission_id=${record.admissionId}`,
    findRecord<Encounter>(tx,'encounter',record.encounterId),
    record.templateVersionId?findRecord<LibraryDocument>(tx,'library_document',record.templateVersionId):Promise.resolve(undefined),
  ]);
  const library=template?await tx`SELECT * FROM library_documents WHERE facility_id=${record.facilityId} AND document_id=${template.documentId}`:[];
  return visitDocumentIssues(record,{documents:rows.map(row=>fromRow<VisitDocument>('visit_document',row)),admissions:admissions.map(row=>fromRow<InpatientEvent>('inpatient_event',row)),encounter,library:library.map(row=>fromRow<LibraryDocument>('library_document',row))});
};
