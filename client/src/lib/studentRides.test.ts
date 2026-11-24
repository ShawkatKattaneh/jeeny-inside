/**
 * Phase 3 Prompt 1: what the Student App derives from the server's ride state. Every state here is
 * produced by the real engine through the real server store, read as the server's own snapshot.
 */
import { describe, expect, it } from "vitest";
import { board, cancel, createRequest, dropOff, startTrip } from "../../../engine/rides";
import { dispatchRequest } from "../../../engine/dispatch";
import { advance } from "../../../engine/simulation";
import { SETTINGS } from "../../../shared/settings";
import type { RideState } from "../../../engine/rides";
import { cartMapPoint, phaseDetail, routePathIds, studentRides, withPendingRequest, type RidePhase } from "./studentRides";
import { lineCampus, recordingStore } from "./testSupport";

function server() {
  const rec = recordingStore();
  const run = <T extends { ok: boolean }>(op: (s: RideState) => T) => {
    const r = rec.store.apply(op as never);
    if (!(r as { ok: boolean }).ok) throw new Error(JSON.stringify(r));
    return r as unknown as T;
  };
  const book = (studentId: string, pickupId = "c", destinationId = "e") =>
    (run((s) => createRequest(s, { studentId, pickupId, destinationId })) as unknown as { request: { id: string } }).request.id;
  return { rec, run, book };
}

describe("student ride ownership", () => {
  it("lists only requests whose studentId is the student's own, newest first", () => {
    const { rec, run, book } = server();
    const lina1 = book("stu-lina");
    run((s) => advance(s, 1)); // later creation time
    const omar = book("stu-omar", "a", "b");
    run((s) => advance(s, 1));
    const lina2 = book("stu-lina", "b", "d");
    const snap = rec.snapshot();
    expect(studentRides(snap, "stu-lina").map((r) => r.request.id)).toEqual([lina2, lina1]);
    expect(studentRides(snap, "stu-omar").map((r) => r.request.id)).toEqual([omar]);
    expect(studentRides(snap, "stu-sara")).toEqual([]);
  });

  it("another student's assigned cart never appears on this student's rides", () => {
    const { rec, run, book } = server();
    const omar = book("stu-omar");
    run((s) => dispatchRequest(s, omar));
    book("stu-lina", "a", "b");
    const [lina] = studentRides(rec.snapshot(), "stu-lina");
    expect(lina!.phase).toBe("requested");
    expect(lina!.trip).toBeNull();
    expect(lina!.cart).toBeNull();
  });
});

describe("ride phases follow the server, step by step", () => {
  it("maps each authoritative state, and never shows a cart before assignment", () => {
    const { rec, run, book } = server();
    const id = book("stu-lina", "c", "e");
    const seen: { phase: RidePhase; cart: string | null; route: string[] }[] = [];
    const look = () => {
      const [r] = studentRides(rec.snapshot(), "stu-lina");
      seen.push({ phase: r!.phase, cart: r!.cart?.id ?? null, route: routePathIds(r!) });
    };
    look(); // requested
    run((s) => dispatchRequest(s, id));
    look(); // assigned: the cart, no route yet (trip planned, leg null)
    run((s) => startTrip(s, id));
    look(); // on the way, at a: route a->c
    run((s) => advance(s, 15));
    look(); // mid path
    run((s) => advance(s, 600));
    look(); // at pickup c
    run((s) => board(s, id));
    look(); // on board
    run((s) => advance(s, 600));
    look(); // at destination
    run((s) => dropOff(s, id));
    look();
    expect(seen).toEqual([
      { phase: "requested", cart: null, route: [] },
      { phase: "assigned", cart: "CART-01", route: [] },
      { phase: "approaching", cart: "CART-01", route: ["ab", "bc"] },
      { phase: "approaching", cart: "CART-01", route: ["ab", "bc"] },
      { phase: "at_pickup", cart: "CART-01", route: ["ab", "bc"] },
      { phase: "in_progress", cart: "CART-01", route: ["cd", "de"] },
      { phase: "at_destination", cart: "CART-01", route: ["cd", "de"] },
      { phase: "completed", cart: null, route: [] },
    ]);
    const [done] = studentRides(rec.snapshot(), "stu-lina");
    expect(done).toMatchObject({ active: false, cartLabel: "CART-01" });
    expect(phaseDetail(done!, lineCampus())).toBe("Dropped off at e.");
  });

  it("a cancelled ride is cancelled even while its cart is still finishing a path", () => {
    const { rec, run, book } = server();
    const id = book("stu-lina", "c", "e");
    run((s) => dispatchRequest(s, id));
    run((s) => startTrip(s, id));
    run((s) => advance(s, 5)); // mid-path
    run((s) => cancel(s, id));
    const [r] = studentRides(rec.snapshot(), "stu-lina");
    expect(r!.trip!.status).toBe("cancelling");
    expect(r).toMatchObject({ phase: "cancelled", active: false, cart: null });
    expect(routePathIds(r!)).toEqual([]);
  });

  it("the fare shown is the server's stored fare: the approved 0.25 JOD, never a free ride", () => {
    const { rec, book } = server();
    book("stu-lina");
    const [r] = studentRides(rec.snapshot(), "stu-lina");
    expect(r!.request.fareJod).toBe(SETTINGS.fareJod);
    expect(r!.request.freeLoyaltyRide).toBe(false);
  });

  it("places the cart on the schematic map from the server's position and path progress", () => {
    const campus = lineCampus();
    expect(cartMapPoint(campus, { kind: "at", locationId: "c" })).toEqual({ x: 250, y: 50 });
    expect(cartMapPoint(campus, { kind: "on_path", pathId: "ab", progress: 0.25 })).toEqual({ x: 75, y: 50 });
    expect(cartMapPoint(campus, { kind: "on_path", pathId: "nope", progress: 0.5 })).toBeNull();
  });
});

describe("booking responses never override the live state", () => {
  it("live state wins when it already has the request, even if the response is older", () => {
    const { rec, run, book } = server();
    const id = book("stu-lina");
    const response = structuredClone(rec.snapshot().requests[0]!); // status "requested"
    run((s) => dispatchRequest(s, id)); // live state moved on to "assigned"
    const rides = withPendingRequest(studentRides(rec.snapshot(), "stu-lina"), { request: response, seq: 1 }, 1, "stu-lina");
    expect(rides).toHaveLength(1);
    expect(rides[0]).toMatchObject({ phase: "assigned", synced: true });
  });

  it("before the live state has it, the response is shown as unsynced, with no trip or cart", () => {
    const { rec, book } = server();
    const before = rec.snapshot();
    book("stu-lina");
    const response = rec.snapshot().requests[0]!;
    const rides = withPendingRequest(studentRides(before, "stu-lina"), { request: response, seq: 3 }, 3, "stu-lina");
    expect(rides).toEqual([expect.objectContaining({ phase: "requested", synced: false, trip: null, cart: null })]);
  });

  it("is dropped once a newer snapshot replaced the state without it, and never shown to another student", () => {
    const { rec, book } = server();
    const before = rec.snapshot();
    book("stu-lina");
    const response = rec.snapshot().requests[0]!;
    expect(withPendingRequest([], { request: response, seq: 3 }, 4, "stu-lina")).toEqual([]);
    expect(withPendingRequest(studentRides(before, "stu-omar"), { request: response, seq: 3 }, 3, "stu-omar")).toEqual([]);
  });
});
