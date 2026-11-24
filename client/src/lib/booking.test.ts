/**
 * Phase 3 Prompt 1: booking from the Student App. Selection checks, the submission guards, and the
 * controller against the REAL ride-request API on a listening server (fetch over HTTP).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { checkSelection, bookingBlockReason, createBookingController, stopLocations } from "./booking";
import { createRideApi } from "./rideApi";
import { cartAt, lineCampus, liveApp } from "./testSupport";
import { snapshotOf } from "../../../server/realtime";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe("selection checks", () => {
  const campus = lineCampus();

  it("offers only the campus's stop locations", () => {
    expect(stopLocations(campus).map((l) => l.id)).toEqual(["a", "b", "c", "d", "e"]); // "x" has canStop false
  });

  it.each([
    ["", "e", "pickupId", "Choose a pickup location."],
    ["c", "", "destinationId", "Choose a destination."],
    ["nowhere", "e", "pickupId", "That pickup is not a stop on this campus. Choose another."],
    ["c", "x", "destinationId", "That destination is not a stop on this campus. Choose another."],
    ["c", "c", "destinationId", "Pickup and destination must be different."],
  ])("pickup %j, destination %j is refused", (pickupId, destinationId, field, message) => {
    expect(checkSelection(campus, pickupId, destinationId)).toEqual({ ok: false, field, message });
  });

  it("two different stops are accepted", () => {
    expect(checkSelection(campus, "c", "e")).toEqual({ ok: true });
  });
});

describe("booking against the real API", () => {
  async function setup(clientCampus = lineCampus()) {
    const live = await liveApp(apps, lineCampus(), [cartAt("CART-01", "a")]);
    const sent: unknown[] = [];
    const recordingFetch: typeof fetch = (input, init) => {
      if (init?.body) sent.push(JSON.parse(String(init.body)));
      return fetch(input, init);
    };
    const api = createRideApi(live.url, recordingFetch);
    const data = () => live.store.read(snapshotOf);
    const controller = createBookingController({ api, campus: clientCampus, currentData: data });
    return { live, sent, controller, data };
  }

  it("sends exactly studentId, pickupId and destinationId, and keeps the server's request as is", async () => {
    const { sent, controller, data } = await setup();
    expect(await controller.submit({ studentId: "stu-lina", pickupId: "c", destinationId: "e" })).toBe("sent");
    expect(sent).toEqual([{ studentId: "stu-lina", pickupId: "c", destinationId: "e" }]);
    const state = controller.getState();
    expect(state.status).toBe("success");
    // The confirmed request is the server's: its id, status, fare and timestamps.
    expect(state.status === "success" && state.request).toEqual(data().requests[0]);
    expect(data().requests[0]).toMatchObject({ status: "requested", fareJod: 0.25, freeLoyaltyRide: false });
    expect(data().trips).toEqual([]); // no cart is assigned by booking
  });

  it("repeated taps while a request is in flight create exactly one ride request", async () => {
    const { controller, data } = await setup();
    const input = { studentId: "stu-lina", pickupId: "c", destinationId: "e" };
    const results = await Promise.all([controller.submit(input), controller.submit(input), controller.submit(input)]);
    expect(results).toEqual(["sent", "ignored", "ignored"]);
    expect(data().requests).toHaveLength(1);
  });

  it("an invalid selection never reaches the server", async () => {
    const { sent, controller } = await setup();
    expect(await controller.submit({ studentId: "stu-lina", pickupId: "c", destinationId: "c" })).toBe("invalid");
    expect(controller.getState()).toEqual({ status: "error", message: "Pickup and destination must be different.", code: "INVALID_SELECTION" });
    expect(sent).toEqual([]);
  });

  it("a server refusal is shown with the server's own explanation", async () => {
    // The client's copy of the campus wrongly lists "x" as a stop; the server's engine refuses it.
    const stale = lineCampus();
    const clientCampus = { ...stale, locations: stale.locations.map((l) => (l.id === "x" ? { ...l, canStop: true } : l)) };
    const { controller, data } = await setup(clientCampus);
    expect(await controller.submit({ studentId: "stu-lina", pickupId: "c", destinationId: "x" })).toBe("failed");
    expect(controller.getState()).toEqual({ status: "error", code: "NOT_A_STOP", message: 'destinationId "x" is not a place where carts can stop' });
    expect(data().requests).toEqual([]);
  });

  it("an unreachable server gives an actionable message and no success state", async () => {
    const { live, controller } = await setup();
    await live.app.close();
    expect(await controller.submit({ studentId: "stu-lina", pickupId: "c", destinationId: "e" })).toBe("failed");
    expect(controller.getState()).toMatchObject({ status: "error", code: "NETWORK_ERROR" });
  });

  it("submission re-checks the live state: an active ride or a different campus blocks it", async () => {
    const { controller, data, sent } = await setup();
    await controller.submit({ studentId: "stu-lina", pickupId: "c", destinationId: "e" });
    expect(await controller.submit({ studentId: "stu-lina", pickupId: "a", destinationId: "b" })).toBe("blocked");
    expect(sent).toHaveLength(1);
    // Another student is not blocked by Lina's ride.
    expect(bookingBlockReason(lineCampus(), data(), "stu-omar")).toBeNull();
    expect(bookingBlockReason(lineCampus(), { ...data(), campusId: "another-campus" }, "stu-omar")).toMatch(/different campus/);
    expect(bookingBlockReason(lineCampus(), null, "stu-omar")).toMatch(/Connecting/);
  });
});
