import { createSql } from '../src/db/client.ts';
import { loadConfig } from '../src/lib/config.ts';
import { issuePinSetupCode } from '../src/staff/pinSetupCodes.ts';

/**
 * The last resort for a facility admin locked out of every route the app
 * offers: no other admin to issue a code, no on-site admin to approve, no
 * reachable recovery email. Run by whoever operates Geneus, AFTER confirming
 * who is asking — for example by calling a number already on record for the
 * facility. The code is read to the admin, who enters it on the sign-in screen
 * ("I have a code from my admin"). Recorded in the audit trail as issued by the
 * operator.
 *
 *   npm run pin-code -- <FACILITY-CODE>                 # lists the facility's admins
 *   npm run pin-code -- <FACILITY-CODE> <staffId>       # issues a code for one of them
 */
const [facilityCode, staffId] = process.argv.slice(2);

if (!facilityCode) {
  console.error('usage: npm run pin-code -- <FACILITY-CODE> [staffId]');
  process.exit(1);
}

const sql = createSql(loadConfig().postgresUrl);
try {
  const [facility] = await sql<{ id: string; name: string; device_id: string }[]>`
    SELECT id, name, device_id FROM facilities WHERE id = ${facilityCode.trim().toUpperCase()}`;
  if (!facility) throw new Error(`no facility ${facilityCode}`);

  const admins = await sql<{ id: string; full_name: string }[]>`
    SELECT id, full_name FROM staff WHERE facility_id = ${facility.id} AND role = 'facility_admin' AND active ORDER BY full_name`;

  if (!staffId) {
    console.log(`\n  active facility admins of ${facility.name} (${facility.id}):`);
    for (const admin of admins) console.log(`    ${admin.id}   ${admin.full_name}`);
    console.log('');
  } else {
    const admin = admins.find((candidate) => candidate.id === staffId);
    if (!admin) throw new Error(`${staffId} is not an active facility admin of ${facility.id}`);

    // Attributed to the device that registered the facility: a code must name
    // a device of its facility, and the operator has none.
    const outcome = await issuePinSetupCode(sql, {
      facilityId: facility.id,
      staffId: admin.id,
      issuedBy: 'system',
      issuedFrom: facility.device_id,
      channel: 'operator',
    });
    if (!outcome.ok) throw new Error(`could not issue a code for ${staffId}`);

    console.log(`\n  PIN code:  ${outcome.code}`);
    console.log(`  for:       ${admin.full_name}, ${facility.name}`);
    console.log(`  expires:   ${outcome.record.expiresOn}`);
    console.log('  Their phone must sync once before the code works there. Any earlier code is now void.\n');
  }
} catch (cause) {
  console.error(`  ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
