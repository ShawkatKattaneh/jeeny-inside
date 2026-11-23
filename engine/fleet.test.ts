import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CampusConfig, type CartInput } from "../shared/schemas";
import { createFleet, getCart, listCarts, updateCart, type Fleet } from "./fleet";

const load = (f: string) => CampusConfig.parse(JSON.parse(readFileSync(f, "utf8")));
const wadi = load("campus/fictional-campus.json");
const valley = load("campus/demo-valley.json");

const cart = (id: string, over: Partial<CartInput> = {}): CartInput => ({
  id, label: `Cart ${id.slice(-2)}`, seats: 4, simulated: true,
  status: "idle", position: { kind: "at", locationId: "depot" }, batteryPercent: 80, rangeKm: 30, driverId: null,
  ...over,
});

function fleetOf(...carts: CartInput[]): Fleet {
  const r = createFleet(wadi, carts);
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join("\n"));
  return r.fleet;
}

describe("createFleet", () => {
  it("builds a validated fleet, sorted by id, with defaults filled in", () => {
    const f = fleetOf(cart("CART-02"), cart("CART-01", { position: { kind: "at", locationId: "library" } }));
    expect(listCarts(f).map((c) => c.id)).toEqual(["CART-01", "CART-02"]);
    expect(getCart(f, "CART-02")).toMatchObject({ ok: true, cart: { passengerCount: 0, maxSpeedKmh: 15 } });
    expect(f.campusId).toBe("wadi-cedar");
  });

  it("rejects duplicate cart ids", () => {
    const r = createFleet(wadi, [cart("CART-01"), cart("CART-01", { label: "Again" })]);
    expect(r).toEqual({ ok: false, errors: [{ code: "DUPLICATE_CART_ID", cartId: "CART-01", message: 'Cart id "CART-01" is used more than once' }] });
  });

  it("rejects a cart at a location or on a path that is not on this campus", () => {
    const r = createFleet(wadi, [
      cart("CART-01", { position: { kind: "at", locationId: "mars" } }),
      cart("CART-02", { position: { kind: "on_path", pathId: "nope", progress: 0.5 } }),
      cart("CART-03", { position: { kind: "on_path", pathId: "north-gate--admin", progress: 0.5 } }),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.message)).toEqual([
      'CART-01 is at "mars", which is not a location on campus "wadi-cedar"',
      'CART-02 is on path "nope", which is not a path on campus "wadi-cedar"',
    ]);
  });

  it("validates carts against whichever campus is active, and never relocates them", () => {
    const carts = [cart("CART-01", { position: { kind: "at", locationId: "library" } })];
    expect(createFleet(wadi, carts).ok).toBe(true);
    const r = createFleet(valley, carts);
    expect(r).toMatchObject({ ok: false, errors: [{ code: "UNKNOWN_LOCATION", message: 'CART-01 is at "library", which is not a location on campus "demo-valley"' }] });
    // "depot" exists on both campuses, so the same cart data works on either.
    expect(createFleet(valley, [cart("CART-01")]).ok).toBe(true);
  });

  it("reports every invalid cart at once with a readable message", () => {
    const r = createFleet(wadi, [
      cart("CART-01", { seats: 0 }),
      cart("CART-02", { passengerCount: -1 }),
      cart("CART-03", { status: "occupied", passengerCount: 5 }),
      cart("CART-04", { batteryPercent: 120 }),
      cart("CART-05", { maxSpeedKmh: 0 }),
      { id: "CART-06" },
      cart("cart7"),
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.every((e) => e.code === "INVALID_CART")).toBe(true);
    expect(r.errors.map((e) => e.message)).toEqual([
      "Cart 0 (CART-01) is invalid: seats: Capacity must be at least 1 seat",
      "Cart 1 (CART-02) is invalid: passengerCount: Passenger count cannot be negative",
      "Cart 2 (CART-03) is invalid: passengerCount: 5 passengers do not fit in 4 seats",
      "Cart 3 (CART-04) is invalid: batteryPercent: Battery must be between 0 and 100%",
      "Cart 4 (CART-05) is invalid: maxSpeedKmh: Cart speed must be greater than 0 km/h",
      expect.stringMatching(/^Cart 5 \(CART-06\) is invalid: /),
      "Cart 6 (cart7) is invalid: id: Cart ids look like CART-07",
    ]);
  });

  it("an empty fleet is valid", () => {
    expect(createFleet(wadi, [])).toMatchObject({ ok: true });
  });
});

describe("getCart", () => {
  const f = fleetOf(cart("CART-01"), cart("CART-02"));
  it("finds a cart by id", () => {
    expect(getCart(f, "CART-02")).toMatchObject({ ok: true, cart: { id: "CART-02" } });
  });
  it("an unknown id is a clear error, not a crash", () => {
    expect(getCart(f, "CART-99")).toEqual({ ok: false, error: { code: "UNKNOWN_CART", cartId: "CART-99", message: 'No cart with id "CART-99" in this fleet' } });
    expect(updateCart(f, "CART-99", { batteryPercent: 50 })).toEqual(getCart(f, "CART-99"));
  });
  it("returned carts cannot be changed from outside", () => {
    const c = getCart(f, "CART-01");
    if (!c.ok) throw new Error("setup");
    expect(() => { (c.cart as { batteryPercent: number }).batteryPercent = 1; }).toThrow(TypeError);
    expect(() => { (c.cart.position as { locationId: string }).locationId = "x"; }).toThrow(TypeError);
  });
});

describe("updateCart", () => {
  const base = fleetOf(cart("CART-01"), cart("CART-02", { status: "occupied", passengerCount: 2 }));
  const snapshot = JSON.stringify(listCarts(base));

  it("applies a valid update and returns a new fleet; the old one is unchanged", () => {
    const r = updateCart(base, "CART-01", { batteryPercent: 55, position: { kind: "at", locationId: "library" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cart).toMatchObject({ batteryPercent: 55, position: { kind: "at", locationId: "library" }, seats: 4, label: "Cart 01" });
    expect(getCart(r.fleet, "CART-01")).toEqual({ ok: true, cart: r.cart });
    expect(JSON.stringify(listCarts(base))).toBe(snapshot);
  });

  it("leaves other carts exactly as they were (same objects)", () => {
    const r = updateCart(base, "CART-01", { status: "charging" });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.fleet.carts.get("CART-02")).toBe(base.carts.get("CART-02"));
    expect(listCarts(r.fleet).map((c) => c.id)).toEqual(["CART-01", "CART-02"]);
  });

  it("a field left out of the update is never reset", () => {
    const r = updateCart(base, "CART-02", { batteryPercent: 70 });
    expect(r.ok && r.cart.passengerCount).toBe(2);
  });

  it("boarding and dropping off: status and passengers change together", () => {
    const on = updateCart(base, "CART-01", { status: "occupied", passengerCount: 3 });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    const off = updateCart(on.fleet, "CART-01", { status: "idle", passengerCount: 0 });
    expect(off.ok && off.cart).toMatchObject({ status: "idle", passengerCount: 0 });
  });

  const rejected: Array<[string, string, unknown, string, RegExp]> = [
    ["battery out of range", "CART-01", { batteryPercent: 101 }, "INVALID_UPDATE", /batteryPercent: Battery must be between 0 and 100%/],
    ["negative passengers", "CART-02", { passengerCount: -1 }, "INVALID_UPDATE", /Passenger count cannot be negative/],
    ["more passengers than seats", "CART-02", { passengerCount: 5 }, "INVALID_UPDATE", /5 passengers do not fit in 4 seats/],
    ["passengers on an idle cart", "CART-01", { passengerCount: 1 }, "INVALID_UPDATE", /must be "occupied", not "idle"/],
    ["occupied with nobody on board", "CART-01", { status: "occupied" }, "INVALID_UPDATE", /at least 1 passenger/],
    ["unknown status", "CART-01", { status: "en_route" }, "INVALID_UPDATE", /status/],
    ["changing capacity", "CART-01", { seats: 6 }, "INVALID_UPDATE", /"seats" cannot be changed by a state update/],
    ["changing the id", "CART-01", { id: "CART-09", batteryPercent: 50 }, "INVALID_UPDATE", /"id" cannot be changed/],
    ["not an object", "CART-01", "charging", "INVALID_UPDATE", /CART-01: /],
    ["occupied cart going to maintenance", "CART-02", { status: "maintenance", passengerCount: 0 }, "INVALID_TRANSITION", /must drop off its passengers/],
    ["location not on campus", "CART-01", { position: { kind: "at", locationId: "hall-a" } }, "UNKNOWN_LOCATION", /"hall-a", which is not a location on campus "wadi-cedar"/],
    ["path not on campus", "CART-01", { position: { kind: "on_path", pathId: "x", progress: 0 } }, "UNKNOWN_LOCATION", /path "x"/],
  ];

  it.each(rejected)("rejects %s and leaves the fleet unchanged", (_name, id, patch, code, msg) => {
    const r = updateCart(base, id, patch);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe(code);
    expect(r.error.message).toMatch(msg);
    expect(JSON.stringify(listCarts(base))).toBe(snapshot);
  });

  it("a charging cart cannot take passengers until it is idle", () => {
    const charging = updateCart(base, "CART-01", { status: "charging" });
    if (!charging.ok) throw new Error("setup");
    const r = updateCart(charging.fleet, "CART-01", { status: "occupied", passengerCount: 1 });
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_TRANSITION", message: 'CART-01: A cart can take passengers only when it is idle, not "charging"' } });
  });

  it("the same updates always give the same result", () => {
    const run = () => {
      let f = base;
      for (const [id, p] of [["CART-01", { status: "charging" }], ["CART-02", { status: "idle", passengerCount: 0 }], ["CART-01", { status: "idle", batteryPercent: 99 }]] as const) {
        const r = updateCart(f, id, p);
        if (!r.ok) throw new Error(r.error.message);
        f = r.fleet;
      }
      return JSON.stringify(listCarts(f));
    };
    expect(run()).toBe(run());
  });
});
