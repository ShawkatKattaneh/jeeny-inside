/**
 * Phase 3 Prompt 3: Operations Dashboard figures, from real engine states via the real server store.
 * Cart, request and trip counts are separate; nothing beyond counts over one snapshot is computed.
 */
import { describe, expect, it } from "vitest";
import { cancel, createRequest, startTrip } from "../../../engine/rides";
import { dispatchRequest } from "../../../engine/dispatch";
import { advance } from "../../../engine/simulation";
import { CartStatus, RideRequestStatus, TripStatus } from "../../../shared/schemas";
import { checkAdvanceSeconds } from "./opsActions";
import { dispatchAvailability, opsMetrics } from "./opsMetrics";
import { cartAt, lineCampus, recordingStore } from "./testSupport";

function fleet() {
  return recordingStore(lineCampus(), [
    cartAt("CART-01", "a"),
    cartAt("CART-02", "e"),
    cartAt("CART-03", "b", { status: "charging" }),
    cartAt("CART-04", "d", { status: "maintenance" }),
  ]);
}
function create(rec: ReturnType<typeof fleet>, pickupId: string, destinationId: string, studentId = "stu-lina") {
  const r = rec.store.apply((s) => createRequest(s, { studentId, pickupId, destinationId }));
  if (!r.ok) throw new Error(r.error.message);
  return r.request.id;
}

describe("opsMetrics", () => {
  it("an empty system: every status key present with 0, no requests or trips", () => {
    const m = opsMetrics(fleet().snapshot());
    expect(Object.keys(m.carts.byStatus)).toEqual(CartStatus.options);
    expect(Object.keys(m.requests.byStatus)).toEqual(RideRequestStatus.options);
    expect(Object.keys(m.trips.byStatus)).toEqual(TripStatus.options);
    expect(m.carts).toMatchObject({ total: 4, passengersOnBoard: 0, seats: 16 });
    expect(m.carts.byStatus).toEqual({ idle: 2, assigned: 0, occupied: 0, charging: 1, offline: 0, maintenance: 1 });
    expect(m.requests).toMatchObject({ total: 0, awaitingDispatch: 0, active: 0 });
    expect(m.trips.total).toBe(0);
    expect(m).toMatchObject({ clockSeconds: 0, revision: 0 });
  });

  it("counts carts, requests and trips separately by their own statuses through a real ride lifecycle", () => {
    const rec = fleet();
    const a = create(rec, "c", "e");
    const b = create(rec, "b", "d", "stu-omar");
    const c = create(rec, "d", "a", "stu-sara");
    rec.store.apply((s) => dispatchRequest(s, a)); // CART-01 assigned, TRIP planned
    rec.store.apply((s) => startTrip(s, a));
    rec.store.apply((s) => advance(s, 600)); // at pickup: request arriving, trip active
    rec.store.apply((s) => cancel(s, c)); // a request with no trip
    const m = opsMetrics(rec.snapshot());
    expect(m.requests.byStatus).toEqual({ requested: 1, assigned: 0, arriving: 1, on_board: 0, completed: 0, cancelled: 1 });
    expect(m.requests).toMatchObject({ total: 3, awaitingDispatch: 1, active: 2 });
    expect(m.trips.byStatus).toEqual({ planned: 0, active: 1, cancelling: 0, completed: 0, cancelled: 0 });
    expect(m.trips.total).toBe(1);
    expect(m.carts.byStatus.assigned).toBe(1); // cart status, independent of request "arriving"
    expect(m.carts.byStatus.idle).toBe(1);
    expect(m.clockSeconds).toBe(600);
    expect(m.revision).toBe(rec.snapshot().revision);
    expect(b).toBe(rec.snapshot().requests.find((r) => r.status === "requested")!.id);
  });

  it("passengers on board are the sum of the carts' server passengerCount", () => {
    const rec = fleet();
    const s = rec.snapshot();
    s.carts[0]!.passengerCount = 2;
    s.carts[1]!.passengerCount = 1;
    expect(opsMetrics(s).carts.passengersOnBoard).toBe(3);
  });

  it("exposes counts only: no eligibility, wait-time, utilization, revenue or trend figures", () => {
    const m = opsMetrics(fleet().snapshot());
    expect(Object.keys(m)).toEqual(["carts", "requests", "trips", "clockSeconds", "revision"]);
    expect(Object.keys(m.carts)).toEqual(["total", "byStatus", "passengersOnBoard", "seats"]);
    expect(Object.keys(m.requests)).toEqual(["total", "byStatus", "awaitingDispatch", "active"]);
    expect(Object.keys(m.trips)).toEqual(["total", "byStatus"]);
  });
});

describe("dispatchAvailability", () => {
  it("only 'requested' can be asked; idle carts are never part of the answer", () => {
    expect(dispatchAvailability("requested")).toEqual({ canAsk: true });
    for (const s of ["assigned", "arriving", "on_board", "completed", "cancelled"] as const) expect(dispatchAvailability(s).canAsk).toBe(false);
  });
});

describe("checkAdvanceSeconds (same rule as the server)", () => {
  it("accepts 0 < s <= 600 and refuses everything else", () => {
    expect(checkAdvanceSeconds(1)).toEqual({ ok: true, seconds: 1 });
    expect(checkAdvanceSeconds(600)).toEqual({ ok: true, seconds: 600 });
    expect(checkAdvanceSeconds(0.5)).toEqual({ ok: true, seconds: 0.5 });
    for (const bad of [0, -5, 601, Number.NaN, Infinity, "30", null, undefined]) expect(checkAdvanceSeconds(bad).ok).toBe(false);
  });
});
