import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { CampusConfig, Cart, RideRequest, Trip } from "./schemas";
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
