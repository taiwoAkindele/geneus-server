import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { createSql } from '../src/db/client.ts';
import { loadConfig } from '../src/lib/config.ts';
import { insuranceStatus, setInsuranceEnabled } from '../src/insurance/enablement.ts';

// A deployment operation, not a facility setting: run by an operator with database access, from a reviewed
// input file, and recorded as an immutable command and an audit event. Prints no credentials or patient data.
//   node scripts/insurance-enable.ts status approved-input.json   { "facilityId": "..." }
//   node scripts/insurance-enable.ts enable approved-input.json   { "facilityId", "operator", "governanceReference", "timeZone"? }
//   node scripts/insurance-enable.ts disable approved-input.json  { "facilityId", "operator", "governanceReference" }
const [operation, filename] = process.argv.slice(2);
if (!filename?.toLowerCase().endsWith('.json') || !['status', 'enable', 'disable'].includes(operation))
  throw new Error('Usage: node scripts/insurance-enable.ts status|enable|disable approved-input.json');
const config = loadConfig(), sql = createSql(config.postgresUrl);
const input: unknown = JSON.parse(await readFile(filename, 'utf8'));
try {
  if (operation === 'status') {
    const { facilityId } = z.object({ facilityId: z.string().min(1) }).parse(input);
    console.log(JSON.stringify(await insuranceStatus(sql, facilityId), null, 2));
  } else {
    const command = z.object({ facilityId: z.string().min(1), operator: z.string().trim().min(1), governanceReference: z.string().trim().min(1), timeZone: z.string().optional() }).parse(input);
    console.log(JSON.stringify(await setInsuranceEnabled(sql, { ...command, enabled: operation === 'enable' }), null, 2));
  }
} finally {
  await sql.end();
}
