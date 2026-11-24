/**
 * SQLite database file handling for Phase 5 persistence: opening, connection settings and the
 * versioned schema upgrade. Row mapping and the commit write live in server/persistence.ts; the
 * schema itself lives in server/migrations.ts.
 *
 * Library: Node's built-in `node:sqlite` (DatabaseSync). It is synchronous, which matches the store's
 * rule that an operation and its commit never await (server/state.ts), and it needs no native add-on
 * to compile or download on the demo laptop. It requires Node ^22.13.0 || >=23.4.0 (package.json engines).
 *
 * Connection settings (file databases):
 * - foreign_keys = ON: the schema's references are enforced.
 * - locking_mode = EXCLUSIVE, then an immediate exclusive lock: exactly one server process owns the
 *   file while it runs. A second server pointed at the same file fails at startup (after busy_timeout)
 *   instead of becoming a second, competing source of truth.
 * - synchronous = FULL, and journal_mode = WAL once the schema is checked and current (enableWal): a
 *   commit is on disk before the API answers. WAL is switched on only after the checks, because it
 *   changes the file header, and a database that is refused must be left byte-for-byte unchanged.
 * - busy_timeout = 5000 ms: a restarting dev server waits briefly for the old process to let go.
 * An in-memory database (":memory:", tests and tools) gets foreign_keys only.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Marks a file as a Jeeny INSIDE database ("JEEN"), so another SQLite file is never mistaken for one. */
export const APPLICATION_ID = 0x4a45454e;

export const MEMORY_DATABASE = ":memory:";

/** Default database file for a campus: one file per campus id, like the fleet files. */
export const defaultDatabaseFile = (campusId: string) => `data/${campusId}.sqlite`;

/** A database problem at startup (open, settings, schema, load). Messages never include stored rows. */
export class DatabaseStartupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DatabaseStartupError";
  }
}

export interface Migration {
  /** 1, 2, 3, ... with no gaps. The database records the last applied version in PRAGMA user_version. */
  readonly version: number;
  readonly name: string;
  /** Runs inside the upgrade transaction. Must only change the schema and keep (or convert) existing rows. */
  readonly up: (db: DatabaseSync) => void;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Run `fn` in one IMMEDIATE transaction: all of it commits, or none of it does. Rethrows the original error. */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } catch {
      // The original error is what matters; SQLite may already have rolled back.
    }
    throw err;
  }
}

const pragmaValue = (db: DatabaseSync, name: string): unknown => {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : undefined;
};

export const schemaVersion = (db: DatabaseSync) => Number(pragmaValue(db, "user_version"));
export const applicationId = (db: DatabaseSync) => Number(pragmaValue(db, "application_id"));

/** Tables, indexes, triggers and views, not counting SQLite's own internal objects. */
export const schemaObjectCount = (db: DatabaseSync) =>
  Number((db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() as { n: number }).n);

/**
 * Open a database file (creating it, and its folder, only if missing) and apply the connection
 * settings. Never truncates or replaces an existing file. Throws DatabaseStartupError.
 */
export function openDatabase(file: string): DatabaseSync {
  const memory = file === MEMORY_DATABASE;
  const path = memory ? file : resolve(process.cwd(), file);
  let db: DatabaseSync;
  try {
    if (!memory) mkdirSync(dirname(path), { recursive: true });
    db = new DatabaseSync(path);
  } catch (err) {
    throw new DatabaseStartupError(`Could not open database ${path}: ${errorText(err)}`, { cause: err });
  }
  try {
    db.exec("PRAGMA foreign_keys = ON");
    if (!memory) {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA locking_mode = EXCLUSIVE");
      // Take the exclusive lock now (and keep it, in EXCLUSIVE mode), before reading anything.
      db.exec("BEGIN EXCLUSIVE");
      db.exec("COMMIT");
      db.exec("PRAGMA synchronous = FULL");
    }
    if (pragmaValue(db, "foreign_keys") !== 1) throw new Error("foreign key enforcement is not available");
  } catch (err) {
    try { db.close(); } catch { /* already failing */ }
    const locked = /locked|busy/i.test(errorText(err));
    throw new DatabaseStartupError(
      locked
        ? `Database ${path} is in use by another process (is another Jeeny INSIDE server running with it?): ${errorText(err)}`
        : `Could not configure database ${path}: ${errorText(err)}`,
      { cause: err },
    );
  }
  return db;
}

