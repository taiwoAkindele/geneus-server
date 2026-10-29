import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AssignablePermission, Role, Staff, type Appointment, type UploadMutation } from '#shared';
import { insertRecord, findRecord } from '../src/db/records.ts';
import { addStaff, clientId, envelopeFor, scratchDatabase, type ScratchDatabase } from './postgres.ts';
import { put, setupWorkforce } from './workforceFixtures.ts';
describe('PHC and hospital workforce flows', { timeout: 120000 }, () => {
  let db: ScratchDatabase;
  before(async () => { db = await scratchDatabase(); });
  after(async () => {
    if (db)
      await db.drop();
  });
  it('keeps ownership with the outgoing worker until the named recipient accepts, despite competing offline claims', async () => {
    const f = await setupWorkforce(db.sql);
    try {
      const receiver = await addStaff(db.sql, f.facility, { role: 'nurse' });
      const assignment = { ...f.assignment, id: `assignment:${randomUUID()}:v1`, assignmentId: `assignment:${randomUUID()}`, staffId: receiver.id };
      assert.equal((await f.send([put(assignment, { expectedPreviousId: null })])).applied, 1);
      const instruction = { ...f.env, type: 'handoff', id: `handoff:${randomUUID()}`, patientId: f.patientId, fromUnitId: f.unit.id, toUnitId: f.unit.id, instruction: 'Synthetic service instruction', status: 'pending' };
      assert.equal((await f.send([put(instruction)])).applied, 1);
      const claim = (owner: string) => ({ ...f.env, createdBy: owner, type: 'work_ownership_event', id: `ownership:${randomUUID()}`, sourceType: 'handoff', sourceId: instruction.id, patientId: f.patientId, offeringId: f.offering.id, action: 'claim', ownerStaffId: owner });
      const a = claim(f.worker.id), b = claim(receiver.id), results = await Promise.all([f.send([put(a)]), f.send([put(b)])]);
      assert.equal(results.reduce((n, r) => n + r.applied, 0), 1);
      const [head] = await db.sql`SELECT * FROM work_ownership_events WHERE source_id=${instruction.id}`;
      const next = head.owner_staff_id === f.worker.id ? receiver.id : f.worker.id;
      const offer = { ...claim(head.owner_staff_id as string), id: `ownership:${randomUUID()}`, previousId: head.id, action: 'offer_transfer', recipientStaffId: next, reason: 'Next clinical session' };
      assert.equal((await f.send([put(offer)])).applied, 1);
      assert.equal((await findRecord(db.sql, 'handoff', instruction.id))?.type, 'handoff');
      const bad = { ...claim(head.owner_staff_id as string), previousId: offer.id, action: 'accept_transfer', reason: 'Wrong recipient' };
      assert.ok((await f.send([put(bad)])).rejected.length);
      const accept = { ...claim(next), previousId: offer.id, action: 'accept_transfer', reason: 'Accepted responsibility' };
      assert.equal((await f.send([put(accept)])).applied, 1);
      const source = await findRecord(db.sql, 'handoff', instruction.id);
      assert.equal(source?.type === 'handoff' && source.status, 'pending');
    }
    finally {
      await f.app.close();
    }
  });
  it('respects aggregate room capacity and preserves booked care when a session is cancelled', async () => {
    const f = await setupWorkforce(db.sql);
    try {
      const room: UploadMutation = { clientId: clientId(), op: 'patch', table: 'location', id: f.location.id, expectedRevision: 1, data: { capacity: 2, revision: 2, schemaVersion: 4, updatedBy: f.facility.admin.id, updatedOn: new Date().toISOString() } };
      assert.equal((await f.send([room])).applied, 1);
      const shared = { ...f.session, id: `session:${randomUUID()}`, version: 2, previousId: f.session.id, participants: f.session.participants.map((p) => ({ ...p, commitment: 'shared' })) };
      assert.equal((await f.send([put(shared, { expectedPreviousId: f.session.id })])).applied, 1);
      const second = { ...shared, id: `session:${randomUUID()}`, sessionId: `session:${randomUUID()}`, version: 1, previousId: undefined };
      assert.equal((await f.send([put(second, { expectedPreviousId: null })])).applied, 1);
      const third = { ...second, id: `session:${randomUUID()}`, sessionId: `session:${randomUUID()}` };
      assert.ok((await f.send([put(third, { expectedPreviousId: null })])).rejected.some((r) => r.reason.includes('capacity')));
      const booking = f.booking();
      assert.equal((await f.send([put(booking)])).applied, 1);
      const cancel = { ...shared, id: `session:${randomUUID()}`, version: 3, previousId: shared.id, status: 'cancelled', reason: 'Requires explicit rescheduling' };
      assert.ok((await f.send([put(cancel, { expectedPreviousId: shared.id })])).rejected.length);
      assert.ok(await findRecord(db.sql, 'appointment', booking.id));
    }
    finally {
      await f.app.close();
    }
  });
  it('reschedules atomically, replaces the exact acceptance proof and frees the old slot', async () => {
    const f = await setupWorkforce(db.sql);
    try {
      const booking = f.booking();
      assert.equal((await f.send([put(booking)])).applied, 1);
      const at = new Date().toISOString(), to = booking.allocation!.endsAt;
      const allocation = { ...booking.allocation!, endsAt: f.session.endsAt };
      const change: UploadMutation = {
        clientId: clientId(), op: 'patch', table: 'appointment', id: booking.id, data: {
          updatedBy: f.facility.admin.id, updatedOn: at, scheduledFor: to, status: 'scheduled', allocation,
          activity: [{ id: `activity:${randomUUID()}`, action: 'rescheduled', recordedBy: f.facility.admin.id, recordedOn: at, fromAttendance: 'booked', toAttendance: 'booked', fromScheduledFor: booking.scheduledFor, toScheduledFor: to, reason: 'Reviewed slot change' }]
        },
        previous: { scheduledFor: booking.scheduledFor, allocation: booking.allocation, activity: null }
      };
      const result = await f.send([change]);
      assert.equal(result.applied, 1, JSON.stringify(result.rejected));
      const [proof] = await db.sql`SELECT revision,allocation_fingerprint FROM appointment_reservations WHERE appointment_id=${booking.id} ORDER BY revision DESC LIMIT 1`;
      assert.equal(proof.revision, 2);
      assert.ok(proof.allocation_fingerprint.includes(String(Date.parse(to))));
      assert.equal((await f.send([put(f.booking())])).applied, 1);
      const current = await findRecord<Appointment>(db.sql, 'appointment', booking.id);
      assert.equal(current?.scheduledFor, to);
    }
    finally {
      await f.app.close();
    }
  });
  it('continues distinct overnight sessions and validates all canonical duty roles and assignable grants in PostgreSQL', async () => {
    const f = await setupWorkforce(db.sql);
    try {
      for (const role of Role.options) {
        const id = `staff:${randomUUID()}`;
        await insertRecord(db.sql, 'staff', Staff.parse({ ...envelopeFor(f.facility), id, type: 'staff', staffId: id, fullName: 'Synthetic role holder', role, additionalRoles: Role.options, additionalPermissions: AssignablePermission.options }));
      }
      const start = new Date(f.now);
      start.setUTCHours(22, 0, 0, 0);
      if (start.getTime() <= f.now)
        start.setUTCDate(start.getUTCDate() + 1);
      const startsAt = start.toISOString(), endsAt = new Date(start.getTime() + 8 * 3600000).toISOString();
      const overnight = { ...f.session, id: `session:${randomUUID()}`, sessionId: `session:${randomUUID()}`, startsAt, endsAt };
      assert.equal((await f.send([put(overnight, { expectedPreviousId: null })])).applied, 1);
      const open = { ...f.env, type: 'session_event', id: `intake:${randomUUID()}`, offeringId: f.offering.id, sessionId: overnight.sessionId, action: 'open', observedOn: new Date().toISOString() };
      assert.equal((await f.send([put(open)])).applied, 1);
      const pause = { ...open, id: `intake:${randomUUID()}`, previousId: open.id, action: 'pause', reason: 'Temporary resource pause' };
      assert.equal((await f.send([put(pause)])).applied, 1);
      assert.ok((await f.send([put({ ...pause, id: `intake:${randomUUID()}`, action: 'close' })])).rejected.length);
      assert.equal((await findRecord(db.sql, 'staff', f.worker.id))?.type, 'staff');
    }
    finally {
      await f.app.close();
    }
  });
});
