/**
 * The database schema, as ordered migrations (Phase 5). server/database.ts `migrate` runs them.
 *
 * Adding a schema change later:
 * 1. Append a new entry with the next version number. Never edit, reorder or remove an entry that has
 *    shipped: databases that already ran it will not run it again.
 * 2. Keep existing rows: add columns with a default, or copy rows into a rebuilt table, inside `up`.
 * 3. Update the row mapping in server/persistence.ts and add a test that upgrades a database created
 *    at the previous version with real rows in it (see server/persistence.test.ts).
 * Every pending migration runs in one transaction with the version bump, so a failure leaves the
 * database exactly at the version it had.
 *
 * What is stored: the mutable ride state only (carts, ride requests, trips, trip passengers, the clock,
 * the id counters and the realtime revision). The campus stays in its config file; the database records
 * which campus (id and content fingerprint) its rows belong to. Location and path ids inside rows are
 * checked against that campus by the engine's invariants when the state is loaded.
 *
 * Constraints mirror rules the engine already enforces (shared/schemas.ts, engine/rides.ts
 * checkRideInvariants); they are a second line of defence and never add a new product rule.
 */
import type { Migration } from "./database.js";

const CART_STATUSES = "'idle','assigned','occupied','charging','offline','maintenance'";
const REQUEST_STATUSES = "'requested','assigned','arriving','on_board','completed','cancelled'";
const TRIP_STATUSES = "'planned','active','cancelling','completed','cancelled'";
/** engine/rides.ts OPEN_TRIP_STATUSES: trips that still hold their cart. */
const OPEN_TRIP_STATUSES = "'planned','active','cancelling'";
const bool = (col: string) => `${col} INTEGER NOT NULL CHECK (${col} IN (0, 1))`;

