/**
 * Phase 5: the SQLite file, its schema versions, first-time seeding, startup refusals and the
 * database-level constraints. Every test uses its own temporary folder; nothing touches data/ or any
 * developer database. All checks run against real SQLite files (no mocked database calls).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createFleet, type Fleet } from "../engine/fleet";
import { cartAt, lineCampus } from "../engine/testRideFixtures";
import { createRequest, assignCart } from "../engine/rides";
import { tapIn } from "../engine/tapIn";
import { APPLICATION_ID, DatabaseStartupError, type Migration } from "./database";
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from "./migrations";
import { openPersistedState } from "./persistence";
import { openAppStore, type AppStore } from "./state";

const dirs: string[] = [];
const open: AppStore[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "jeeny-db-test-"));
  dirs.push(dir);
  return join(dir, "test.sqlite");
}

const campus = lineCampus();
function lineFleet(): Fleet {
  const f = createFleet(campus, [cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
  if (!f.ok) throw new Error(f.errors.map((e) => e.message).join("; "));
  return f.fleet;
}

function openStore(file: string, options: { migrations?: readonly Migration[]; loadSeedFleet?: () => Fleet; campus?: typeof campus } = {}) {
  const opened = openAppStore({
    campus: options.campus ?? campus, databaseFile: file, loadSeedFleet: options.loadSeedFleet ?? lineFleet, seededFrom: "test fleet",
    ...(options.migrations ? { migrations: options.migrations } : {}),
  });
  open.push(opened.store);
  return opened;
}
const closeAll = () => { for (const s of open.splice(0)) s.close(); };

/** Read-only inspection of a closed database file. */
function inspect<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
/** Raw write to a closed database file (tests only: simulating damage, foreign files, old versions). */
function raw<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file);
  try { return fn(db); } finally { db.close(); }
}
const version = (db: DatabaseSync) => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
const schemaObjects = (db: DatabaseSync) => db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

/** A database with one shared request on a trip and a Tap-In record, built through the real store. */
function populated(file: string) {
  const { store } = openStore(file);
  const r = store.apply((s) => createRequest(s, { studentId: "stu-lina", pickupId: "b", destinationId: "d", mode: "shared" }), "ride_request.created");
  if (!r.ok) throw new Error("create failed");
  expect(store.apply((s) => assignCart(s, "REQ-0001", "CART-01"), "ride.dispatched").ok).toBe(true);
  expect(store.apply((s) => tapIn(s, "REQ-0001", { studentId: "stu-lina", campusId: "line", pointId: "b" }), "ride.tapped_in").ok).toBe(true);
  closeAll();
}

