import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { createSql } from '../src/db/client.ts';
import { loadConfig } from '../src/lib/config.ts';
import { createSigner } from '../src/lib/signing.ts';
import { applyGovernanceRecord, provisionWorkforceContact, setWorkforcePolicy } from '../src/workforce/operations.ts';
import { workforceReadiness } from '../src/workforce/readiness.ts';
// Explicit file input makes the operation reviewable; no credentials or evidence are printed.
const [operation, filename] = process.argv.slice(2);
if (!filename?.toLowerCase().endsWith('.json') || !['record', 'policy', 'contact', 'readiness'].includes(operation))
  throw new Error('Usage: node scripts/workforce-setup.ts record|policy|contact|readiness approved-input.json');
const config = loadConfig(), sql = createSql(config.postgresUrl), signer = createSigner(config.signingPrivateKey);
const input: unknown = JSON.parse(await readFile(filename, 'utf8'));
try {
  if (operation === 'record') {
    const command = z.object({ record: z.unknown(), operator: z.string().trim().min(1), expectedRevision: z.number().int().positive().optional() }).parse(input);
    console.log(await applyGovernanceRecord(sql, signer, command.record, command.operator, command.expectedRevision));
  }
  else if (operation === 'policy') {
    const command = z.object({ facilityId: z.string(), deviceId: z.string(), operator: z.string().trim().min(1), policy: z.unknown(), timeZone: z.string().optional() }).parse(input);
    await setWorkforcePolicy(sql, signer, command);
    console.log('Reviewed workforce policy recorded');
  }
  else if (operation === 'contact') {
    const command = z.object({ facilityId: z.string(), staffId: z.string(), deviceId: z.string(), email: z.email(), operator: z.string().trim().min(1), governanceReference: z.string().trim().min(1) }).parse(input);
    await provisionWorkforceContact(sql, command);
    console.log('Verified workforce contact provisioned');
  }
  else {
    const command = z.object({ facilityId: z.string() }).parse(input);
    const readiness = await workforceReadiness(sql, command.facilityId);
    console.log(JSON.stringify({ ready: readiness.ready, blockers: readiness.blockers.map((b) => ({ kind: b.kind, count: b.ids.length })) }, null, 2));
  }
}
finally {
  await sql.end();
}
