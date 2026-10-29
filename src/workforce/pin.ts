import { mayApproveWorkforcePin, workforceEnforcementActive, type Facility, type PinSetupCode, type Staff } from '#shared';
import type { Tx } from '../db/client.ts';
import { findRecord } from '../db/records.ts';
import type { DeviceIdentity } from '../devices/credentials.ts';
import { deriveAuthority, serverContext } from './authority.ts';
export const validatePinCodeClaim = async (tx: Tx, code: PinSetupCode, identity: DeviceIdentity, now: number): Promise<string | undefined> => {
  const facility = await findRecord<Facility>(tx, 'facility', identity.facilityId);
  if (!workforceEnforcementActive(facility?.workforcePolicy, now) || code.createdBy === 'system')
    return undefined;
  const actor = await findRecord<Staff>(tx, 'staff', code.createdBy), target = await findRecord<Staff>(tx, 'staff', code.staffId);
  if (!actor || !target || actor.facilityId !== identity.facilityId || target.facilityId !== identity.facilityId)
    return 'PIN approval must belong to this facility';
  return mayApproveWorkforcePin(actor, serverContext(actor, identity.deviceId, now), await deriveAuthority(tx, actor, identity.deviceId, now), target, (await deriveAuthority(tx, target, identity.deviceId, now)).snapshot, now) ? undefined : 'PIN issuer no longer holds the required independent clinical-review scope';
};