describe("first-time initialization", () => {
  it("a new database gets the schema, the latest version, the application id and the seed, in one go", () => {
    const file = tempDb();
    const opened = openStore(file);
    expect(opened.created).toBe(true);
    expect(opened.revision).toBe(0);
    expect(opened.store.read((s, rev) => ({ rev, carts: [...s.fleet.carts.keys()], requests: s.requests.size, trips: s.trips.size, clock: s.clockSeconds })))
      .toEqual({ rev: 0, carts: ["CART-01", "CART-02"], requests: 0, trips: 0, clock: 0 });
    closeAll();
    inspect(file, (db) => {
      expect(version(db)).toBe(LATEST_SCHEMA_VERSION);
      expect((db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id).toBe(APPLICATION_ID);
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(db.prepare("SELECT campus_id, revision, clock_seconds, next_request_no, next_trip_no, seeded_from FROM app_state").all())
        .toEqual([{ campus_id: "line", revision: 0, clock_seconds: 0, next_request_no: 1, next_trip_no: 1, seeded_from: "test fleet" }]);
      expect(count(db, "carts")).toBe(2);
      expect(count(db, "ride_requests") + count(db, "trips") + count(db, "trip_passengers")).toBe(0);
    });
  });

  it("restarting never re-runs the schema or the seed, and never reads the fleet file again", () => {
    const file = tempDb();
    openStore(file);
    closeAll();
    const before = inspect(file, schemaObjects);
    const seedFleet = vi.fn(lineFleet);
    for (let i = 0; i < 3; i++) {
      const again = openStore(file, { loadSeedFleet: seedFleet });
      expect(again.created).toBe(false);
      closeAll();
    }
    expect(seedFleet).not.toHaveBeenCalled();
    inspect(file, (db) => {
      expect(schemaObjects(db)).toEqual(before);
      expect(count(db, "app_state")).toBe(1);
      expect(count(db, "carts")).toBe(2);
      expect(version(db)).toBe(LATEST_SCHEMA_VERSION);
    });
  });

  it("a failed first-time seed keeps nothing, so the next start initializes cleanly", () => {
    const file = tempDb();
    expect(() => openStore(file, { loadSeedFleet: () => { throw new Error("Could not read fleet file x.json"); } }))
      .toThrow(/Could not create the database schema \(nothing was kept\): Could not read fleet file/);
    inspect(file, (db) => {
      expect(version(db)).toBe(0);
      expect(schemaObjects(db)).toEqual([]);
    });
    expect(openStore(file).created).toBe(true);
  });

  it("a fleet the engine refuses fails startup with the engine's reason and keeps nothing", () => {
    const file = tempDb();
    const valley = createFleet({ ...campus, id: "other" }, [cartAt("CART-01", "a")]);
    if (!valley.ok) throw new Error("fixture");
    expect(() => openStore(file, { loadSeedFleet: () => valley.fleet })).toThrow(/Could not start the ride engine: The fleet was built for campus "other"/);
    inspect(file, (db) => expect(schemaObjects(db)).toEqual([]));
  });
});

describe("schema upgrades", () => {
  const V2: Migration = {
    version: 2, name: "test: add a note column",
    up: (db) => db.exec("ALTER TABLE ride_requests ADD COLUMN test_note TEXT NOT NULL DEFAULT 'none'"),
  };

  it("pending migrations upgrade an older database and keep every record", () => {
    const file = tempDb();
    populated(file);
    const v1 = openStore(file);
    const before = v1.store.read((s, rev) => ({ rev, requests: [...s.requests.values()], trips: [...s.trips.values()], carts: [...s.fleet.carts.values()] }));
    closeAll();

    const up = vi.fn(V2.up);
    const upgraded = openStore(file, { migrations: [...MIGRATIONS, { ...V2, up }] });
    expect(up).toHaveBeenCalledTimes(1);
    expect(upgraded.created).toBe(false);
    expect(upgraded.store.read((s, rev) => ({ rev, requests: [...s.requests.values()], trips: [...s.trips.values()], carts: [...s.fleet.carts.values()] }))).toEqual(before);
    closeAll();
    inspect(file, (db) => {
      expect(version(db)).toBe(2);
      expect(db.prepare("SELECT id, test_note FROM ride_requests").all()).toEqual([{ id: "REQ-0001", test_note: "none" }]);
    });

    // Already at version 2: nothing is applied again.
    openStore(file, { migrations: [...MIGRATIONS, { ...V2, up }] });
    expect(up).toHaveBeenCalledTimes(1);
  });

  it("a failing migration is rolled back completely and the server does not start", () => {
    const file = tempDb();
    populated(file);
    const broken: Migration = {
      version: 2, name: "test: fails half way",
      up: (db) => {
        db.exec("CREATE TABLE half_done (id INTEGER)");
        db.exec("ALTER TABLE ride_requests ADD COLUMN half TEXT");
        throw new Error("simulated migration failure");
      },
    };
    expect(() => openStore(file, { migrations: [...MIGRATIONS, broken] }))
      .toThrow(/upgrade from schema version 1 to 2 failed and was rolled back \(the database is still at version 1\): simulated migration failure/);
    inspect(file, (db) => {
      expect(version(db)).toBe(1);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").all()).toEqual([]);
      expect((db.prepare("SELECT * FROM ride_requests").get() as Record<string, unknown>).half).toBeUndefined();
    });
    // The untouched version-1 database still opens with the real migrations, records intact.
    expect(openStore(file).store.read((s) => s.requests.get("REQ-0001")?.status)).toBe("assigned");
  });

  it("a database newer than this server is refused and left unchanged", () => {
    const file = tempDb();
    populated(file);
    raw(file, (db) => db.exec("PRAGMA user_version = 99"));
    const bytes = readFileSync(file);
    expect(() => openStore(file)).toThrow(DatabaseStartupError);
    expect(() => openStore(file)).toThrow(/schema version 99 is newer than this server supports \(1\)/);
    expect(readFileSync(file).equals(bytes)).toBe(true);
  });

  it("an out-of-order migration list is a programming error", () => {
    const file = tempDb();
    expect(() => openStore(file, { migrations: [{ ...MIGRATIONS[0]!, version: 2 }] })).toThrow(/out of order/);
  });
});

describe("startup refuses databases it cannot trust", () => {
  it("another program's SQLite file (tables, no version) is refused, never seeded or changed", () => {
    const file = tempDb();
    raw(file, (db) => db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes (body) VALUES ('keep me')"));
    const bytes = readFileSync(file);
    expect(() => openStore(file)).toThrow(/not a Jeeny INSIDE database, or its creation did not finish/);
    expect(readFileSync(file).equals(bytes)).toBe(true);
    inspect(file, (db) => {
      expect(version(db)).toBe(0);
      expect(db.prepare("SELECT body FROM notes").all()).toEqual([{ body: "keep me" }]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'app_state'").all()).toEqual([]);
    });
  });

  it("a versioned file with another application id is refused", () => {
    const file = tempDb();
    raw(file, (db) => db.exec("CREATE TABLE t (x); PRAGMA user_version = 1; PRAGMA application_id = 42"));
    const bytes = readFileSync(file);
    expect(() => openStore(file)).toThrow(/not a Jeeny INSIDE database \(application id 42\)/);
    expect(readFileSync(file).equals(bytes)).toBe(true);
  });

  it("a schema without its initialization record is refused, not re-seeded", () => {
    const file = tempDb();
    populated(file);
    raw(file, (db) => db.exec("DELETE FROM app_state"));
    expect(() => openStore(file)).toThrow(/no initialization record/);
    inspect(file, (db) => {
      expect(count(db, "app_state")).toBe(0);
      expect(count(db, "carts")).toBe(2);
      expect(count(db, "ride_requests")).toBe(1);
    });
  });

  it("a file that is not a database is refused and left unchanged", () => {
    const file = tempDb();
    writeFileSync(file, "this is not a database, just some text that must survive ".repeat(200));
    const bytes = readFileSync(file);
    expect(() => openStore(file)).toThrow(DatabaseStartupError);
    expect(readFileSync(file).equals(bytes)).toBe(true);
  });

  it("saved rows that break a ride invariant are refused with the engine's reason, and not repaired", () => {
    const file = tempDb();
    populated(file);
    raw(file, (db) => db.exec("UPDATE ride_requests SET status = 'requested' WHERE id = 'REQ-0001'"));
    expect(() => openStore(file)).toThrow(/Saved ride state fails the engine's checks and was not loaded: .*REQ-0001 is requested but has a trip/);
    inspect(file, (db) => expect(db.prepare("SELECT status FROM ride_requests").get()).toEqual({ status: "requested" }));
  });

  it("an id counter that would reuse a saved id is refused", () => {
    const file = tempDb();
    populated(file);
    raw(file, (db) => db.exec("UPDATE app_state SET next_request_no = 1"));
    expect(() => openStore(file)).toThrow(/Saved ride request id "REQ-0001" does not fit the saved id counter \(1\)/);
  });

  it("a database for another campus, or for a changed campus file, is refused", () => {
    const file = tempDb();
    populated(file);
    const other = lineCampus({ id: "other-line" });
    expect(() => openStore(file, { campus: other })).toThrow(/belongs to campus "line", but the loaded campus is "other-line"/);
    const renamed = lineCampus({ name: "Line (renamed)" });
    expect(() => openStore(file, { campus: renamed })).toThrow(/campus file for "line" changed since this database was created/);
  });

  it("a second server cannot open a database that is already in use", () => {
    const file = tempDb();
    openStore(file);
    const started = Date.now();
    expect(() => openPersistedState({ campus, databaseFile: file, loadSeedFleet: lineFleet, seededFrom: "x" })).toThrow(/is in use by another process/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4000); // waited for busy_timeout first
  }, 15000);
});

describe("database-level constraints (a second line of defence behind the engine)", () => {
  function populatedClosed() {
    const file = tempDb();
    populated(file);
    return file;
  }
  const expectRefused = (file: string, sql: string, message: RegExp) => raw(file, (db) => {
    db.exec("PRAGMA foreign_keys = ON");
    expect(() => db.exec(sql)).toThrow(message);
  });

  it("Tap-In records are write-once: no update and no delete-and-reinsert", () => {
    const file = populatedClosed();
    expectRefused(file, "UPDATE trip_passengers SET tapped_in_location_id = 'c' WHERE request_id = 'REQ-0001'", /Tap-In records are write-once/);
    expectRefused(file, "UPDATE trip_passengers SET tapped_in_at_ms = 5 WHERE request_id = 'REQ-0001'", /Tap-In records are write-once/);
    expectRefused(file, "UPDATE trip_passengers SET tapped_in_location_id = NULL, tapped_in_at_ms = NULL WHERE request_id = 'REQ-0001'", /Tap-In records are write-once/);
    expectRefused(file, "DELETE FROM trip_passengers WHERE request_id = 'REQ-0001'", /never deleted/);
    // Rewriting the same values is not a change and is allowed (every commit upserts a trip's riders).
    raw(file, (db) => db.exec("UPDATE trip_passengers SET tapped_in_location_id = tapped_in_location_id, tapped_in_at_ms = tapped_in_at_ms"));
    inspect(file, (db) => expect(db.prepare("SELECT tapped_in_location_id AS loc, tapped_in_at_ms AS at FROM trip_passengers").get()).toEqual({ loc: "b", at: 0 }));
  });

  it("a rider's solo baseline and place on the trip never change", () => {
    const file = populatedClosed();
    expectRefused(file, "UPDATE trip_passengers SET baseline_json = '{}' WHERE request_id = 'REQ-0001'", /baselines are write-once/);
    expectRefused(file, "UPDATE trip_passengers SET position = 3 WHERE request_id = 'REQ-0001'", /cannot move/);
  });

  it("a request is on at most one trip, and a cart on at most one open trip", () => {
    const file = populatedClosed();
    expectRefused(file, `INSERT INTO trips (id, cart_id, status, stop_index, stops_json, leg_json, driven_seconds) VALUES ('TRIP-0002', 'CART-01', 'planned', 0, '[]', NULL, 0)`, /UNIQUE constraint failed: trips.cart_id/);
    raw(file, (db) => db.exec(`INSERT INTO trips (id, cart_id, status, stop_index, stops_json, leg_json, driven_seconds) VALUES ('TRIP-0002', 'CART-02', 'planned', 0, '[]', NULL, 0)`));
    expectRefused(file, "INSERT INTO trip_passengers (request_id, trip_id, position, boarded, dropped_off, cancelled) VALUES ('REQ-0001', 'TRIP-0002', 0, 0, 0, 0)", /UNIQUE constraint failed: trip_passengers.request_id/);
  });

  it("references and value checks are enforced", () => {
    const file = populatedClosed();
    expectRefused(file, "INSERT INTO trips (id, cart_id, status, stop_index, stops_json, leg_json, driven_seconds) VALUES ('TRIP-0009', 'CART-99', 'completed', 0, '[]', NULL, 0)", /FOREIGN KEY constraint failed/);
    expectRefused(file, "INSERT INTO trip_passengers (request_id, trip_id, position, boarded, dropped_off, cancelled) VALUES ('REQ-0404', 'TRIP-0001', 1, 0, 0, 0)", /FOREIGN KEY constraint failed/);
    expectRefused(file, "UPDATE carts SET status = 'flying' WHERE id = 'CART-02'", /CHECK constraint failed/);
    expectRefused(file, "UPDATE carts SET passenger_count = 2 WHERE id = 'CART-02'", /CHECK constraint failed/);
    expectRefused(file, "UPDATE ride_requests SET destination_id = pickup_id", /CHECK constraint failed/);
    expectRefused(file, "UPDATE trip_passengers SET dropped_off = 1 WHERE request_id = 'REQ-0001'", /CHECK constraint failed/);
    expectRefused(file, "INSERT INTO app_state (id, campus_id, campus_fingerprint, revision, clock_seconds, next_request_no, next_trip_no, initialized_at, seeded_from) SELECT 2, campus_id, campus_fingerprint, 0, 0, 1, 1, 'x', 'x' FROM app_state", /CHECK constraint failed/);
  });
});
