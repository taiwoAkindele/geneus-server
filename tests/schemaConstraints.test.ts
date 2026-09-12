import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Patient, RegisterDefinition, Role, type FacilityRegistrationResult } from '#shared';
import { CHECK_VIOLATION, FOREIGN_KEY_VIOLATION, UNIQUE_VIOLATION } from '../src/db/client.ts';
import { findRecord, insertRecord } from '../src/db/records.ts';
import { recordAuditEvent } from '../src/audit/auditEvents.ts';
import { envelopeFor, refusal, registerScratchFacility, scratchDatabase, type ScratchDatabase } from './postgres.ts';

/**
 * Invariants that belong in the database are tested in the database. The point
 * of each test is the consequence a constraint prevents: a row pointing at
 * another facility, a rewritten audit trail, two "version 2"s of a register.
 */
describe('schema constraints', () => {
  let db: ScratchDatabase;
  let a: FacilityRegistrationResult;
  let b: FacilityRegistrationResult;

  const patientFor = (facility: FacilityRegistrationResult, sequence: string) =>
    Patient.parse({
      ...envelopeFor(facility),
      id: `${facility.facility.id}-${sequence}-K2`,
      type: 'patient',
      patientId: `${facility.facility.id}-${sequence}-K2`,
      fullName: 'Amaka Okoro',
      address: 'Odo-Ona',
      sex: 'female',
      ageYears: 32,
      allergies: ['penicillin'],
    });

  const definitionFor = (facility: FacilityRegistrationResult, registerId: string, version: number) =>
    RegisterDefinition.parse({
      ...envelopeFor(facility),
      id: `${registerId}:v${version}`,
      type: 'register_definition',
      registerId,
      version,
      name: 'OPD',
      category: 'General',
      status: 'published',
      fields: [{ id: 'f1', type: 'text', label: 'Name' }],
    });

  before(async () => {
    db = await scratchDatabase();
    [a, b] = await Promise.all([registerScratchFacility(db.sql), registerScratchFacility(db.sql)]);
    await insertRecord(db.sql, 'patient', patientFor(a, '000001'));
    await insertRecord(db.sql, 'register_definition', definitionFor(a, 'register:opd', 1));
  });

  after(async () => {
    await db.drop();
  });

  describe('facility isolation', () => {
    it("refuses an appointment in facility B for facility A's patient", async () => {
      const error = await refusal(
        insertRecord(db.sql, 'appointment', {
          ...envelopeFor(b),
          id: 'appointment:cross',
          type: 'appointment',
          patientId: `${a.facility.id}-000001-K2`,
          reason: 'Review',
          status: 'pending',
        }),
      );

      assert.equal(error.code, FOREIGN_KEY_VIOLATION);
    });

    it("refuses a register entry in facility B against facility A's register", async () => {
      const error = await refusal(
        insertRecord(db.sql, 'register_entry', {
          ...envelopeFor(b),
          id: 'register_entry:cross',
          type: 'register_entry',
          registerId: 'register:opd',
          registerVersion: 1,
          entryDate: '2026-09-12',
          setting: 'facility',
          values: { f1: 'x' },
        }),
      );

      assert.equal(error.code, FOREIGN_KEY_VIOLATION);
    });

    it("refuses a roster shift in facility B for facility A's staff", async () => {
      const error = await refusal(
        insertRecord(db.sql, 'roster_shift', {
          ...envelopeFor(b),
          id: 'roster_shift:cross',
          type: 'roster_shift',
          staffId: a.admin.id,
          startsAt: '2026-09-12T08:00:00Z',
          endsAt: '2026-09-12T16:00:00Z',
        }),
      );

      assert.equal(error.code, FOREIGN_KEY_VIOLATION);
    });

    it('refuses a record stamped with a device that does not exist', async () => {
      const error = await refusal(
        insertRecord(db.sql, 'patient', { ...patientFor(a, '000009'), deviceId: 'device-forged' }),
      );

      assert.equal(error.code, FOREIGN_KEY_VIOLATION);
    });
  });

  describe('audit trail', () => {
    it('cannot be updated', async () => {
      const event = await recordAuditEvent(db.sql, { facilityId: a.facility.id, deviceId: a.device.deviceId, action: 'sync' });

      const error = await refusal(db.sql`UPDATE audit_events SET action = 'view' WHERE id = ${event.id}`);

      assert.match(error.message ?? '', /append-only/);
    });

    it('cannot be deleted', async () => {
      const event = await recordAuditEvent(db.sql, { facilityId: a.facility.id, deviceId: a.device.deviceId, action: 'sync' });

      const error = await refusal(db.sql`DELETE FROM audit_events WHERE id = ${event.id}`);

      assert.match(error.message ?? '', /append-only/);
      assert.ok(await findRecord(db.sql, 'audit_event', event.id));
    });

    it('stamps the server clock on arrival', async () => {
      const event = await recordAuditEvent(db.sql, { facilityId: a.facility.id, deviceId: a.device.deviceId, action: 'sync' });
      const [row] = await db.sql<{ received_on: string }[]>`SELECT received_on FROM audit_events WHERE id = ${event.id}`;

      assert.ok(Date.parse(row.received_on) > 0);
    });
  });

  describe('registers', () => {
    it('refuses a second definition of the same version, so two offline publishes cannot both win', async () => {
      const error = await refusal(
        insertRecord(db.sql, 'register_definition', { ...definitionFor(a, 'register:opd', 1), createdOn: new Date().toISOString() }),
      );

      assert.equal(error.code, UNIQUE_VIOLATION);
    });

    it('accepts the next version', async () => {
      await insertRecord(db.sql, 'register_definition', definitionFor(a, 'register:opd', 2));

      assert.ok(await findRecord(db.sql, 'register_definition', 'register:opd:v2'));
    });

    it('holds the id to the `${registerId}:v${version}` convention', async () => {
      const error = await refusal(
        insertRecord(db.sql, 'register_definition', { ...definitionFor(a, 'register:anc', 1), id: 'register:anc:v9' }),
      );

      assert.equal(error.code, CHECK_VIOLATION);
    });
  });

  describe('value constraints', () => {
    it('refuses a shift that ends before it starts', async () => {
      const error = await refusal(
        insertRecord(db.sql, 'roster_shift', {
          ...envelopeFor(a),
          id: 'roster_shift:backwards',
          type: 'roster_shift',
          staffId: a.admin.id,
          startsAt: '2026-09-12T16:00:00Z',
          endsAt: '2026-09-12T08:00:00Z',
        }),
      );

      assert.equal(error.code, CHECK_VIOLATION);
    });

    it("accepts every role in the contract and refuses one that isn't", async () => {
      for (const role of Role.options) {
        const id = `staff:${role}`;
        await insertRecord(db.sql, 'staff', {
          ...envelopeFor(a),
          id,
          type: 'staff',
          staffId: id,
          fullName: role,
          role,
          permission: 'read_write',
          active: true,
        });
      }

      const error = await refusal(
        db.sql`UPDATE staff SET role = 'janitor' WHERE id = 'staff:nurse'`,
      );
      assert.equal(error.code, CHECK_VIOLATION);
    });

    /** Raw SQL on purpose: the contract refuses this first, and the point is that the table does too. */
    it('refuses a patient with neither a date of birth nor an age, even bypassing the contract', async () => {
      const error = await refusal(db.sql`
        INSERT INTO patients (id, facility_id, schema_version, created_by, created_on, device_id, patient_id, full_name, address, sex)
        VALUES ('AGELESS-X-000001-K2', ${a.facility.id}, 3, ${a.admin.id}, now(), ${a.device.deviceId}, 'AGELESS-X-000001-K2', 'No Age', 'Odo-Ona', 'female')`);

      assert.equal(error.code, CHECK_VIOLATION);
    });
  });
});
