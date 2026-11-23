import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { CampusConfig, Cart, CartStatePatch, DEFAULT_CART_SPEED_KMH, RideRequest, Trip } from "./schemas";
import { PERSONAS } from "./personas";
import { SETTINGS } from "./settings";

const campusFiles = readdirSync("campus").filter((f) => f.endsWith(".json"));
const load = (f: string) => JSON.parse(readFileSync(`campus/${f}`, "utf8"));

describe("campus config files", () => {
  it.each(campusFiles)("%s validates against the schema", (f) => {
    expect(CampusConfig.safeParse(load(f)).success).toBe(true);
  });

  it("the default fictional campus matches F4: about 15 locations with the agreed mix", () => {
    const c = CampusConfig.parse(load("fictional-campus.json"));
    const count = (t: string) => c.locations.filter((l) => l.type === t).length;
    expect(c.fictional).toBe(true);
    expect(c.locations.length).toBeGreaterThanOrEqual(12);
    expect(c.locations.length).toBeLessThanOrEqual(20);
    expect(count("gate")).toBe(2);
    expect(count("building")).toBeGreaterThanOrEqual(6);
    expect(count("building")).toBeLessThanOrEqual(8);
    expect(count("parking")).toBe(2);
    expect(count("pickup")).toBeGreaterThanOrEqual(1);
    expect(count("depot")).toBe(1);
  });

  it("rejects a path to a location that does not exist", () => {
    const c = load("fictional-campus.json");
    c.paths.push({ id: "bad", from: "library", to: "nowhere", lengthMeters: 10, speedKmh: 10 });
    const r = CampusConfig.safeParse(c);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('Unknown location \\"nowhere\\"');
  });

  it("rejects duplicate location ids", () => {
    const c = load("fictional-campus.json");
    c.locations.push({ ...c.locations[0] });
    expect(CampusConfig.safeParse(c).success).toBe(false);
  });
});

describe("campus structural validation", () => {
  const issues = (c: unknown) => {
    const r = CampusConfig.safeParse(c);
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };

  it("rejects duplicate path ids and names the first use", () => {
    const c = load("fictional-campus.json");
    c.paths.push({ ...c.paths[0], from: "library", to: "admin" });
    expect(issues(c)).toContain(`paths.${c.paths.length - 1}.id: Duplicate path id "north-gate--admin" (first used by paths.0)`);
  });

  it("duplicate location ids name the first use", () => {
    const c = load("fictional-campus.json");
    c.locations.push({ ...c.locations[2] });
    expect(issues(c)).toContain(`locations.${c.locations.length - 1}.id: Duplicate location id "admin" (first used by locations.2)`);
  });

  it("names the path that references an unknown location, on either end", () => {
    const c = load("demo-valley.json");
    c.paths.push({ id: "ghost", from: "nowhere", to: "hall-a", lengthMeters: 10, speedKmh: 10 });
    expect(issues(c)).toEqual([`paths.${c.paths.length - 1}.from: Unknown location "nowhere" in path "ghost"`]);
  });

  it("rejects a path that starts and ends at the same location", () => {
    const c = load("demo-valley.json");
    c.paths.push({ id: "loop", from: "hall-a", to: "hall-a", lengthMeters: 10, speedKmh: 10 });
    expect(issues(c)).toEqual([`paths.${c.paths.length - 1}: Path "loop" cannot start and end at the same location`]);
  });

  it.each([0, -5, Number.POSITIVE_INFINITY, Number.NaN, "100"])("rejects path length %s", (len) => {
    const c = load("demo-valley.json");
    c.paths[0].lengthMeters = len;
    expect(issues(c).length).toBeGreaterThan(0);
    expect(issues(c)[0]).toMatch(/^paths\.0\.lengthMeters: /);
  });

  it("explains invalid lengths and speed limits in plain words", () => {
    const c = load("demo-valley.json");
    c.paths[0].lengthMeters = 0;
    c.paths[1].speedKmh = 0;
    c.paths[2].speedKmh = 55;
    expect(issues(c)).toEqual([
      "paths.0.lengthMeters: Path length must be greater than 0 meters",
      "paths.1.speedKmh: Speed limit must be greater than 0 km/h",
      "paths.2.speedKmh: Speed limit must be 40 km/h or less",
    ]);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects speed limit %s", (v) => {
    const c = load("demo-valley.json");
    c.paths[0].speedKmh = v;
    expect(issues(c)[0]).toMatch(/^paths\.0\.speedKmh: /);
  });

  it("reports every problem at once, not just the first", () => {
    const c = load("demo-valley.json");
    c.paths[0].lengthMeters = -1;
    c.paths[1].to = "missing";
    c.locations.push({ ...c.locations[0] });
    expect(issues(c)).toHaveLength(3);
  });

  it("paths without oneWay default to two-way", () => {
    const c = load("demo-valley.json");
    delete c.paths[0].oneWay;
    expect(CampusConfig.parse(c).paths[0]!.oneWay).toBe(false);
  });
});

