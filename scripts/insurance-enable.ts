import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { createSql } from '../src/db/client.ts';
import { loadConfig } from '../src/lib/config.ts';
import { insuranceSetupStatus, setInsuranceState } from '../src/insurance/enablement.ts';

// A deployment operation, not a facility setting: run by an operator with database access, from a reviewed
// input file, and recorded as an immutable command and an audit event. Prints no credentials or patient data.
//   node scripts/insurance-enable.ts status   approved-input.json   { "facilityId": "..." }
//   node scripts/insurance-enable.ts setup    approved-input.json   { "facilityId", "operator", "governanceReference", "timeZone"? }
//   node scripts/insurance-enable.ts activate approved-input.json   (same; refused until every billing readiness item passes)
//   node scripts/insurance-enable.ts off      approved-input.json   (same; confirmed obligations always remain)
// Hospital administrators can also move between off and setup themselves, in the app.
const [operation, filename] = process.argv.slice(2);
const states = { setup: 'setup', activate: 'active', off: 'off' } as const;
if (!filename?.toLowerCase().endsWith('.json') || !['status', ...Object.keys(states)].includes(operation))
  throw new Error('Usage: node scripts/insurance-enable.ts status|setup|activate|off approved-input.json');
const config = loadConfig(), sql = createSql(config.postgresUrl);
const input: unknown = JSON.parse(await readFile(filename, 'utf8'));
try {
  if (operation === 'status') {
    const { facilityId } = z.object({ facilityId: z.string().min(1) }).parse(input);
    console.log(JSON.stringify(await insuranceSetupStatus(sql, facilityId), null, 2));
  } else {
    const command = z.object({ facilityId: z.string().min(1), operator: z.string().trim().min(1), governanceReference: z.string().trim().min(1), timeZone: z.string().optional() }).parse(input);
    console.log(JSON.stringify(await setInsuranceState(sql, { ...command, state: states[operation as keyof typeof states] }), null, 2));
  }
} finally {
  await sql.end();
}
