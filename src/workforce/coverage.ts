import { isDeepStrictEqual } from 'node:util';
import { effectiveFacilityRevisions, sessionClinicalCoverageIssues, type FacilityRecords, type ServiceSession } from '#shared';
import type { Sql, Tx } from '../db/client.ts';
import { deriveAuthority, serverContext } from './authority.ts';
/** Planned qualification is evaluated at the relevant occurrence, not inferred from attendance or today's roster. */
export const coverageIssues = async (tx: Sql | Tx, data: FacilityRecords, session: ServiceSession, now: number): Promise<string[]> => {
  if (Date.parse(session.endsAt) <= now)
    return [];
  const at = Math.max(now, Date.parse(session.startsAt)), remaining = { ...session, startsAt: new Date(at).toISOString() };
  const offering = data.offerings.find((o) => o.id === session.offeringId && o.facilityId === session.facilityId);
  if (!offering)
    return ['Published coverage needs an accepted service'];
  const people = [], issues: string[] = [];
  for (const participant of session.participants) {
    const assignments = effectiveFacilityRevisions(data.assignments, at).filter((a) => a.assignmentId === participant.assignmentId && a.staffId === participant.staffId);
    const assignment = assignments.length === 1 ? assignments[0] : undefined, worker = data.staff.find((s) => s.staffId === participant.staffId);
    if (!assignment || !worker) {
      issues.push('Participant needs one effective accepted assignment');
      continue;
    }
    if (assignment.locationIds.length && session.resources.length && !session.resources.some((r) => assignment.locationIds.includes(r.locationId)))
      issues.push('Participant has no permitted place in this occurrence');
    const changes = data.assignments.filter((a) => a.assignmentId === assignment.assignmentId && a.version > assignment.version && Date.parse(a.startsAt) > at && Date.parse(a.startsAt) < Date.parse(session.endsAt));
    if (changes.some((a) => !isDeepStrictEqual([a.status, a.offeringId, a.locationIds, a.requiredActions, a.supervisorId, a.endsAt], [assignment.status, assignment.offeringId, assignment.locationIds, assignment.requiredActions, assignment.supervisorId, assignment.endsAt])))
      issues.push('Split or review coverage around the scheduled assignment change');
    people.push({ staff: worker, assignment, context: serverContext(worker, worker.deviceId, now), proof: await deriveAuthority(tx, worker, worker.deviceId, now, at) });
  }
  return [...issues, ...sessionClinicalCoverageIssues(offering, remaining, people, now)];
};