describe("domain schemas", () => {
  it("demo personas cover every role and drivers have carts", () => {
    expect(new Set(PERSONAS.map((p) => p.role))).toEqual(new Set(["student", "driver", "operator"]));
    for (const p of PERSONAS.filter((p) => p.role === "driver")) expect(p.cartId).toMatch(/^CART-\d{2}$/);
  });

  it("a ride request carries the simulated fare and cannot go nowhere", () => {
    const base = { id: "r1", studentId: "stu-lina", pickupId: "library", destinationId: "admin", mode: "solo", status: "requested", createdAt: 1, updatedAt: 1, fareJod: SETTINGS.fareJod };
    expect(RideRequest.parse(base).fareJod).toBe(0.25);
    expect(RideRequest.safeParse({ ...base, destinationId: "library" }).success).toBe(false);
  });

  it("cart and trip shapes validate", () => {
    expect(Cart.safeParse({ id: "CART-01", label: "Cart 01", seats: 4, status: "idle", position: { kind: "at", locationId: "depot" }, batteryPercent: 90, rangeKm: 30, simulated: false, driverId: "drv-yazan" }).success).toBe(true);
    expect(Cart.safeParse({ id: "cart1", label: "x", seats: 4, status: "idle", position: { kind: "at", locationId: "depot" }, batteryPercent: 90, rangeKm: 30, simulated: true, driverId: null }).success).toBe(false);
    expect(Trip.safeParse({ id: "t1", cartId: "CART-01", stops: [{ locationId: "library", board: ["r1"], alight: [] }], passengers: [{ requestId: "r1", boarded: false }], status: "planned" }).success).toBe(true);
  });

  it("approved settings match the plan (D8, F1-F3)", () => {
    expect(SETTINGS).toEqual({ fareJod: 0.25, sharedFareJod: 0.25, loyaltyPaidRidesForFree: 5, batteryReservePercent: 15, sharedMaxAddedDelayMinutes: 4 });
  });
});

describe("cart schema", () => {
  const base = { id: "CART-03", label: "Cart 03", seats: 4, simulated: true, status: "idle", position: { kind: "at", locationId: "depot" }, batteryPercent: 60, rangeKm: 20, driverId: null };
  const msgs = (c: unknown) => Cart.safeParse(c).error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`) ?? [];

  it("a valid cart parses; passengers default to 0 and speed to the documented default", () => {
    expect(Cart.parse(base)).toMatchObject({ passengerCount: 0, maxSpeedKmh: DEFAULT_CART_SPEED_KMH });
    expect(DEFAULT_CART_SPEED_KMH).toBe(15);
  });

  it.each([0, -1, 1.5, 9, Number.NaN])("rejects capacity %s", (seats) => {
    expect(msgs({ ...base, seats })[0]).toMatch(/^seats: /);
  });

  it.each([0, -3, 41, Number.POSITIVE_INFINITY])("rejects cart speed %s", (maxSpeedKmh) => {
    expect(msgs({ ...base, maxSpeedKmh })[0]).toMatch(/^maxSpeedKmh: /);
  });

  it.each([-1, 1.5])("rejects passenger count %s", (passengerCount) => {
    expect(msgs({ ...base, status: "occupied", passengerCount })[0]).toMatch(/^passengerCount: /);
  });

  it("rejects a missing or malformed location", () => {
    const { position: _omit, ...noPosition } = base;
    expect(msgs(noPosition)[0]).toMatch(/^position: /);
    expect(msgs({ ...base, position: { kind: "at", locationId: "Not Kebab" } })[0]).toMatch(/^position\.locationId: /);
    expect(msgs({ ...base, position: { kind: "on_path", pathId: "p", progress: 2 } }).length).toBeGreaterThan(0);
  });

  it("a state patch accepts only operational fields and never fills defaults", () => {
    expect(CartStatePatch.parse({ status: "charging" })).toEqual({ status: "charging" });
    expect(CartStatePatch.safeParse({ seats: 2 }).success).toBe(false);
    expect(CartStatePatch.safeParse({ maxSpeedKmh: 20 }).success).toBe(false);
  });
});

