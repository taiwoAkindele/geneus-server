import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DOCUMENT_MAX_BYTES,DocumentMime,documentContentType,staffDocumentAccess,staffPermissions } from '#shared';
import type { FastifyInstance,FastifyRequest,FastifyReply } from 'fastify';
import type { Sql } from '../db/client.ts';
import { authenticateDevice } from '../auth/deviceAuth.ts';
import { findStaffInFacility } from '../auth/staffAuthorization.ts';
const header=(value:string|string[]|undefined)=>typeof value==='string'?value:undefined;
const fileId=z.string().trim().min(1).max(200);
export const registerDocumentRoutes=(app:FastifyInstance,sql:Sql):void=>{
  app.addContentTypeParser('application/octet-stream',{parseAs:'buffer',bodyLimit:DOCUMENT_MAX_BYTES},(_request,body,done)=>done(null,body));
  /** Same device-delegated staff attribution as existing offline uploads; no new email/PIN gate. */
  const actor=async(request:FastifyRequest,reply:FastifyReply,write=false)=>{
    const device=await authenticateDevice(sql,request,reply);if(!device)return;
    const id=header(request.headers['x-actor-staff-id']);
    const staff=id&&id.length<=200?await findStaffInFacility(sql,device.facilityId,id):undefined;
    if(!staff?.active || !staffDocumentAccess(staff) || (write&&!staffPermissions(staff).includes('encounter:record'))){reply.code(403).send({error:'forbidden',message:'Your current Clinical Services access does not allow this document action'});return;}
    return {...device,actorId:staff.id};
  };
  app.post<{Params:{id:string}}>('/documents/files/:id',{bodyLimit:DOCUMENT_MAX_BYTES},async(request,reply)=>{
    const who=await actor(request,reply,true);if(!who)return;
    const id=fileId.safeParse(request.params.id),mime=DocumentMime.safeParse(header(request.headers['x-file-mime']));
    const body=request.body;
    if(!id.success || !mime.success || !Buffer.isBuffer(body) || !body.length || body.length>DOCUMENT_MAX_BYTES)return reply.code(400).send({error:'invalid_file',message:'Choose a PDF, JPEG, PNG or WebP file up to 10 MB'});
    const sha256=createHash('sha256').update(body).digest('hex');
    if(documentContentType(body)!==mime.data || sha256!==header(request.headers['x-file-sha256']))return reply.code(400).send({error:'invalid_file',message:'The file content, type or checksum does not match the selected document'});
    const outcome=await sql.begin(async(tx)=>{
      await tx`SELECT id FROM facilities WHERE id=${who.facilityId} FOR UPDATE`;
      const [existing]=await tx`SELECT sha256,mime_type,byte_size FROM document_files WHERE facility_id=${who.facilityId} AND id=${id.data}`;
      if(existing)return existing.sha256===sha256 && existing.mime_type===mime.data && Number(existing.byte_size)===body.length?'duplicate':'conflict';
      await tx`INSERT INTO document_files(facility_id,id,mime_type,byte_size,sha256,content,uploaded_by,device_id) VALUES(${who.facilityId},${id.data},${mime.data},${body.length},${sha256},${body},${who.actorId},${who.deviceId})`;
      return 'created';
    });
    if(outcome==='conflict')return reply.code(409).send({error:'file_identity_conflict',message:'A different file already uses this identity. The original is retained'});
    return reply.code(outcome==='created'?201:200).send({id:id.data,sha256,byteSize:body.length,mimeType:mime.data});
  });
  app.get<{Params:{id:string}}>('/documents/files/:id',async(request,reply)=>{
    const who=await actor(request,reply);if(!who)return;
    const id=fileId.safeParse(request.params.id);if(!id.success)return reply.code(400).send({error:'invalid_request',message:'Choose a document file'});
    const [file]=await sql`SELECT f.mime_type,f.sha256,f.content FROM document_files f WHERE f.facility_id=${who.facilityId} AND f.id=${id.data} AND (
      f.uploaded_by=${who.actorId}
      OR EXISTS(SELECT 1 FROM library_documents d WHERE d.facility_id=f.facility_id AND d.file_id=f.id)
      OR EXISTS(SELECT 1 FROM visit_documents d WHERE d.facility_id=f.facility_id AND d.file_id=f.id)
      OR EXISTS(SELECT 1 FROM sync_rejections r WHERE r.facility_id=f.facility_id AND r.entity_type IN ('library_document','visit_document') AND r.refused_record->'file'->>'id'=f.id)
    )`;
    if(!file)return reply.code(404).send({error:'not_found',message:'This document file is unavailable in the current hospital'});
    return reply.type(file.mime_type as string).header('content-disposition','inline').header('etag',`"${file.sha256}"`).send(file.content);
  });
};
