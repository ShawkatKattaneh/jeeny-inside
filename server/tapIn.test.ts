/**
 * Phase 4 Tap-In through the real Fastify app (inject) and the real store: the exact approved contract
 * (route, strict body, success shape, the seven error codes and statuses), the check order, replay
 * idempotency in every lifecycle state, one revision only for the first success, concurrency, and the
 * configured public host. Commit listeners see exactly what Socket.IO broadcasts (updateOf).
 * Line campus: a - b - c - d - e (10 s per path for these carts); "x" exists but is not a stop.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { StateUpdate, type CartInput } from "../shared/schemas";
import { createFleet } from "../engine/fleet";
import { cartAt, lineCampus } from "../engine/testRideFixtures";
import { buildApp } from "./app";
import { parsePublicHost, tapBaseUrlFor } from "./network";
import { updateOf } from "./realtime";
import { createAppStore } from "./state";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function lineApp(carts: CartInput[] = [cartAt("CART-01", "a"), cartAt("CART-02", "e")], tapBaseUrl?: string | null) {
  const campus = lineCampus();
  const fleet = createFleet(campus, carts);
  if (!fleet.ok) throw new Error(fleet.errors.map((e) => e.message).join("; "));
  const store = createAppStore(campus, fleet.fleet);
  const app = await buildApp({ store, ...(tapBaseUrl === undefined ? {} : { tapBaseUrl }) });
  apps.push(app);
  const updates: StateUpdate[] = [];
  store.onCommit((c) => updates.push(StateUpdate.parse(updateOf(c))));
  const revision = () => store.read((_s, rev) => rev);
  const snapshot = async () => (await app.inject({ method: "GET", url: "/api/snapshot" })).json();
  return { app, store, updates, revision, snapshot };
}

const post = (app: FastifyInstance, url: string, payload?: unknown) =>
  app.inject({ method: "POST", url, ...(payload === undefined ? {} : { payload: payload as object }) });
const body = (pointId: string, over: Record<string, unknown> = {}) => ({ studentId: "stu-lina", campusId: "line", pointId, ...over });
const tap = (app: FastifyInstance, id: string, payload: unknown) => post(app, `/api/ride-requests/${id}/tap-in`, payload);
async function create(app: FastifyInstance, studentId = "stu-lina", pickupId = "b", destinationId = "d", mode?: string) {
  const res = await post(app, "/api/ride-requests", { studentId, pickupId, destinationId, ...(mode ? { mode } : {}) });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}
const act = async (app: FastifyInstance, id: string, action: string) => {
  const res = await post(app, `/api/ride-requests/${id}/${action}`);
  expect(res.statusCode, `${action}: ${res.body}`).toBe(200);
};
const advanceBy = async (app: FastifyInstance, seconds: number) => expect((await post(app, "/api/simulation/advance", { seconds })).statusCode).toBe(200);
async function dispatched(app: FastifyInstance) {
  const id = await create(app);
  await act(app, id, "dispatch");
  return id;
}
async function atPickup(app: FastifyInstance) {
  const id = await dispatched(app);
  await act(app, id, "start");
  await advanceBy(app, 10);
  return id;
}

describe("Tap-In contract: route, strict body, success shape", () => {
  it("first Tap-In: 200 with request, trip, cart, tapIn {requestId, locationId, atMs} and alreadyRecorded false", async () => {
    const { app } = await lineApp();
    const id = await atPickup(app);
    const res = await tap(app, id, body("b"));
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(Object.keys(r).sort()).toEqual(["alreadyRecorded", "cart", "request", "tapIn", "trip"]);
    expect(r.tapIn).toEqual({ requestId: id, locationId: "b", atMs: 10000 });
    expect(r.alreadyRecorded).toBe(false);
    expect(r.request).toMatchObject({ id, status: "arriving", pickupId: "b" });
    expect(r.cart).toMatchObject({ id: "CART-01", passengerCount: 0, status: "assigned" });
    expect(r.trip.passengers[0]).toMatchObject({ requestId: id, boarded: false, tappedIn: { locationId: "b", atMs: 10000 } });
  });

  it("the server generates atMs: a client-supplied timestamp is an extra field and is refused", async () => {
    const { app, revision } = await lineApp();
    const id = await atPickup(app);
    const rev = revision();
    const res = await tap(app, id, body("b", { atMs: 1 }));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_REQUEST");
    expect(revision()).toBe(rev);
  });

  it("strict body: missing, empty, non-string or extra fields, or no body at all -> 400 INVALID_REQUEST, nothing committed", async () => {
    const { app, revision, updates } = await lineApp();
    const id = await dispatched(app);
    const rev = revision();
    const n = updates.length;
    const bad: unknown[] = [
      undefined,
      {},
      { campusId: "line", pointId: "b" },
      { studentId: "stu-lina", pointId: "b" },
      { studentId: "stu-lina", campusId: "line" },
      body("b", { studentId: "" }),
      body("b", { campusId: "" }),
      body(""),
      body("b", { pointId: 7 }),
      body("b", { requestId: id }),
      body("b", { extra: true }),
    ];
    for (const payload of bad) {
      const res = await tap(app, id, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().code, JSON.stringify(payload)).toBe("INVALID_REQUEST");
    }
    expect(revision()).toBe(rev);
    expect(updates.length).toBe(n);
  });
});

describe("Tap-In malformed JSON (audit fix F1)", () => {
  const raw = (app: FastifyInstance, url: string, payload: string, contentType = "application/json") =>
    app.inject({ method: "POST", url, headers: { "content-type": contentType }, payload });

  it("malformed or empty JSON on the Tap-In route -> 400 INVALID_REQUEST; nothing committed", async () => {
    const { app, revision, updates } = await lineApp();
    const id = await dispatched(app);
    const rev = revision();
    const n = updates.length;
    for (const payload of ["{not json", '{"studentId": "stu-lina",', "[1,", ""]) {
      const res = await raw(app, `/api/ride-requests/${id}/tap-in`, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json(), JSON.stringify(payload)).toMatchObject({ code: "INVALID_REQUEST", error: expect.any(String) });
    }
    expect(revision()).toBe(rev);
    expect(updates.length).toBe(n);
  });

  it("malformed JSON on an unknown request id is still 400 INVALID_REQUEST (the body is checked first)", async () => {
    const { app } = await lineApp();
    const res = await raw(app, "/api/ride-requests/REQ-9999/tap-in", "{not json");
    expect([res.statusCode, res.json().code]).toEqual([400, "INVALID_REQUEST"]);
  });

  it("unrelated routes keep the existing app-wide behaviour for malformed JSON (Fastify's own code)", async () => {
    const { app } = await lineApp();
    const id = await create(app);
    for (const url of ["/api/ride-requests", `/api/ride-requests/${id}/cancel`, `/api/ride-requests/${id}/dispatch`, "/api/simulation/advance"]) {
      const res = await raw(app, url, "{not json");
      expect(res.statusCode, url).toBe(400);
      expect(res.json().code, url).toBe("FST_ERR_CTP_INVALID_JSON_BODY");
    }
  });

  it("other Fastify errors on the Tap-In route still use the app-wide handler (unsupported content type)", async () => {
    const { app } = await lineApp();
    const id = await dispatched(app);
    const tapRes = await raw(app, `/api/ride-requests/${id}/tap-in`, "<x/>", "application/xml");
    const cancelRes = await raw(app, `/api/ride-requests/${id}/cancel`, "<x/>", "application/xml");
    expect(tapRes.statusCode).toBe(cancelRes.statusCode);
    expect(tapRes.json().code).toBe(cancelRes.json().code);
    expect(tapRes.json().code).not.toBe("INVALID_REQUEST");
  });
});

describe("Tap-In errors and their order", () => {
  const expectError = async (res: Awaited<ReturnType<typeof tap>>, status: number, code: string) => {
    expect(res.statusCode, res.body).toBe(status);
    expect(res.json()).toMatchObject({ code, error: expect.any(String) });
  };

  it("all seven codes with their approved HTTP statuses; none commits a revision or an update", async () => {
    const { app, revision, updates, snapshot } = await lineApp();
    const id = await dispatched(app);
    const requested = await create(app, "stu-omar", "c", "e");
    const rev = revision();
    const n = updates.length;
    const before = await snapshot();
    await expectError(await tap(app, id, { studentId: "stu-lina" }), 400, "INVALID_REQUEST");
    await expectError(await tap(app, "REQ-9999", body("b")), 404, "UNKNOWN_REQUEST");
    await expectError(await tap(app, id, body("b", { campusId: "wadi-cedar" })), 400, "UNKNOWN_POINT"); // campus mismatch
    await expectError(await tap(app, id, body("b", { campusId: "nowhere" })), 400, "UNKNOWN_POINT"); // unknown campus
    await expectError(await tap(app, id, body("zz")), 400, "UNKNOWN_POINT"); // unknown point
    await expectError(await tap(app, id, body("x")), 400, "POINT_NOT_SUPPORTED");
    await expectError(await tap(app, id, body("b", { studentId: "stu-omar" })), 409, "NOT_YOUR_RIDE");
    await expectError(await tap(app, requested, body("c", { studentId: "stu-omar" })), 409, "TAP_IN_NOT_ALLOWED"); // not dispatched
    await expectError(await tap(app, id, body("c")), 409, "PICKUP_MISMATCH"); // a stop, but not the assigned pickup
    expect(revision()).toBe(rev);
    expect(updates.length).toBe(n);
    expect(await snapshot()).toEqual(before);
  });

  it("checks body, then request, then campus/point, then support, then student, then lifecycle, then pickup", async () => {
    const { app } = await lineApp();
    const requested = await create(app); // lifecycle would refuse it
    await expectError(await tap(app, "REQ-9999", { bad: 1 }), 400, "INVALID_REQUEST");
    await expectError(await tap(app, "REQ-9999", body("zz", { studentId: "stu-omar" })), 404, "UNKNOWN_REQUEST");
    await expectError(await tap(app, requested, body("zz", { studentId: "stu-omar" })), 400, "UNKNOWN_POINT");
    await expectError(await tap(app, requested, body("x", { studentId: "stu-omar" })), 400, "POINT_NOT_SUPPORTED");
    await expectError(await tap(app, requested, body("c", { studentId: "stu-omar" })), 409, "NOT_YOUR_RIDE");
    await expectError(await tap(app, requested, body("c")), 409, "TAP_IN_NOT_ALLOWED");
  });

  it("first Tap-In after boarding, drop-off or cancellation -> 409 TAP_IN_NOT_ALLOWED", async () => {
    const { app, revision } = await lineApp();
    const id = await atPickup(app);
    const refusedWithoutRevision = async (rid: string, payload: unknown) => {
      const rev = revision();
      await expectError(await tap(app, rid, payload), 409, "TAP_IN_NOT_ALLOWED");
      expect(revision()).toBe(rev);
    };
    await act(app, id, "board");
    await refusedWithoutRevision(id, body("b"));
    await advanceBy(app, 20);
    await act(app, id, "drop-off");
    await refusedWithoutRevision(id, body("b"));
    const c = await create(app, "stu-omar", "c", "e");
    await act(app, c, "dispatch");
    await act(app, c, "cancel");
    await refusedWithoutRevision(c, body("c", { studentId: "stu-omar" }));
  });
});

describe("Tap-In idempotency, revisions and realtime", () => {
  it("only the first success commits: one ride.tapped_in revision whose update carries only the changed trip", async () => {
    const { app, revision, updates } = await lineApp();
    const id = await atPickup(app);
    const rev = revision();
    const n = updates.length;
    expect((await tap(app, id, body("b"))).statusCode).toBe(200);
    expect(revision()).toBe(rev + 1);
    expect(updates.length).toBe(n + 1);
    const u = updates.at(-1)!;
    expect(u.operation).toBe("ride.tapped_in");
    expect(u.revision).toBe(rev + 1);
    expect(u.requests).toEqual([]);
    expect(u.carts).toEqual([]);
    expect(u.trips).toHaveLength(1);
    expect(u.trips[0]!.passengers[0]!.tappedIn).toEqual({ locationId: "b", atMs: 10000 });
  });

  it("exact replay: the original record and timestamp, alreadyRecorded true, no revision, no update", async () => {
    const { app, revision, updates } = await lineApp();
    const id = await atPickup(app);
    const firstRes = (await tap(app, id, body("b"))).json();
    await advanceBy(app, 5); // time moves on (the cart is waiting at the pickup)
    const rev = revision();
    const n = updates.length;
    const again = await tap(app, id, body("b"));
    expect(again.statusCode).toBe(200);
    expect(again.json().alreadyRecorded).toBe(true);
    expect(again.json().tapIn).toEqual(firstRes.tapIn);
    expect(revision()).toBe(rev);
    expect(updates.length).toBe(n);
  });

  it("exact replay after boarding, drop-off and cancellation still returns the original record, with no revision", async () => {
    const { app, revision, updates } = await lineApp();
    const id = await atPickup(app);
    const original = (await tap(app, id, body("b"))).json().tapIn;
    const replay = async (rid: string, payload: unknown) => {
      const rev = revision();
      const n = updates.length;
      const res = await tap(app, rid, payload);
      expect(res.statusCode, res.body).toBe(200);
      expect(revision()).toBe(rev);
      expect(updates.length).toBe(n);
      return res.json();
    };
    await act(app, id, "board");
    expect(await replay(id, body("b"))).toMatchObject({ alreadyRecorded: true, tapIn: original, request: { status: "on_board" } });
    await advanceBy(app, 20);
    await act(app, id, "drop-off");
    expect(await replay(id, body("b"))).toMatchObject({ alreadyRecorded: true, tapIn: original, request: { status: "completed" } });

    const c = await create(app, "stu-omar", "c", "e");
    await act(app, c, "dispatch");
    const cRecord = (await tap(app, c, body("c", { studentId: "stu-omar" }))).json().tapIn;
    await act(app, c, "cancel");
    expect(await replay(c, body("c", { studentId: "stu-omar" }))).toMatchObject({ alreadyRecorded: true, tapIn: cRecord, request: { status: "cancelled" } });
  });

  it("different point when a record exists -> 409 PICKUP_MISMATCH while waiting, after boarding, drop-off and cancellation; record kept", async () => {
    const { app, revision, updates, snapshot } = await lineApp();
    const id = await atPickup(app);
    await tap(app, id, body("b"));
    const mismatch = async (rid: string, payload: unknown) => {
      const rev = revision();
      const n = updates.length;
      const before = await snapshot();
      const res = await tap(app, rid, payload);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("PICKUP_MISMATCH");
      expect(revision()).toBe(rev);
      expect(updates.length).toBe(n);
      expect(await snapshot()).toEqual(before);
    };
    await mismatch(id, body("c"));
    await act(app, id, "board");
    await mismatch(id, body("c"));
    await advanceBy(app, 20);
    await act(app, id, "drop-off");
    await mismatch(id, body("a"));
    const c = await create(app, "stu-omar", "c", "e");
    await act(app, c, "dispatch");
    await tap(app, c, body("c", { studentId: "stu-omar" }));
    await act(app, c, "cancel");
    await mismatch(c, body("d", { studentId: "stu-omar" }));
    const snap = await snapshot();
    const rec = (rid: string) => snap.trips.flatMap((t: { passengers: { requestId: string; tappedIn?: unknown }[] }) => t.passengers).find((p: { requestId: string }) => p.requestId === rid).tappedIn;
    expect(rec(id)).toEqual({ locationId: "b", atMs: 10000 });
    expect(rec(c)).toMatchObject({ locationId: "c" });
  });

  it("concurrent identical Tap-Ins: exactly one record and one revision; every response has the same record, duplicates alreadyRecorded", async () => {
    const { app, revision, updates } = await lineApp();
    const id = await atPickup(app);
    const rev = revision();
    const n = updates.length;
    const results = await Promise.all(Array.from({ length: 6 }, () => tap(app, id, body("b"))));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
    const json = results.map((r) => r.json());
    expect(json.filter((j) => j.alreadyRecorded === false)).toHaveLength(1);
    expect(json.filter((j) => j.alreadyRecorded === true)).toHaveLength(5);
    expect(new Set(json.map((j) => JSON.stringify(j.tapIn))).size).toBe(1);
    expect(revision()).toBe(rev + 1);
    expect(updates.length).toBe(n + 1);
    expect(updates.filter((u) => u.operation === "ride.tapped_in")).toHaveLength(1);
  });

  it("concurrent Tap-Ins at different points for one ride: at most one record, never overwritten; conflicts get PICKUP_MISMATCH", async () => {
    const { app, revision, updates, snapshot } = await lineApp();
    const id = await atPickup(app);
    const rev = revision();
    const n = updates.length;
    const results = await Promise.all([tap(app, id, body("c")), tap(app, id, body("b")), tap(app, id, body("d")), tap(app, id, body("b"))]);
    expect(results.map((r) => [r.statusCode, r.json().code ?? r.json().alreadyRecorded])).toEqual([
      [409, "PICKUP_MISMATCH"],
      [200, false],
      [409, "PICKUP_MISMATCH"],
      [200, true],
    ]);
    expect(revision()).toBe(rev + 1);
    expect(updates.length).toBe(n + 1);
    expect((await snapshot()).trips[0].passengers[0].tappedIn).toEqual({ locationId: "b", atMs: 10000 });
  });

  it("re-validates at submission time: a Tap-In sent after the driver boarded the rider is refused, not recorded", async () => {
    const { app, revision } = await lineApp();
    const id = await atPickup(app);
    await act(app, id, "board"); // the student's screen may still show "waiting"
    const rev = revision();
    const res = await tap(app, id, body("b"));
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("TAP_IN_NOT_ALLOWED");
    expect(revision()).toBe(rev);
  });

  it("Tap-In does not dispatch, board, move carts or change fares: the driver still boards afterwards", async () => {
    const { app, snapshot } = await lineApp();
    const id = await atPickup(app);
    const before = await snapshot();
    await tap(app, id, body("b"));
    const after = await snapshot();
    expect(after.requests).toEqual(before.requests);
    expect(after.carts).toEqual(before.carts);
    expect(after.trips[0].stops).toEqual(before.trips[0].stops);
    expect(after.trips[0].status).toBe(before.trips[0].status);
    expect(after.trips[0].stopIndex).toBe(before.trips[0].stopIndex);
    await act(app, id, "board");
    expect((await snapshot()).requests[0].status).toBe("on_board");
  });
});

describe("Tap-In public host", () => {
  it("GET /api/about reports tapBaseUrl from the configured host, and null when none is configured", async () => {
    const none = await lineApp(undefined);
    expect((await none.app.inject({ method: "GET", url: "/api/about" })).json().tapBaseUrl).toBeNull();
    const set = await lineApp(undefined, "http://demo-laptop.local:3000");
    const about = (await set.app.inject({ method: "GET", url: "/api/about" })).json();
    expect(about.tapBaseUrl).toBe("http://demo-laptop.local:3000");
    expect(about).toHaveProperty("note");
    expect(about).toHaveProperty("settings");
  });

  it("parsePublicHost accepts a bare hostname or IPv4 address and refuses schemes, ports, paths and bad addresses", () => {
    expect(parsePublicHost(undefined)).toEqual({ ok: true, host: null });
    expect(parsePublicHost("  ")).toEqual({ ok: true, host: null });
    for (const good of ["10.0.0.5", "192.168.137.1", "demo-laptop", "demo-laptop.local"]) expect(parsePublicHost(good)).toEqual({ ok: true, host: good });
    for (const bad of ["http://10.0.0.5", "10.0.0.5:3000", "10.0.0.5/tap", "300.1.1.1", "1.2.3", "has space", "-bad.local", "a..b"]) {
      expect(parsePublicHost(bad).ok, bad).toBe(false);
    }
  });

  it("tapBaseUrlFor builds http://<host>:<port>, follows a host change, and is null without a host", () => {
    expect(tapBaseUrlFor("10.0.0.5", 3000)).toBe("http://10.0.0.5:3000");
    expect(tapBaseUrlFor("10.0.0.9", 3000)).toBe("http://10.0.0.9:3000");
    expect(tapBaseUrlFor(null, 3000)).toBeNull();
  });
});
