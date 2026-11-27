/**
 * Phase 3 Prompt 2: what Driver Mode derives from the server's state. Every state comes from the real
 * engine through the real server store, read as the server's own snapshot.
 */
import { describe, expect, it } from "vitest";
import type { Persona, StateSnapshot } from "../../../shared/schemas";
import { PERSONAS } from "../../../shared/personas";
import { board, confirmArrival, cancel, createRequest, dropOff, startTrip, type RideState } from "../../../engine/rides";
import { dispatchRequest } from "../../../engine/dispatch";
import { advance } from "../../../engine/simulation";
import { bindingStillValid, driverCartLink, openTripsForCart, shownTrip, tripView, type CartTrip } from "./driverWork";
import { cartAt, lineCampus, recordingStore } from "./testSupport";

const yazan = PERSONAS.find((p) => p.id === "drv-yazan")!; // persona cartId CART-01
const rana = PERSONAS.find((p) => p.id === "drv-rana")!; // persona cartId CART-02

/** Line campus: CART-01 (driver drv-yazan) at a, CART-02 (driver drv-rana) at e. */
function fleet(carts = [cartAt("CART-01", "a", { driverId: "drv-yazan" }), cartAt("CART-02", "e", { driverId: "drv-rana" })]) {
  const rec = recordingStore(lineCampus(), carts);
  const run = (op: (s: RideState) => { ok: boolean }) => {
    const r = rec.store.apply(op as never) as { ok: boolean };
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r as unknown as Record<string, unknown>;
  };
  const book = (studentId: string, pickupId: string, destinationId: string) =>
    (run((s) => createRequest(s, { studentId, pickupId, destinationId })).request as { id: string }).id;
  return { rec, run, book };
}

describe("driver to cart (server Cart.driverId)", () => {
  it("links each seeded driver to the cart whose driverId is theirs, matching the persona's cartId", () => {
    const { rec } = fleet();
    const snap = rec.snapshot();
    expect(driverCartLink(snap, yazan)).toMatchObject({ carts: [expect.objectContaining({ id: "CART-01" })], personaCartId: "CART-01", mismatch: false });
    expect(driverCartLink(snap, rana).carts.map((c) => c.id)).toEqual(["CART-02"]);
  });

  it("follows the server, not the persona: a persona cartId the fleet does not confirm is flagged, never used", () => {
    const { rec } = fleet([cartAt("CART-01", "a", { driverId: "drv-rana" }), cartAt("CART-02", "e", { driverId: null })]);
    const link = driverCartLink(rec.snapshot(), yazan);
    expect(link).toEqual({ carts: [], personaCartId: "CART-01", mismatch: true });
  });

  it("a driver with no cart in the fleet, or a cart without a driver, links to nothing", () => {
    const { rec } = fleet([cartAt("CART-01", "a", { driverId: null })]);
    const nobody: Persona = { id: "drv-new", name: "New", role: "driver", subtitle: "" };
    expect(driverCartLink(rec.snapshot(), nobody)).toEqual({ carts: [], personaCartId: null, mismatch: false });
    expect(driverCartLink(rec.snapshot(), yazan).carts).toEqual([]);
  });

  it("lists every cart the fleet gives one driver (the screen then asks the driver to choose)", () => {
    const { rec } = fleet([cartAt("CART-01", "a", { driverId: "drv-yazan" }), cartAt("CART-02", "e", { driverId: "drv-yazan" })]);
    expect(driverCartLink(rec.snapshot(), yazan).carts.map((c) => c.id)).toEqual(["CART-01", "CART-02"]);
  });
});

describe("trips assigned to the driver's cart", () => {
  it("shows only open trips whose cartId is this cart; another cart's trip never appears", () => {
    const { rec, run, book } = fleet();
    const lina = book("stu-lina", "b", "c"); // nearest: CART-01 at a
    run((s) => dispatchRequest(s, lina));
    const omar = book("stu-omar", "d", "e"); // nearest free: CART-02 at e
    run((s) => dispatchRequest(s, omar));
    const snap = rec.snapshot();
    expect(openTripsForCart(snap, "CART-01").map((t) => t.request?.id)).toEqual([lina]);
    expect(openTripsForCart(snap, "CART-02").map((t) => t.request?.id)).toEqual([omar]);
  });

  it("a requested (not dispatched) ride is no one's trip yet", () => {
    const { rec, book } = fleet();
    book("stu-lina", "b", "c");
    expect(openTripsForCart(rec.snapshot(), "CART-01")).toEqual([]);
  });

  it("finished trips are not shown as current work", () => {
    const { rec, run, book } = fleet();
    const id = book("stu-lina", "a", "b");
    run((s) => dispatchRequest(s, id));
    run((s) => startTrip(s, id));
    run((s) => board(s, id));
    run((s) => advance(s, 600));
    run((s) => dropOff(s, id));
    expect(openTripsForCart(rec.snapshot(), "CART-01")).toEqual([]);
  });
});

