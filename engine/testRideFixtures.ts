/** Shared test fixtures for the ride engine tests (not used by app code). */
import { CampusConfig, type CampusConfigInput, type CartInput } from "../shared/schemas";
import { createFleet } from "./fleet";
import { createRideState, type RideResult, type RideState } from "./rides";

/**
 * A straight test campus a - b - c - d - e, 100 m between neighbours, 36 km/h limits (10 m/s for a
 * 36 km/h cart), so times are easy to check by hand. "x" is a location where carts cannot stop.
 */
export function lineCampus(over: Partial<CampusConfigInput> = {}): CampusConfig {
  return CampusConfig.parse({
    id: "line", name: "Line", fictional: true, map: { width: 600, height: 200 },
    locations: [
      ...["a", "b", "c", "d", "e"].map((id, i) => ({ id, name: id, type: "pickup", position: { x: 50 + i * 100, y: 50 }, canStop: true })),
      { id: "x", name: "x", type: "building", position: { x: 250, y: 150 }, canStop: false },
    ],
    paths: [
      { id: "ab", from: "a", to: "b", lengthMeters: 100, speedKmh: 36 },
      { id: "bc", from: "b", to: "c", lengthMeters: 100, speedKmh: 36 },
      { id: "cd", from: "c", to: "d", lengthMeters: 100, speedKmh: 36 },
      { id: "de", from: "d", to: "e", lengthMeters: 100, speedKmh: 36 },
      { id: "cx", from: "c", to: "x", lengthMeters: 100, speedKmh: 36 },
    ],
    ...over,
  });
}

export const cartAt = (id: string, locationId: string, over: Partial<CartInput> = {}): CartInput => ({
  id, label: id, seats: 4, maxSpeedKmh: 36, simulated: true,
  status: "idle", position: { kind: "at", locationId }, batteryPercent: 80, rangeKm: 30, driverId: null,
  ...over,
});

export function setup(campus: CampusConfig, carts: CartInput[]): RideState {
  const f = createFleet(campus, carts);
  if (!f.ok) throw new Error(f.errors.map((e) => e.message).join("\n"));
  return ok(createRideState(campus, f.fleet)).state;
}

/** Unwrap a successful result or fail the test with the error message. */
export function ok<T extends object>(r: RideResult<T>): { state: RideState } & T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r;
}
