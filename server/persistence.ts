/**
 * SQLite persistence for the ride state (Phase 5): first-time seed, startup load, and the one
 * transaction written for each committed operation. server/state.ts decides WHEN to write (before a
 * new state becomes authoritative); this file decides WHAT is written and how rows map to engine data.
 *
 * Model: relational tables (server/migrations.ts). Carts, ride requests, trips and trip passengers are
 * rows; a trip's ordered stop list, its current leg and a rider's solo baseline are JSON columns because
 * they are small, always read and written whole with their row, and are checked by the engine's schemas
 * on load. Each commit writes only the entities the operation replaced (the engine keeps unchanged
 * entities as the same frozen objects, the same rule the realtime update uses), plus the clock, id
 * counters and revision, in ONE transaction.
 *
 * The database is the durable copy and the in-memory state is the working copy of the same data: the
 * store writes here first and only then swaps its in-memory state, so they never disagree.
 * Nothing here logs or returns stored rows; error messages name ids and constraints only.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { CampusConfig, Cart, RideRequest, Trip } from "../shared/schemas.js";
import { createFleet, type Fleet } from "../engine/fleet.js";
import { createRideState, restoreRideState, type RideState } from "../engine/rides.js";
import { DatabaseStartupError, MEMORY_DATABASE, checkIntegrity, enableWal, inTransaction, migrate, openDatabase, type Migration } from "./database.js";
import { MIGRATIONS } from "./migrations.js";

/** A commit to write: the state it replaces (at `revision - 1`) and the new state (at `revision`). */
export interface CommitToSave {
  revision: number;
  previous: RideState;
  state: RideState;
}

/** How the store saves commits. `save` writes all of a commit or nothing, and throws if it did not commit. */
export interface StatePersistence {
  save(commit: CommitToSave): void;
  close(): void;
}

/** A commit could not be saved. Nothing of it was written and the in-memory state was not changed. */
export class PersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PersistenceError";
  }
}

/** Which campus the rows belong to: sha-256 of the validated campus config. Any change to the campus file changes it. */
export function campusFingerprint(campus: CampusConfig): string {
  return createHash("sha256").update(JSON.stringify(campus)).digest("hex");
}

// ---------- Row mapping ----------

type Row = Record<string, unknown>;
const b = (v: boolean) => (v ? 1 : 0);
const num = (v: unknown) => v as number;
const str = (v: unknown) => v as string;

function cartParams(c: Readonly<Cart>) {
  const pos = c.position;
  return {
    id: c.id, label: c.label, seats: c.seats, max_speed_kmh: c.maxSpeedKmh, simulated: b(c.simulated), status: c.status,
    position_kind: pos.kind,
    location_id: pos.kind === "at" ? pos.locationId : null,
    path_id: pos.kind === "on_path" ? pos.pathId : null,
    progress: pos.kind === "on_path" ? pos.progress : null,
    battery_percent: c.batteryPercent, range_km: c.rangeKm, passenger_count: c.passengerCount, driver_id: c.driverId,
  };
}

function cartFromRow(r: Row): unknown {
  return {
    id: str(r.id), label: str(r.label), seats: num(r.seats), maxSpeedKmh: num(r.max_speed_kmh), simulated: r.simulated === 1,
    status: str(r.status),
    position: r.position_kind === "at"
      ? { kind: "at", locationId: str(r.location_id) }
      : { kind: "on_path", pathId: str(r.path_id), progress: num(r.progress) },
    batteryPercent: num(r.battery_percent), rangeKm: num(r.range_km), passengerCount: num(r.passenger_count),
    driverId: r.driver_id === null ? null : str(r.driver_id),
  };
}

function requestParams(r: Readonly<RideRequest>) {
  return {
    id: r.id, student_id: r.studentId, pickup_id: r.pickupId, destination_id: r.destinationId, mode: r.mode,
    priority: b(r.priority), status: r.status, created_at: r.createdAt, updated_at: r.updatedAt,
    fare_jod: r.fareJod, free_loyalty_ride: b(r.freeLoyaltyRide),
  };
}