describe("next step follows the server's own preconditions", () => {
  it("start, then nothing until the pickup, then board, then nothing until the destination, then drop-off", () => {
    const { rec, run, book } = fleet();
    const id = book("stu-lina", "c", "e");
    run((s) => dispatchRequest(s, id));
    const seen: [string, string | null, string, string][] = [];
    const look = () => {
      const snap = rec.snapshot();
      const [t] = openTripsForCart(snap, "CART-01");
      const cart = snap.carts.find((c) => c.id === "CART-01")!;
      seen.push([t!.stage, t!.next?.action ?? null, t!.request!.status, cart.status]);
      return t!;
    };
    const planned = look();
    expect(planned.next).toEqual({ action: "start", requestId: id, tripId: "TRIP-0001", expectedStatus: "assigned" });
    run((s) => startTrip(s, id));
    expect(look().unavailable).toMatch(/Boarding opens when the cart reaches the pickup/);
    run((s) => advance(s, 600));
    look();
    // Final pass: the driver confirms arrival explicitly before boarding and before drop-off.
    run((s) => confirmArrival(s, "TRIP-0001"));
    look();
    run((s) => board(s, id));
    look();
    run((s) => advance(s, 600));
    look();
    run((s) => confirmArrival(s, "TRIP-0001"));
    look();
    expect(seen).toEqual([
      ["planned", "start", "assigned", "assigned"],
      ["to_pickup", null, "arriving", "assigned"],
      ["at_pickup", "arrive", "arriving", "assigned"],
      ["at_pickup", "board", "arriving", "assigned"],
      ["to_destination", null, "on_board", "occupied"],
      ["at_destination", "arrive", "on_board", "occupied"],
      ["at_destination", "drop-off", "on_board", "occupied"],
    ]);
  });

  it("a trip cancelled mid-path offers no step and says why", () => {
    const { rec, run, book } = fleet();
    const id = book("stu-lina", "c", "e");
    run((s) => dispatchRequest(s, id));
    run((s) => startTrip(s, id));
    run((s) => advance(s, 5));
    run((s) => cancel(s, id));
    const [t] = openTripsForCart(rec.snapshot(), "CART-01");
    expect(t).toMatchObject({ stage: "cancelling", next: null });
    expect(t!.unavailable).toMatch(/student cancelled/);
  });

  it("a binding is valid only while the latest state still offers exactly that step", () => {
    const { rec, run, book } = fleet();
    const id = book("stu-lina", "c", "e");
    run((s) => dispatchRequest(s, id));
    const before = rec.snapshot();
    const start = openTripsForCart(before, "CART-01")[0]!.next!;
    expect(bindingStillValid(before, start)).toBe(true);
    run((s) => startTrip(s, id));
    expect(bindingStillValid(rec.snapshot(), start)).toBe(false);
    expect(bindingStillValid(null, start)).toBe(false);
    expect(bindingStillValid(before, { ...start, requestId: "REQ-9999" })).toBe(false);
  });
});

describe("selection", () => {
  it("one open trip is shown; several need an explicit choice; a selection that ended is dropped", () => {
    // Several open trips on one cart cannot happen in a valid server state (engine invariant), so this
    // checks the selection rule on a list built from one real trip view.
    const { rec, run, book } = fleet();
    const id = book("stu-lina", "c", "e");
    run((s) => dispatchRequest(s, id));
    const one = openTripsForCart(rec.snapshot(), "CART-01");
    expect(shownTrip(one, null)).toBe(one[0]);
    const snap: StateSnapshot = rec.snapshot();
    const a = one[0]!;
    const b: CartTrip = tripView(snap, { ...a.trip, id: "TRIP-0099" });
    expect(shownTrip([a, b], null)).toBeNull(); // never picks by array order
    expect(shownTrip([a, b], "TRIP-0099")).toBe(b);
    expect(shownTrip([a, b], "TRIP-0050")).toBeNull();
    expect(shownTrip([], "TRIP-0001")).toBeNull();
  });
});