/**
 * Switch a file database to WAL journal mode (persistent in the file). Call only after the schema was
 * checked and brought up to date. No effect on an in-memory database.
 */
export function enableWal(db: DatabaseSync, file: string): void {
  if (file === MEMORY_DATABASE) return;
  const mode = String(pragmaValue(db, "journal_mode = WAL")).toLowerCase();
  if (mode !== "wal") throw new DatabaseStartupError(`Could not switch database ${file} to WAL journal mode (got "${mode}")`);
}

/** Check that the migration list is 1..n in order with unique versions. A wrong list is a programming error. */
function checkMigrationList(migrations: readonly Migration[]): number {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migration list is out of order: entry ${i} has version ${m.version}, expected ${i + 1}`);
  });
  return migrations.length;
}

export interface MigrateResult {
  /** The schema version found when the database was opened (0 = brand-new, empty database). */
  from: number;
  /** The schema version after the upgrade (always the latest known version). */
  to: number;
  /** True only for a brand-new empty database: the schema was created and `initialize` ran. */
  created: boolean;
}

/**
 * Bring the schema up to the latest version, or refuse.
 * - Newer than this code knows: refused (never downgraded).
 * - Version 0 with existing schema objects: refused (another program's database, or one this code did
 *   not finish creating; it is never treated as empty).
 * - Version 0 and no objects: brand-new. Every migration runs and then `initialize` (first-time seed),
 *   all in ONE transaction, so a failure leaves the file empty and the next start tries again cleanly.
 * - Older known version: every pending migration runs in ONE transaction; on any failure everything is
 *   rolled back to the version found, and the error is thrown (the server must not start).
 * - Otherwise the application id must match, so a foreign SQLite file is never upgraded.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[], initialize?: (db: DatabaseSync) => void): MigrateResult {
  const latest = checkMigrationList(migrations);
  const from = schemaVersion(db);
  if (!Number.isInteger(from) || from < 0) throw new DatabaseStartupError(`Database schema version ${from} is invalid`);
  if (from > latest) {
    throw new DatabaseStartupError(`Database schema version ${from} is newer than this server supports (${latest}). Use the server version that created it; the database was not changed.`);
  }
  const created = from === 0;
  if (created && schemaObjectCount(db) > 0) {
    throw new DatabaseStartupError("Database has tables but no Jeeny INSIDE schema version: it is not a Jeeny INSIDE database, or its creation did not finish. It was not changed.");
  }
  if (!created && applicationId(db) !== APPLICATION_ID) {
    throw new DatabaseStartupError(`Database is not a Jeeny INSIDE database (application id ${applicationId(db)}). It was not changed.`);
  }
  if (from === latest) return { from, to: from, created: false };

  try {
    inTransaction(db, () => {
      for (const m of migrations) {
        if (m.version <= from) continue;
        m.up(db);
        // user_version and application_id live in the database header and roll back with the transaction.
        db.exec(`PRAGMA user_version = ${m.version}`);
      }
      if (created) {
        db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
        initialize?.(db);
      }
    });
  } catch (err) {
    if (err instanceof DatabaseStartupError) throw err;
    throw new DatabaseStartupError(
      created
        ? `Could not create the database schema (nothing was kept): ${errorText(err)}`
        : `Database upgrade from schema version ${from} to ${latest} failed and was rolled back (the database is still at version ${schemaVersion(db)}): ${errorText(err)}`,
      { cause: err },
    );
  }
  const to = schemaVersion(db);
  if (to !== latest) throw new DatabaseStartupError(`Database schema version is ${to} after upgrading, expected ${latest}`);
  return { from, to, created };
}

/** SQLite's own structural checks: page integrity and foreign keys. Throws DatabaseStartupError. */
export function checkIntegrity(db: DatabaseSync): void {
  const quick = db.prepare("PRAGMA quick_check").all() as Record<string, unknown>[];
  const results = quick.map((r) => String(Object.values(r)[0]));
  if (results.length !== 1 || results[0] !== "ok") {
    throw new DatabaseStartupError(`Database integrity check failed: ${results.slice(0, 5).join("; ")}`);
  }
  const fk = db.prepare("PRAGMA foreign_key_check").all() as { table: string }[];
  if (fk.length) throw new DatabaseStartupError(`Database has ${fk.length} broken reference(s), first in table "${fk[0]!.table}"`);
}
