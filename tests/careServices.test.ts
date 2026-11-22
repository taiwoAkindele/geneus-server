import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import {
  Location,
  POLICY_VERSION,
  ServiceDefinition,
  ServiceOffering,
  Unit,
  type Appointment,
  type Encounter,
  type Facility,
  type FacilityRegistrationResult,
  type Staff,
  type UploadMutation,
} from '#shared';
import { findRecord, insertRecord } from '../src/db/records.ts';
import { buildSyncConfig } from '../src/sync/syncConfig.ts';
import {
  addStaff,
  asDevice,
  clientId,
  envelopeFor,
  registerScratchFacility,
  scratchDatabase,
  staffSessionFor,
  testApp,
  upload,
  type ScratchDatabase,
} from './postgres.ts';

/**
 * Care services on bookings and visits, through the real upload path and
 * PostgreSQL: the booked service is kept with the visit type that fee
 * exemptions and registers read, and only a client that negotiated care
 * services may send it.
 */
describe('care services on bookings and visits', () => {
  let db: ScratchDatabase;
  let app: FastifyInstance;
  let f: FacilityRegistrationResult;
  let other: FacilityRegistrationResult;
  let nurse: Staff;
  let patientId: string;

  const CURRENT = {
    careServiceVersion: 1,
    facilityContractVersion: 1,
    schemaVersion: 5,
    policyVersion: POLICY_VERSION,
    clinicalWorkflowVersion: 1,
  } as const;

  const put = (
    table: UploadMutation['table'],
    id: string,
    fields: Record<string, unknown>,
    facility = f,
  ): UploadMutation => ({
    clientId: clientId(),
    op: 'put',
    table,
    id,
    data: {
      ...envelopeFor(facility),
      createdOn: new Date(Date.now() - 60_000).toISOString(),
      id,
      type: table,
      ...fields,
    },
  });

  const send = (...mutations: UploadMutation[]) =>
    upload(app, f.device.credential, { ...CURRENT, transactionId: null, mutations });

  const seed = async (facility: FacilityRegistrationResult, suffix: string) => {
    const env = { ...envelopeFor(facility), schemaVersion: 4 };
    await insertRecord(
      db.sql,
      'unit',
      Unit.parse({
        ...env,
        id: `unit:${suffix}`,
        unitId: `unit:${suffix}`,
        type: 'unit',
        name: 'Outpatients',
        kind: 'unit',
        revision: 1,
      }),
    );

    await insertRecord(
      db.sql,
      'location',
      Location.parse({
        ...env,
        id: `location:${suffix}`,
        type: 'location',
        name: 'Room 1',
        kind: 'room',
        revision: 1,
      }),
    );

    const offering = async (key: string, patch: Record<string, unknown>, investigation = false) => {
      await insertRecord(
        db.sql,
        'service_definition',
        ServiceDefinition.parse({
          ...env,
          id: `def:${key}:${suffix}`,
          type: 'service_definition',
          name: key,
          category: investigation ? 'laboratory' : 'consultation',
          concept: { system: 'local', code: key, label: key },
          ...(investigation
            ? {
                orderable: true,
                investigation: { specimen: 'Blood', department: 'Haematology', aliases: [] },
              }
            : {}),
        }),
      );

      await insertRecord(
        db.sql,
        'service_offering',
        ServiceOffering.parse({
          ...env,
          id: `offering:${key}:${suffix}`,
          type: 'service_offering',
          serviceDefinitionId: `def:${key}:${suffix}`,
          unitId: `unit:${suffix}`,
          name: key,
          locationIds: [`location:${suffix}`],
          delivery: 'physical',
          intakePolicy: 'both',
          timeZone: 'Africa/Lagos',
          configuration: 'active',
          ...patch,
        }),
      );
    };

    await offering('opd', { visitTypes: ['general', 'follow_up'] });
    await offering('inpatient', { visitTypes: [] });
    await offering('retired', { visitTypes: ['general'], configuration: 'retired' });
    await offering('hb', { visitTypes: ['general'] }, true);
  };

  before(async () => {
    db = await scratchDatabase();
    app = testApp(db.sql);
    f = await registerScratchFacility(db.sql);
    other = await registerScratchFacility(db.sql);
    nurse = await addStaff(db.sql, f, { role: 'nurse', name: 'Nkem Nurse' });
    await seed(f, 'a');
    await seed(other, 'b');
    patientId = `${f.facility.id}-000001-K2`;
    assert.deepEqual(
      (
        await send(
          put('patient', patientId, {
            patientId,
            fullName: 'Care Patient',
            address: 'Test road',
            sex: 'female',
            ageYears: 30,
          }),
        )
      ).rejected,
      [],
    );
  });

  after(async () => {
    if (app) {
      await app.close();
    }

    if (db) {
      await db.drop();
    }
  });

  it('keeps facilities registered before facility details valid: no country or currency means Nigeria and naira', async () => {
    const facility = (await findRecord<Facility>(db.sql, 'facility', f.facility.id))!;
    assert.equal(facility.country, undefined);
    assert.equal(facility.currency, undefined);
  });

  it('keeps the booked care service with the visit kind it records', async () => {
    const result = await send(
      put('appointment', 'booking:opd', {
        patientId,
        reason: 'Review',
        offeringId: 'offering:opd:a',
        visitType: 'follow_up',
      }),
    );

    assert.deepEqual(result.rejected, []);
    const saved = (await findRecord<Appointment>(db.sql, 'appointment', 'booking:opd'))!;
    assert.equal(saved.offeringId, 'offering:opd:a');
    assert.equal(saved.visitType, 'follow_up');
    assert.deepEqual(
      (
        await send(
          put('appointment', 'booking:legacy', {
            patientId,
            reason: 'Consultation',
            visitType: 'general',
          }),
        )
      ).rejected,
      [],
      'a booking without a care service is still accepted',
    );
  });

  it('refuses a lab test, care that is not a visit, another hospital’s service and a visit kind the service does not record', async () => {
    const refused = async (id: string, fields: Record<string, unknown>) =>
      (await send(put('appointment', id, { patientId, reason: 'x', ...fields }))).rejected[0]
        ?.reason ?? '';

    assert.match(
      await refused('booking:lab', { offeringId: 'offering:hb:a' }),
      /care service of this hospital/,
    );

    assert.match(
      await refused('booking:ward', { offeringId: 'offering:inpatient:a' }),
      /does not take booked/,
    );

    assert.match(
      await refused('booking:other', { offeringId: 'offering:opd:b' }),
      /care service of this hospital/,
    );

    assert.match(
      await refused('booking:kind', { offeringId: 'offering:opd:a', visitType: 'antenatal' }),
      /does not record this kind/,
    );
  });

  it('keeps a visit recorded offline for a service retired meanwhile, and carries the service onto the visit', async () => {
    assert.deepEqual(
      (
        await send(
          put('encounter', 'encounter:retired', {
            patientId,
            openedOn: new Date().toISOString(),
            offeringId: 'offering:retired:a',
            visitType: 'general',
          }),
        )
      ).rejected,
      [],
    );

    assert.deepEqual(
      (
        await send(
          put('encounter', 'encounter:booked', {
            patientId,
            openedOn: new Date().toISOString(),
            appointmentId: 'booking:opd',
            offeringId: 'offering:opd:a',
            visitType: 'follow_up',
          }),
        )
      ).rejected,
      [],
    );

    assert.equal(
      (await findRecord<Encounter>(db.sql, 'encounter', 'encounter:booked'))!.offeringId,
      'offering:opd:a',
    );
  });

  it('never moves a booking to another care service after it is made', async () => {
    const result = await send({
      clientId: clientId(),
      op: 'patch',
      table: 'appointment',
      id: 'booking:opd',
      data: {
        updatedBy: f.admin.id,
        updatedOn: new Date().toISOString(),
        offeringId: 'offering:inpatient:a',
      },
    });

    assert.equal(result.rejected.length, 1);
    assert.equal(
      (await findRecord<Appointment>(db.sql, 'appointment', 'booking:opd'))!.offeringId,
      'offering:opd:a',
    );
  });

  it('accepts a care service only from a client that negotiated care services', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/sync/upload',
      headers: asDevice(f.device.credential),
      payload: {
        transactionId: null,
        facilityContractVersion: 1,
        schemaVersion: 5,
        policyVersion: POLICY_VERSION,
        clinicalWorkflowVersion: 1,
        mutations: [
          put('appointment', 'booking:old', {
            patientId,
            reason: 'x',
            offeringId: 'offering:opd:a',
          }),
        ],
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(await findRecord(db.sql, 'appointment', 'booking:old'), undefined);
  });

  it('signs care services into the sync token, and sends their fields only to such clients', async () => {
    const token = await app.inject({
      method: 'POST',
      url: '/sync/token',
      headers: asDevice(f.device.credential),
      payload: { ...CURRENT, pendingMutationCount: 0 },
    });

    assert.equal(token.statusCode, 200, token.body);
    assert.equal(token.json().careServiceVersion, 1);

    const claims = JSON.parse(
      Buffer.from(token.json().token.split('.')[1], 'base64url').toString(),
    );

    assert.equal(claims.care_service, 1);

    const plain = await app.inject({
      method: 'POST',
      url: '/sync/token',
      headers: asDevice(f.device.credential),
      payload: {
        facilityContractVersion: 1,
        schemaVersion: 5,
        policyVersion: POLICY_VERSION,
        clinicalWorkflowVersion: 1,
        pendingMutationCount: 0,
      },
    });

    assert.equal(
      JSON.parse(Buffer.from(plain.json().token.split('.')[1], 'base64url').toString())
        .care_service,
      undefined,
    );

    const config = buildSyncConfig();

    const offeringQueries = config
      .split('\n  service_offerings:\n')[1]
      .split(/\n {2}[a-z_]+:\n/)[0];

    assert.ok(
      offeringQueries.includes('visit_types AS "visitTypes"') &&
        offeringQueries.includes("auth.parameter('care_service') = 1"),
    );

    assert.ok(
      offeringQueries.includes("auth.parameter('care_service') IS NULL"),
      'older clients still receive offerings, without visit kinds',
    );
  });

  describe('facility details', () => {
    const save = async (payload: Record<string, unknown>, staffId?: string) =>
      app.inject({
        method: 'POST',
        url: '/facility/details',
        payload,
        headers: {
          ...asDevice(f.device.credential),
          ...(staffId
            ? { 'x-staff-session': (await staffSessionFor(app, f.device.credential, staffId))! }
            : {}),
        },
      });

    const details = {
      name: 'Sunrise Hospital Annex',
      level: 'general_hospital',
      state: 'Lagos',
      lga: 'Ikeja',
      country: 'NG',
      currency: 'NGN',
      address: '12 Sample Road, Ikeja',
      phone: '+234 800 000 0000',
    };

    it('lets a PIN-verified administrator correct the details, never the code', async () => {
      assert.equal((await save(details)).statusCode, 403, 'a device alone is not a person');
      assert.equal((await save({ ...details, code: 'OTHER' }, f.admin.id)).statusCode, 400);
      const saved = await save(details, f.admin.id);
      assert.equal(saved.statusCode, 200, saved.body);
      const facility = (await findRecord<Facility>(db.sql, 'facility', f.facility.id))!;
      assert.equal(facility.name, 'Sunrise Hospital Annex');
      assert.equal(facility.address, '12 Sample Road, Ikeja');
      assert.equal(facility.code, f.facility.code);
      assert.ok(
        (
          await db.sql`SELECT 1 FROM audit_events WHERE facility_id = ${f.facility.id} AND metadata->>'context' = 'facility_details'`
        ).length,
      );

      assert.deepEqual(
        (await save(details, f.admin.id)).json().changed,
        [],
        'saving unchanged details changes nothing',
      );
    });

    it('refuses anyone but an administrator', async () => {
      assert.equal((await save({ ...details, name: 'Not allowed' }, nurse.id)).statusCode, 403);
    });

    it('acts for the person signed in on the enrolled device without a PIN step, never for someone outside the facility', async () => {
      const as = (staffId: string) =>
        app.inject({
          method: 'POST',
          url: '/facility/details',
          payload: { ...details, phone: '+234 800 111 2222' },
          headers: { ...asDevice(f.device.credential), 'x-actor-staff-id': staffId },
        });

      assert.equal((await as(f.admin.id)).statusCode, 200);
      assert.equal(
        (await findRecord<Facility>(db.sql, 'facility', f.facility.id))!.phone,
        '+234 800 111 2222',
      );

      assert.equal((await as(nurse.id)).statusCode, 403, 'the nurse’s own role still applies');
      assert.equal(
        (await as(other.admin.id)).statusCode,
        403,
        'another facility’s administrator is not a member here',
      );
    });
  });
});
