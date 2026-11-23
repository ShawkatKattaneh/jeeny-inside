import { describe, expect, it } from "vitest";
import { Cart, CartStatus, type CartInput } from "../shared/schemas";
import { SETTINGS } from "../shared/settings";
import { canTransition, checkCartEligibility, IN_SERVICE_STATUSES, meetsBatteryReserve, transitionError } from "./cartRules";

const cart = (over: Partial<CartInput> = {}): CartInput => ({
  id: "CART-01", label: "Cart 01", seats: 4, maxSpeedKmh: 15, simulated: true,
  status: "idle", position: { kind: "at", locationId: "depot" }, batteryPercent: 80, rangeKm: 30, passengerCount: 0, driverId: null,
  ...over,
});

describe("cart states", () => {
  it("defines exactly the five states", () => {
    expect(CartStatus.options).toEqual(["idle", "occupied", "charging", "offline", "maintenance"]);
    expect(IN_SERVICE_STATUSES).toEqual(["idle", "occupied"]);
  });

  it("rejects unknown states, including the old en_route", () => {
    for (const s of ["en_route", "IDLE", "busy", ""]) expect(Cart.safeParse(cart({ status: s as never })).success, s).toBe(false);
  });

  const all = CartStatus.options;
  const allowed = new Set([
    "idle>occupied", "idle>charging", "idle>offline", "idle>maintenance",
    "occupied>idle",
    "charging>idle", "charging>offline", "charging>maintenance",
    "offline>idle", "offline>charging", "offline>maintenance",
    "maintenance>idle", "maintenance>charging", "maintenance>offline",
  ]);

  it("allows exactly the documented transitions (full 5x5 table)", () => {
    for (const from of all) for (const to of all) {
      const expected = from === to || allowed.has(`${from}>${to}`);
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      expect(transitionError(from, to) === null, `${from} -> ${to}`).toBe(expected);
    }
  });

  it("explains rejected transitions", () => {
    expect(transitionError("charging", "occupied")).toBe('A cart can take passengers only when it is idle, not "charging"');
    expect(transitionError("occupied", "maintenance")).toBe('An occupied cart must drop off its passengers (become idle) before going "maintenance"');
  });
});

describe("status and passengers stay consistent", () => {
  it("idle has no passengers; occupied has at least one", () => {
    expect(Cart.safeParse(cart({ status: "idle", passengerCount: 0 })).success).toBe(true);
    expect(Cart.safeParse(cart({ status: "occupied", passengerCount: 2 })).success).toBe(true);
    expect(Cart.safeParse(cart({ status: "idle", passengerCount: 1 })).success).toBe(false);
    expect(Cart.safeParse(cart({ status: "occupied", passengerCount: 0 })).success).toBe(false);
  });

  it.each(["charging", "offline", "maintenance"] as const)("%s carts cannot carry passengers", (status) => {
    expect(Cart.safeParse(cart({ status, passengerCount: 0 })).success).toBe(true);
    const r = Cart.safeParse(cart({ status, passengerCount: 1 }));
    expect(r.error?.issues.map((i) => i.message)).toEqual([`A cart with passengers on board must be "occupied", not "${status}"`]);
  });
});

describe("battery reserve", () => {
  it("uses the approved 15% reserve by default", () => {
    expect(SETTINGS.batteryReservePercent).toBe(15);
    expect(meetsBatteryReserve(80)).toBe(true);
    expect(meetsBatteryReserve(15)).toBe(true);
    expect(meetsBatteryReserve(14.99)).toBe(false);
    expect(meetsBatteryReserve(0)).toBe(false);
  });

  it("accepts a different reserve, with the same at-or-above rule", () => {
    expect(meetsBatteryReserve(20, 20)).toBe(true);
    expect(meetsBatteryReserve(19, 20)).toBe(false);
    expect(meetsBatteryReserve(0, 0)).toBe(true);
  });

  it.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY])("rejects battery %s", (b) => {
    expect(() => meetsBatteryReserve(b)).toThrow(RangeError);
    expect(Cart.safeParse(cart({ batteryPercent: b })).success).toBe(false);
  });

  it.each([-1, 101, Number.NaN])("rejects reserve %s", (r) => {
    expect(() => meetsBatteryReserve(50, r)).toThrow(RangeError);
    expect(() => checkCartEligibility(cart(), { reservePercent: r })).toThrow(RangeError);
  });

  it("never changes the battery value", () => {
    const c = Cart.parse(cart({ batteryPercent: 42 }));
    checkCartEligibility(c);
    meetsBatteryReserve(c.batteryPercent);
    expect(c.batteryPercent).toBe(42);
  });
});