function requestFromRow(r: Row): unknown {
  return {
    id: str(r.id), studentId: str(r.student_id), pickupId: str(r.pickup_id), destinationId: str(r.destination_id),
    mode: str(r.mode), priority: r.priority === 1, status: str(r.status), createdAt: num(r.created_at), updatedAt: num(r.updated_at),
    fareJod: num(r.fare_jod), freeLoyaltyRide: r.free_loyalty_ride === 1,
  };
}

function tripParams(t: Readonly<Trip>) {
  return {
    id: t.id, cart_id: t.cartId, status: t.status, stop_index: t.stopIndex,
    stops_json: JSON.stringify(t.stops), leg_json: t.leg ? JSON.stringify(t.leg) : null, driven_seconds: t.drivenSeconds,
  };
}

function passengerParams(tripId: string, position: number, p: Readonly<Trip["passengers"][number]>) {
  return {
    request_id: p.requestId, trip_id: tripId, position, boarded: b(p.boarded), dropped_off: b(p.droppedOff), cancelled: b(p.cancelled),
    baseline_json: p.baseline ? JSON.stringify(p.baseline) : null,
    tapped_in_location_id: p.tappedIn ? p.tappedIn.locationId : null,
    tapped_in_at_ms: p.tappedIn ? p.tappedIn.atMs : null,
  };
}

function passengerFromRow(r: Row): unknown {
  return {
    requestId: str(r.request_id), boarded: r.boarded === 1, droppedOff: r.dropped_off === 1, cancelled: r.cancelled === 1,
    ...(r.baseline_json === null ? {} : { baseline: JSON.parse(str(r.baseline_json)) }),
    ...(r.tapped_in_location_id === null ? {} : { tappedIn: { locationId: str(r.tapped_in_location_id), atMs: num(r.tapped_in_at_ms) } }),
  };
}

const CART_COLUMNS = ["id", "label", "seats", "max_speed_kmh", "simulated", "status", "position_kind", "location_id", "path_id", "progress", "battery_percent", "range_km", "passenger_count", "driver_id"];
const REQUEST_COLUMNS = ["id", "student_id", "pickup_id", "destination_id", "mode", "priority", "status", "created_at", "updated_at", "fare_jod", "free_loyalty_ride"];
const TRIP_COLUMNS = ["id", "cart_id", "status", "stop_index", "stops_json", "leg_json", "driven_seconds"];
const PASSENGER_COLUMNS = ["request_id", "trip_id", "position", "boarded", "dropped_off", "cancelled", "baseline_json", "tapped_in_location_id", "tapped_in_at_ms"];

