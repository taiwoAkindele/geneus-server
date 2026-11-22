import type { Tx } from '../db/client.ts';

export class SourceCapacityRefusal extends Error {
  statusCode=409;
  code='source_capacity_exceeded';
}

/** One receipt, two existing recognition workflows. Refunds are outgoing money, not new receipt capacity. */
export const sourceCapacity=async(tx:Tx,facilityId:string,id:string)=>{
  const [source]=await tx`SELECT * FROM incoming_transfers WHERE facility_id=${facilityId} AND id=${id} FOR UPDATE`;
  if(!source)throw new SourceCapacityRefusal('Choose a verified incoming receipt in this hospital');
  const [patients]=await tx`SELECT COALESCE(SUM(CASE WHEN p.reverses IS NULL THEN p.amount_minor ELSE -p.amount_minor END),0) AS used
    FROM payments p LEFT JOIN payments original ON original.id=p.reverses AND original.facility_id=p.facility_id
    WHERE p.facility_id=${facilityId} AND p.method<>'waiver' AND
    (COALESCE(original.incoming_transfer_id,p.incoming_transfer_id)=${id} OR
     (COALESCE(original.incoming_transfer_id,p.incoming_transfer_id) IS NULL AND p.method='transfer' AND p.currency=${source.currency}
      AND lower(btrim(COALESCE(original.reference,p.reference)))=lower(btrim(${source.provider_reference}))))`;
  // Exact receipt identifiers also reserve legacy recognition, without rewriting old remittances.
  const [payers]=await tx`SELECT COALESCE(SUM(r.amount_minor),0) AS used FROM insurance_remittances r
    WHERE r.facility_id=${facilityId} AND NOT EXISTS(SELECT 1 FROM insurance_remittance_reversals v WHERE v.remittance_id=r.id)
    AND (r.incoming_transfer_id=${id} OR (r.incoming_transfer_id IS NULL AND r.method='transfer' AND r.currency=${source.currency}
      AND lower(btrim(r.reference))=lower(btrim(${source.provider_reference}))))`;
  const patientMinor=Number(patients.used),payerMinor=Number(payers.used),amountMinor=Number(source.amount_minor);
  return {source,amountMinor,patientMinor,payerMinor,availableMinor:amountMinor-patientMinor-payerMinor};
};

/** `allowTest`: only for a checkout paid while the hospital itself is in test mode, so the whole flow can be tried. */
export const reserveSource=async(tx:Tx,facilityId:string,id:string,amountMinor:number,currency:string,options:{allowTest?:boolean}={})=>{
  const capacity=await sourceCapacity(tx,facilityId,id);
  if(capacity.source.mode!=='live'&&!options.allowTest)throw new SourceCapacityRefusal('Test receipts cannot settle real patient or payer obligations');
  if(capacity.source.currency!==currency)throw new SourceCapacityRefusal('The receipt and transaction currencies must agree');
  if(amountMinor<=0 || !Number.isSafeInteger(amountMinor) || amountMinor>capacity.availableMinor)
    throw new SourceCapacityRefusal('This verified receipt has insufficient unrecognized money across patient and insurer collections');
  return capacity;
};