describe("checkCartEligibility", () => {
  it("an idle cart with battery and seats is eligible", () => {
    expect(checkCartEligibility(cart())).toEqual({ eligible: true, reasons: [], messages: [] });
  });

  it("exactly at the reserve is eligible; just below is not", () => {
    expect(checkCartEligibility(cart({ batteryPercent: 15 })).eligible).toBe(true);
    expect(checkCartEligibility(cart({ batteryPercent: 14.9 }))).toEqual({
      eligible: false, reasons: ["BATTERY_BELOW_RESERVE"], messages: ["CART-01 battery 14.9% is below the 15% reserve"],
    });
  });

  it("follows a configured reserve", () => {
    expect(checkCartEligibility(cart({ batteryPercent: 18 }), { reservePercent: 20 }).reasons).toEqual(["BATTERY_BELOW_RESERVE"]);
    expect(checkCartEligibility(cart({ batteryPercent: 18 }), { reservePercent: 10 }).eligible).toBe(true);
  });

  it.each(["charging", "offline", "maintenance"] as const)("a %s cart is not available", (status) => {
    expect(checkCartEligibility(cart({ status }))).toEqual({ eligible: false, reasons: ["NOT_IN_SERVICE"], messages: [`CART-01 is ${status} and not available`] });
  });

  it("an occupied cart passes the basic check only while it has enough free seats", () => {
    expect(checkCartEligibility(cart({ status: "occupied", passengerCount: 3 })).eligible).toBe(true);
    expect(checkCartEligibility(cart({ status: "occupied", passengerCount: 3 }), { seatsNeeded: 2 }).messages).toEqual(["CART-01 has 1 free seat, 2 needed"]);
  });

  it("a full cart is not eligible for more passengers", () => {
    expect(checkCartEligibility(cart({ status: "occupied", passengerCount: 4 }))).toEqual({
      eligible: false, reasons: ["NOT_ENOUGH_FREE_SEATS"], messages: ["CART-01 has 0 free seats, 1 needed"],
    });
  });

  it("lists every reason that applies, in a fixed order", () => {
    expect(checkCartEligibility(cart({ status: "maintenance", batteryPercent: 5 }), { seatsNeeded: 5 }).reasons)
      .toEqual(["NOT_IN_SERVICE", "BATTERY_BELOW_RESERVE", "NOT_ENOUGH_FREE_SEATS"]);
  });

  it("contradictory or invalid cart data is never eligible", () => {
    const r = checkCartEligibility(cart({ status: "idle", passengerCount: 2 }));
    expect(r.eligible).toBe(false);
    expect(r.reasons).toEqual(["INVALID_CART_DATA"]);
    expect(r.messages[0]).toContain('must be "occupied", not "idle"');
    expect(checkCartEligibility({ id: "CART-01" }).reasons).toEqual(["INVALID_CART_DATA"]);
    expect(checkCartEligibility(null).reasons).toEqual(["INVALID_CART_DATA"]);
  });

  it("rejects a meaningless seat request", () => {
    for (const n of [0, -1, 1.5]) expect(() => checkCartEligibility(cart(), { seatsNeeded: n })).toThrow(RangeError);
  });

  it("is deterministic and does not change its input", () => {
    const input = cart({ status: "occupied", passengerCount: 2, batteryPercent: 15 });
    const before = JSON.stringify(input);
    const first = checkCartEligibility(input, { seatsNeeded: 2 });
    for (let i = 0; i < 5; i++) expect(checkCartEligibility(input, { seatsNeeded: 2 })).toEqual(first);
    expect(JSON.stringify(input)).toBe(before);
  });
});