/** INSERT ... ON CONFLICT DO UPDATE with named parameters only (column names are constants, never input). */
function upsertSql(table: string, columns: string[], key: string): string {
  const updates = columns.filter((c) => c !== key).map((c) => `${c} = excluded.${c}`).join(", ");
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((c) => `:${c}`).join(", ")}) ON CONFLICT (${key}) DO UPDATE SET ${updates}`;
}

/** Entries that are new or replaced in `next` (same identity rule as server/realtime.ts). */
function changed<T extends { id: string }>(prev: ReadonlyMap<string, T>, next: ReadonlyMap<string, T>): T[] {
  return [...next.values()].filter((v) => prev.get(v.id) !== v);
}

// ---------- Seed ----------

/**
 * First-time initialization of a brand-new database (runs inside the schema-creation transaction):
 * the app_state row (the initialization marker) and the starting carts. Requests and trips start empty,
 * exactly like a fresh in-memory state did before Phase 5.
 */
function seed(db: DatabaseSync, initial: RideState, seededFrom: string): void {
  db.prepare(`INSERT INTO app_state (id, campus_id, campus_fingerprint, revision, clock_seconds, next_request_no, next_trip_no, initialized_at, seeded_from)
              VALUES (1, :campus_id, :fp, 0, :clock, :nr, :nt, :at, :from)`).run({
    campus_id: initial.campus.id, fp: campusFingerprint(initial.campus), clock: initial.clockSeconds,
    nr: initial.nextRequestNo, nt: initial.nextTripNo, at: new Date().toISOString(), from: seededFrom,
  });
  const insertCart = db.prepare(`INSERT INTO carts (${CART_COLUMNS.join(", ")}) VALUES (${CART_COLUMNS.map((c) => `:${c}`).join(", ")})`);
  for (const c of initial.fleet.carts.values()) insertCart.run(cartParams(c));
}

// ---------- Load ----------

interface Loaded {
  state: RideState;
  revision: number;
}

/**
 * Read the whole saved ride state and rebuild it with the engine's own checks (restoreRideState).
 * Throws DatabaseStartupError if the rows belong to another campus or fail any check; never repairs.
 */
export function loadRideState(db: DatabaseSync, campus: CampusConfig): Loaded {
  const metaRows = db.prepare("SELECT * FROM app_state").all() as Row[];
  if (metaRows.length !== 1) {
    throw new DatabaseStartupError("Database has a schema but no initialization record: it is incomplete or damaged and was not changed (it is never re-seeded over).");
  }
  const meta = metaRows[0]!;
  if (meta.campus_id !== campus.id) {
    throw new DatabaseStartupError(`Database belongs to campus "${str(meta.campus_id)}", but the loaded campus is "${campus.id}". Use that campus, or another database file (--db=).`);
  }
  if (meta.campus_fingerprint !== campusFingerprint(campus)) {
    throw new DatabaseStartupError(`The campus file for "${campus.id}" changed since this database was created, so its saved rides may not fit the map. Restore the original campus file, or start with another database file (--db=).`);
  }

  const fleet = createFleet(campus, (db.prepare("SELECT * FROM carts ORDER BY id").all() as Row[]).map(cartFromRow));
  if (!fleet.ok) throw new DatabaseStartupError(`Saved carts are invalid: ${fleet.errors.map((e) => e.message).join("; ")}`);
  const requests = (db.prepare("SELECT * FROM ride_requests ORDER BY id").all() as Row[]).map(requestFromRow);

  const passengersByTrip = new Map<string, Row[]>();
  for (const p of db.prepare("SELECT * FROM trip_passengers ORDER BY trip_id, position").all() as Row[]) {
    const list = passengersByTrip.get(str(p.trip_id)) ?? [];
    if (num(p.position) !== list.length) throw new DatabaseStartupError(`Saved trip ${str(p.trip_id)} has a gap in its passenger order`);
    list.push(p);
    passengersByTrip.set(str(p.trip_id), list);
  }
  const trips = (db.prepare("SELECT * FROM trips ORDER BY id").all() as Row[]).map((t) => {
    let stops: unknown;
    let leg: unknown;
    try {
      stops = JSON.parse(str(t.stops_json));
      leg = t.leg_json === null ? null : JSON.parse(str(t.leg_json));
    } catch {
      throw new DatabaseStartupError(`Saved trip ${str(t.id)} has unreadable stop or leg data`);
    }
    return {
      id: str(t.id), cartId: str(t.cart_id), stops, passengers: (passengersByTrip.get(str(t.id)) ?? []).map(passengerFromRow),
      status: str(t.status), stopIndex: num(t.stop_index), leg, drivenSeconds: num(t.driven_seconds),
    };
  });

  const restored = restoreRideState(campus, fleet.fleet, {
    requests, trips, clockSeconds: num(meta.clock_seconds), nextRequestNo: num(meta.next_request_no), nextTripNo: num(meta.next_trip_no),
  });
  if (!restored.ok) throw new DatabaseStartupError(`Saved ride state fails the engine's checks and was not loaded: ${restored.error.message}`);
  const revision = num(meta.revision);
  if (!Number.isInteger(revision) || revision < 0) throw new DatabaseStartupError(`Saved revision ${revision} is invalid`);
  return { state: restored.state, revision };
}

// ---------- Commit writes ----------

