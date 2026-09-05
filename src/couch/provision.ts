import { randomBytes, randomUUID } from 'node:crypto';
import type nano from 'nano';
import { buildDesignDoc } from './designDoc.ts';

/**
 * One database per facility (root §2.2): small replicas, and a device that is
 * only ever given access to its own facility's data.
 */
export const databaseNameFor = (facilityCode: string): string =>
  `facility-${facilityCode.toLowerCase().replace(/[^a-z0-9_$()+-]/g, '-')}`;

export type SyncCredential = { username: string; password: string; database: string };

export const facilityExists = async (couch: nano.ServerScope, facilityCode: string): Promise<boolean> => {
  const databases = await couch.db.list();
  return databases.includes(databaseNameFor(facilityCode));
};

/**
 * Creates the facility's database with its validation guard and a credential
 * scoped to exactly that database. Deleting the user document is what revokes a
 * device's access later.
 */
export const provisionFacility = async (
  couch: nano.ServerScope,
  facilityCode: string,
): Promise<SyncCredential> => {
  const database = databaseNameFor(facilityCode);
  await couch.db.create(database);

  const facilityDb = couch.use(database);
  await facilityDb.insert(buildDesignDoc(facilityCode) as never);

  const username = `device-${randomUUID()}`;
  const password = randomBytes(24).toString('base64url');
  const users = couch.use('_users');
  await users.insert({
    _id: `org.couchdb.user:${username}`,
    name: username,
    password,
    roles: [],
    type: 'user',
  } as never);

  await couch.request({
    db: database,
    path: '_security',
    method: 'put',
    body: { admins: { names: [], roles: [] }, members: { names: [username], roles: [] } },
  });

  return { username, password, database };
};

const ALREADY_EXISTS = 412;

/**
 * CouchDB needs these before any facility database can be created. A 412 means
 * another boot already created it, which is success, not failure.
 */
export const ensureSystemDatabases = async (couch: nano.ServerScope): Promise<void> => {
  for (const name of ['_users', '_replicator']) {
    await couch.db.create(name).catch((cause: { statusCode?: number }) => {
      if (cause.statusCode !== ALREADY_EXISTS) throw cause;
    });
  }
};

/**
 * The PWA replicates straight from the browser, so CouchDB has to accept
 * credentialed cross-origin requests from wherever the app is served.
 */
export const ensureCors = async (couch: nano.ServerScope, origins: string[]): Promise<void> => {
  const settings: Record<string, Record<string, string>> = {
    chttpd: { enable_cors: 'true' },
    cors: {
      origins: origins.join(', '),
      credentials: 'true',
      methods: 'GET, PUT, POST, HEAD, DELETE',
      headers: 'accept, authorization, content-type, origin, referer, x-csrf-token',
    },
  };

  for (const [section, entries] of Object.entries(settings)) {
    for (const [key, value] of Object.entries(entries)) {
      await couch.request({
        method: 'put',
        path: `_node/_local/_config/${section}/${key}`,
        body: value,
      });
    }
  }
};
