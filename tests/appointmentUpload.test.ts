import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { type Appointment, type AppointmentAction, type FacilityRegistrationResult, type Staff, type UploadMutation } from '#shared';
import { findRecord } from '../src/db/records.ts';
import { addStaff, clientId, envelopeFor, registerScratchFacility, scratchDatabase, testApp, upload, type ScratchDatabase } from './postgres.ts';

describe('appointment attendance upload boundary', () => {
  let db: ScratchDatabase, app: FastifyInstance, facility: FacilityRegistrationResult, other: FacilityRegistrationResult, records: Staff, readonly: Staff, cashier: Staff;
  let patientId: string, secondPatient: string;
  const send = (...mutations: UploadMutation[]) => upload(app, facility.device.credential, { transactionId: 1, mutations });
  const put = (table: UploadMutation['table'], id: string, fields: Record<string, unknown>): UploadMutation => ({ clientId: clientId(), op: 'put', table, id, data: { ...envelopeFor(facility), createdOn: new Date(Date.now() - 60_000).toISOString(), createdBy: facility.admin.id, id, type: table, ...fields } });
  const booking = async (id: string) => {
    assert.deepEqual((await send(put('appointment', id, { patientId, reason: 'Consultation' }))).rejected, []);
    return (await findRecord<Appointment>(db.sql, 'appointment', id))!;
  };
  const change = (current: Appointment, action: AppointmentAction, extra: { scheduledFor?: string; reason?: string } = {}, actor?: Staff): UploadMutation => {
    const recordedOn = new Date().toISOString(), recordedBy = actor?.id ?? records.id;
    const attendance = action === 'rescheduled' || action === 'reopened' ? 'booked' : action;
    const scheduledFor = action === 'rescheduled' ? extra.scheduledFor : current.scheduledFor;
    return { clientId: clientId(), op: 'patch', table: 'appointment', id: current.id,
      previous: { activity: current.activity ?? null, attendance: current.attendance ?? null, scheduledFor: current.scheduledFor ?? null, status: current.status },
      data: { updatedBy: recordedBy, updatedOn: recordedOn, attendance, ...(scheduledFor ? { scheduledFor } : {}), status: action === 'rescheduled' ? 'scheduled' : current.status, activity: [...(current.activity ?? []), { id: `action:${clientId()}`, action, recordedBy, recordedOn, fromAttendance: current.attendance ?? 'booked', toAttendance: attendance, ...(current.scheduledFor ? { fromScheduledFor: current.scheduledFor } : {}), ...(scheduledFor ? { toScheduledFor: scheduledFor } : {}), ...(extra.reason ? { reason: extra.reason } : {}) }] } };
  };
  before(async () => {
    db = await scratchDatabase(); app = testApp(db.sql);
    facility = await registerScratchFacility(db.sql); other = await registerScratchFacility(db.sql);
    records = await addStaff(db.sql, facility, { role: 'records_officer' });
    readonly = await addStaff(db.sql, facility, { role: 'records_officer', permission: 'read_only' });
    cashier = await addStaff(db.sql, facility, { role: 'cashier' });
    patientId = `${facility.facility.id}-000001-K2`; secondPatient = `${facility.facility.id}-000002-K2`;
    assert.deepEqual((await send(...[patientId, secondPatient].map((id) => put('patient', id, { patientId: id, fullName: 'Booking Patient', address: 'Test road', sex: 'female', ageYears: 30 })))).rejected, []);
  });
  after(async () => { if (app) await app.close(); if (db) await db.drop(); });

  it('records attributed arrival and acknowledges retries without duplicating history', async () => {
    const initial = await booking('booking:arrive'), mutation = change(initial, 'arrived');
    assert.deepEqual((await send(mutation)).rejected, []);
    assert.deepEqual((await send(mutation)).rejected, []);
    const saved = (await findRecord<Appointment>(db.sql, 'appointment', initial.id))!;
    assert.equal(saved.attendance, 'arrived'); assert.equal(saved.activity?.length, 1);
    assert.equal(saved.activity?.[0].recordedBy, records.id);
  });
  it('compares timezone representations as the same instant through PostgreSQL and history', async () => {
    const scheduledFor = new Date(Date.now() + 3_600_000).toISOString().replace('Z', '+01:00');
    assert.deepEqual((await send(put('appointment', 'booking:timezone', { patientId, reason: 'Consultation', status: 'scheduled', scheduledFor }))).rejected, []);
    const stored = (await findRecord<Appointment>(db.sql, 'appointment', 'booking:timezone'))!;
    const offline = { ...stored, scheduledFor };
    assert.deepEqual((await send(change(offline, 'arrived'))).rejected, []);
    const saved = (await findRecord<Appointment>(db.sql, 'appointment', stored.id))!;
    assert.equal(Date.parse(saved.scheduledFor!), Date.parse(saved.activity![0].toScheduledFor!));
  });
  it('reschedules, cancels and reopens the original booking with its full history', async () => {
    const initial = await booking('booking:reschedule'), scheduledFor = new Date(Date.now() + 86_400_000).toISOString();
    assert.deepEqual((await send(change(initial, 'rescheduled', { scheduledFor, reason: 'Patient request' }))).rejected, []);
    const moved = (await findRecord<Appointment>(db.sql, 'appointment', initial.id))!;
    assert.deepEqual((await send(change(moved, 'cancelled', { reason: 'Cannot attend' }))).rejected, []);
    const cancelled = (await findRecord<Appointment>(db.sql, 'appointment', initial.id))!;
    assert.deepEqual((await send(change(cancelled, 'reopened', { reason: 'Patient can attend' }))).rejected, []);
    const saved = (await findRecord<Appointment>(db.sql, 'appointment', initial.id))!;
    assert.equal(saved.scheduledFor, scheduledFor); assert.equal(saved.attendance, 'booked');
    assert.deepEqual(saved.activity?.map((event) => event.action), ['rescheduled', 'cancelled', 'reopened']);
    assert.equal(saved.activity?.[0].fromScheduledFor, undefined);
  });
  it('requires reasons, prevents premature no-shows and keeps recorded arrivals out of no-show', async () => {
    const initial = await booking('booking:due');
    assert.equal((await send(change(initial, 'cancelled'))).rejected[0]?.category, 'validation');
    assert.deepEqual((await send(change(initial, 'no_show', { reason: 'Did not attend' }))).rejected, []);
    const future = await booking('booking:future');
    assert.deepEqual((await send(change(future, 'rescheduled', { scheduledFor: new Date(Date.now() + 86_400_000).toISOString(), reason: 'Next day' }))).rejected, []);
    const scheduled = (await findRecord<Appointment>(db.sql, 'appointment', future.id))!;
    assert.equal((await send(change(scheduled, 'no_show', { reason: 'Too early' }))).rejected[0]?.category, 'validation');
    const arrival = (await findRecord<Appointment>(db.sql, 'appointment', 'booking:arrive'))!;
    assert.equal((await send(change(arrival, 'no_show', { reason: 'Already arrived' }))).rejected[0]?.category, 'validation');
  });
  it('refuses readonly, cashier, cross-facility and unattributed changes', async () => {
    const initial = await booking('booking:authority');
    for (const actor of [readonly, cashier]) assert.equal((await send(change(initial, 'arrived', {}, actor))).rejected[0]?.category, 'authorization');
    const foreign = await upload(app, other.device.credential, { transactionId: 1, mutations: [change(initial, 'arrived')] });
    assert.equal(foreign.rejected[0]?.category, 'identity');
    const mismatch = change(initial, 'arrived'); mismatch.data.updatedBy = facility.admin.id;
    assert.equal((await send(mismatch)).rejected[0]?.category, 'validation');
  });
  it('retains the winning complete change during a race and refuses history replacement', async () => {
    const initial = await booking('booking:race');
    const results = await Promise.all([send(change(initial, 'cancelled', { reason: 'Cancel this time' })), send(change(initial, 'rescheduled', { scheduledFor: new Date(Date.now() + 86_400_000).toISOString(), reason: 'Move this time' }))]);
    assert.equal(results.reduce((count, result) => count + result.rejected.length, 0), 1);
    const [refusal] = await db.sql`SELECT refused_changes FROM sync_rejections WHERE entity_id = ${initial.id}`;
    assert.ok(Array.isArray(refusal.refused_changes.activity));
    assert.equal(refusal.refused_changes.activity.length, 1);
    const saved = (await findRecord<Appointment>(db.sql, 'appointment', initial.id))!;
    assert.equal(saved.activity?.length, 1); assert.equal(saved.activity?.[0].toAttendance, saved.attendance);
    const staleBase = change(saved, saved.attendance === 'cancelled' ? 'reopened' : 'cancelled', { reason: 'Intended action with a stale base' });
    staleBase.previous = { status: saved.status === 'scheduled' ? 'pending' : 'scheduled' };
    const result = await send(staleBase);
    assert.equal(result.rejected[0]?.category, 'conflict');
    assert.deepEqual(await findRecord<Appointment>(db.sql, 'appointment', initial.id), saved);
    const [kept] = await db.sql`SELECT refused_changes FROM sync_rejections WHERE entity_id = ${initial.id} ORDER BY created_on DESC LIMIT 1`;
    assert.equal(kept.refused_changes.activity.length, 2);
    const tampered = change(saved, saved.attendance === 'cancelled' ? 'reopened' : 'cancelled', { reason: 'Attempt to remove history' });
    (tampered.data.activity as unknown[]).shift();
    assert.ok((await send(tampered)).rejected.length);
    assert.deepEqual((await findRecord<Appointment>(db.sql, 'appointment', initial.id))?.activity, saved.activity);
  });
  it('serializes visit creation with attendance, rejects inactive or mismatched bookings and duplicate visits', async () => {
    const inactive = (await findRecord<Appointment>(db.sql, 'appointment', 'booking:due'))!;
    assert.equal((await send(put('encounter', 'visit:inactive', { patientId, appointmentId: inactive.id, openedOn: new Date().toISOString() }))).rejected[0]?.category, 'conflict');
    const initial = await booking('booking:visit');
    assert.equal((await send(put('encounter', 'visit:other-patient', { patientId: secondPatient, appointmentId: initial.id, openedOn: new Date().toISOString() }))).rejected[0]?.category, 'validation');
    assert.deepEqual((await send(put('encounter', 'visit:linked', { patientId, appointmentId: initial.id, openedOn: new Date().toISOString() }))).rejected, []);
    assert.equal((await send(change(initial, 'cancelled', { reason: 'Care started' }))).rejected[0]?.category, 'conflict');
    assert.equal((await send(put('encounter', 'visit:duplicate', { patientId, appointmentId: initial.id, openedOn: new Date().toISOString() }))).rejected[0]?.category, 'conflict');
    const race = await booking('booking:visit-race');
    const outcomes = await Promise.all([send(change(race, 'cancelled', { reason: 'Cancel before care' })), send(put('encounter', 'visit:race', { patientId, appointmentId: race.id, openedOn: new Date().toISOString() }))]);
    assert.equal(outcomes.reduce((count, result) => count + result.rejected.length, 0), 1);
  });
});
