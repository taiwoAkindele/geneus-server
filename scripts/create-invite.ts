import nano from 'nano';
import { loadConfig } from '../src/lib/config.ts';
import { createInvite, ensureInvitesDatabase } from '../src/couch/invites.ts';

/**
 * Issues the code a facility needs to register itself. Run by whoever approves
 * a new facility, and given to them out of band — until onboarding emails exist
 * (PRD §onboarding), this is the whole "magic link" mechanism.
 *
 *   npm run invite -- "Odo-Ona Elewe PHC" [days]
 */
const [label, days] = process.argv.slice(2);

if (!label) {
  console.error('usage: npm run invite -- "<facility label>" [valid-for-days]');
  process.exit(1);
}

const config = loadConfig();
const couch = nano({
  url: config.couchUrl,
  requestDefaults: { auth: { username: config.couchUser, password: config.couchPassword } },
});

await ensureInvitesDatabase(couch);
const invite = await createInvite(couch, label, Number(days ?? 14));

console.log(`\n  invite code: ${invite.token}`);
console.log(`  for:         ${invite.label}`);
console.log(`  expires:     ${invite.expiresOn}\n`);