const V1_SCHEMA = `
CREATE TABLE app_state (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  campus_id          TEXT    NOT NULL CHECK (length(campus_id) > 0),
  campus_fingerprint TEXT    NOT NULL CHECK (length(campus_fingerprint) = 64),
  revision           INTEGER NOT NULL CHECK (revision >= 0),
  clock_seconds      REAL    NOT NULL CHECK (clock_seconds >= 0),
  next_request_no    INTEGER NOT NULL CHECK (next_request_no >= 1),
  next_trip_no       INTEGER NOT NULL CHECK (next_trip_no >= 1),
  initialized_at     TEXT    NOT NULL,
  seeded_from        TEXT    NOT NULL
) STRICT;

CREATE TABLE carts (
  id              TEXT    PRIMARY KEY CHECK (id GLOB 'CART-[0-9][0-9]'),
  label           TEXT    NOT NULL CHECK (length(label) > 0),
  seats           INTEGER NOT NULL CHECK (seats BETWEEN 1 AND 8),
  max_speed_kmh   REAL    NOT NULL CHECK (max_speed_kmh > 0 AND max_speed_kmh <= 40),
  ${bool("simulated")},
  status          TEXT    NOT NULL CHECK (status IN (${CART_STATUSES})),
  position_kind   TEXT    NOT NULL CHECK (position_kind IN ('at', 'on_path')),
  location_id     TEXT,
  path_id         TEXT,
  progress        REAL,
  battery_percent REAL    NOT NULL CHECK (battery_percent BETWEEN 0 AND 100),
  range_km        REAL    NOT NULL CHECK (range_km >= 0),
  passenger_count INTEGER NOT NULL CHECK (passenger_count >= 0 AND passenger_count <= seats),
  driver_id       TEXT,
  CHECK ((position_kind = 'at' AND location_id IS NOT NULL AND path_id IS NULL AND progress IS NULL)
      OR (position_kind = 'on_path' AND location_id IS NULL AND path_id IS NOT NULL AND progress BETWEEN 0 AND 1)),
  CHECK ((status = 'occupied') = (passenger_count > 0))
) STRICT;

CREATE TABLE ride_requests (
  id                TEXT    PRIMARY KEY CHECK (id GLOB 'REQ-[0-9]*'),
  student_id        TEXT    NOT NULL CHECK (length(student_id) > 0),
  pickup_id         TEXT    NOT NULL,
  destination_id    TEXT    NOT NULL,
  mode              TEXT    NOT NULL CHECK (mode IN ('solo', 'shared')),
  ${bool("priority")},
  status            TEXT    NOT NULL CHECK (status IN (${REQUEST_STATUSES})),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  fare_jod          REAL    NOT NULL CHECK (fare_jod >= 0),
  ${bool("free_loyalty_ride")},
  CHECK (pickup_id <> destination_id)
) STRICT;

CREATE TABLE trips (
  id             TEXT    PRIMARY KEY CHECK (id GLOB 'TRIP-[0-9]*'),
  cart_id        TEXT    NOT NULL REFERENCES carts (id),
  status         TEXT    NOT NULL CHECK (status IN (${TRIP_STATUSES})),
  stop_index     INTEGER NOT NULL CHECK (stop_index >= 0),
  stops_json     TEXT    NOT NULL CHECK (json_valid(stops_json) AND json_type(stops_json) = 'array'),
  leg_json       TEXT             CHECK (leg_json IS NULL OR json_valid(leg_json)),
  driven_seconds REAL    NOT NULL CHECK (driven_seconds >= 0),
  CHECK ((status IN ('active', 'cancelling')) = (leg_json IS NOT NULL))
) STRICT;

-- A cart is on at most one open trip.
CREATE UNIQUE INDEX trips_one_open_trip_per_cart ON trips (cart_id) WHERE status IN (${OPEN_TRIP_STATUSES});

-- One row per rider on a trip. A request is on at most one trip (request_id is the key), once.
CREATE TABLE trip_passengers (
  request_id            TEXT    PRIMARY KEY REFERENCES ride_requests (id),
  trip_id               TEXT    NOT NULL REFERENCES trips (id),
  position              INTEGER NOT NULL CHECK (position >= 0),
  ${bool("boarded")},
  ${bool("dropped_off")},
  ${bool("cancelled")},
  baseline_json         TEXT    CHECK (baseline_json IS NULL OR json_valid(baseline_json)),
  tapped_in_location_id TEXT,
  tapped_in_at_ms       INTEGER CHECK (tapped_in_at_ms >= 0),
  UNIQUE (trip_id, position),
  CHECK (NOT (dropped_off = 1 AND boarded = 0)),
  CHECK (NOT (cancelled = 1 AND boarded = 1)),
  CHECK ((tapped_in_location_id IS NULL) = (tapped_in_at_ms IS NULL))
) STRICT;

CREATE INDEX trip_passengers_by_trip ON trip_passengers (trip_id, position);

-- Tap-In records are write-once history (Phase 4): once written they never change.
CREATE TRIGGER trip_passengers_tap_in_write_once
BEFORE UPDATE OF tapped_in_location_id, tapped_in_at_ms ON trip_passengers
WHEN OLD.tapped_in_location_id IS NOT NULL
 AND (NEW.tapped_in_location_id IS NOT OLD.tapped_in_location_id OR NEW.tapped_in_at_ms IS NOT OLD.tapped_in_at_ms)
BEGIN
  SELECT RAISE(ABORT, 'Tap-In records are write-once');
END;

-- A rider's solo baseline (Phase 4, D2) is written once and never changed afterwards.
CREATE TRIGGER trip_passengers_baseline_write_once
BEFORE UPDATE OF baseline_json ON trip_passengers
WHEN OLD.baseline_json IS NOT NULL AND NEW.baseline_json IS NOT OLD.baseline_json
BEGIN
  SELECT RAISE(ABORT, 'Rider baselines are write-once');
END;

-- A rider stays on the trip and in the place they were added.
CREATE TRIGGER trip_passengers_placement_fixed
BEFORE UPDATE OF trip_id, position ON trip_passengers
WHEN NEW.trip_id IS NOT OLD.trip_id OR NEW.position IS NOT OLD.position
BEGIN
  SELECT RAISE(ABORT, 'A trip passenger cannot move to another trip or position');
END;

-- The engine never removes a rider (a cancelled rider is kept and marked). Deleting one would also
-- erase write-once Tap-In history.
CREATE TRIGGER trip_passengers_never_deleted
BEFORE DELETE ON trip_passengers
BEGIN
  SELECT RAISE(ABORT, 'Trip passengers are never deleted');
END;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial ride state schema", up: (db) => db.exec(V1_SCHEMA) },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;
