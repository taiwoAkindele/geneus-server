import postgres from 'postgres';

/**
 * The one PostgreSQL client. `postgres` (postgres.js) is a single dependency
 * with no dependencies of its own: tagged-template queries with parameters
 * bound by the driver, transactions via `sql.begin`, and nothing between us
 * and SQL — the schema in migrations/ is the whole data model, readable as is.
 */
export type Sql = postgres.Sql;

/** A transaction handle; the same interface as `Sql`, scoped to one transaction. */
export type Tx = postgres.TransactionSql;

/**
 * Dates come back as ISO-8601 strings, not Date objects, because that is what
 * the contract carries and what every caller compares. Two types are involved:
 * `date` (DOB, entry dates) is passed through as PostgreSQL's own YYYY-MM-DD
 * text, and `timestamptz` is normalised to UTC ISO time. A record's original
 * offset is therefore not preserved — the instant is, which is what matters.
 */
const DATE_OID = 1082;
const TIMESTAMP_OID = 1114;
const TIMESTAMPTZ_OID = 1184;
/** `numeric` (stock quantities) arrives as text by default; the contract wants a number. */
const NUMERIC_OID = 1700;

export const createSql = (url: string): Sql =>
  postgres(url, {
    // One process, few concurrent requests; a small pool is plenty and keeps
    // the database's connection count legible.
    max: 10,
    types: {
      date: {
        to: DATE_OID,
        from: [DATE_OID],
        serialize: (value: string) => value,
        parse: (value: string) => value,
      },
      timestamptz: {
        to: TIMESTAMPTZ_OID,
        from: [TIMESTAMP_OID, TIMESTAMPTZ_OID],
        serialize: (value: string | Date) => (value instanceof Date ? value.toISOString() : value),
        parse: (value: string) => new Date(value).toISOString(),
      },
      numeric: {
        to: NUMERIC_OID,
        from: [NUMERIC_OID],
        serialize: (value: number) => String(value),
        parse: (value: string) => Number(value),
      },
    },
  });

/** PostgreSQL's SQLSTATE for a unique-constraint violation. */
export const UNIQUE_VIOLATION = '23505';
/** PostgreSQL's SQLSTATE for a foreign-key violation. */
export const FOREIGN_KEY_VIOLATION = '23503';
/** PostgreSQL's SQLSTATE for a CHECK-constraint violation. */
export const CHECK_VIOLATION = '23514';

export const isPostgresError = (cause: unknown, code: string): boolean =>
  typeof cause === 'object' && cause !== null && (cause as { code?: string }).code === code;