function createSqlitePersistence(db: DatabaseSync): StatePersistence {
  let closed = false;
  const st: Record<string, StatementSync> = {
    cart: db.prepare(upsertSql("carts", CART_COLUMNS, "id")),
    request: db.prepare(upsertSql("ride_requests", REQUEST_COLUMNS, "id")),
    trip: db.prepare(upsertSql("trips", TRIP_COLUMNS, "id")),
    passenger: db.prepare(upsertSql("trip_passengers", PASSENGER_COLUMNS, "request_id")),
    passengerCount: db.prepare("SELECT count(*) AS n FROM trip_passengers WHERE trip_id = ?"),
    meta: db.prepare(`UPDATE app_state SET revision = :revision, clock_seconds = :clock, next_request_no = :nr, next_trip_no = :nt
                      WHERE id = 1 AND revision = :expected`),
  };
  return {
    save({ revision, previous, state }: CommitToSave): void {
      if (closed) throw new PersistenceError(`Could not save revision ${revision}: the database is closed`);
      try {
        inTransaction(db, () => {
          for (const c of changed(previous.fleet.carts, state.fleet.carts)) st.cart!.run(cartParams(c));
          for (const r of changed(previous.requests, state.requests)) st.request!.run(requestParams(r));
          // Trips that release their cart first, so the one-open-trip-per-cart index never sees two at once.
          const trips = changed(previous.trips, state.trips).sort((x, y) => Number(x.status !== "completed" && x.status !== "cancelled") - Number(y.status !== "completed" && y.status !== "cancelled"));
          for (const t of trips) {
            st.trip!.run(tripParams(t));
            t.passengers.forEach((p, i) => st.passenger!.run(passengerParams(t.id, i, p)));
            const stored = num((st.passengerCount!.get(t.id) as Row).n);
            if (stored !== t.passengers.length) throw new Error(`trip ${t.id} has ${stored} saved passengers but ${t.passengers.length} in the new state`);
          }
          const meta = st.meta!.run({ revision, clock: state.clockSeconds, nr: state.nextRequestNo, nt: state.nextTripNo, expected: revision - 1 });
          if (Number(meta.changes) !== 1) throw new Error(`the saved revision is not ${revision - 1}; another writer changed the database`);
        });
      } catch (err) {
        throw new PersistenceError(`Could not save revision ${revision}; nothing was written: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

// ---------- Startup ----------

export interface OpenPersistedStateOptions {
  /** The validated campus (server/campus.ts loadCampus). */
  campus: CampusConfig;
  /** Database file path, or ":memory:" for a database that lives only as long as the process. */
  databaseFile: string;
  /** Loads the starting fleet. Called ONLY when the database is brand-new and empty (first-time seed). */
  loadSeedFleet: () => Fleet;
  /** Recorded in app_state.seeded_from, for example the fleet file path. */
  seededFrom: string;
  /** For tests of the upgrade path; production always uses MIGRATIONS. */
  migrations?: readonly Migration[];
}

export interface PersistedState {
  state: RideState;
  revision: number;
  persistence: StatePersistence;
  /** True when this start created and seeded the database. */
  created: boolean;
  /** The open connection (tests inspect rows through it). Owned by `persistence`; close through it. */
  db: DatabaseSync;
}

/**
 * The startup sequence: open the file and apply its settings, upgrade the schema (seeding only a
 * brand-new database, in the same transaction), run SQLite's integrity checks, check the campus, load
 * the rows and validate them with every engine rule, and only then switch the file to WAL. Any failure closes the database and throws
 * DatabaseStartupError; nothing is ever replaced, re-seeded or defaulted.
 */
export function openPersistedState(options: OpenPersistedStateOptions): PersistedState {
  const { campus, databaseFile, loadSeedFleet, seededFrom, migrations = MIGRATIONS } = options;
  const db = openDatabase(databaseFile);
  try {
    const { created } = migrate(db, migrations, (tx) => {
      const initial = createRideState(campus, loadSeedFleet());
      if (!initial.ok) throw new Error(`Could not start the ride engine: ${initial.error.message}`);
      seed(tx, initial.state, seededFrom);
    });
    checkIntegrity(db);
    const { state, revision } = loadRideState(db, campus);
    enableWal(db, databaseFile);
    return { state, revision, persistence: createSqlitePersistence(db), created, db };
  } catch (err) {
    try { db.close(); } catch { /* already failing */ }
    if (err instanceof DatabaseStartupError) throw err;
    throw new DatabaseStartupError(`Could not load database ${databaseFile === MEMORY_DATABASE ? "(in memory)" : databaseFile}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}
