/**
 * Phase 2 server integration: the real Fastify app (inject), the real campus and fleet files, and the
 * real engine. Nothing in the engine or the store is mocked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { Cart, RideRequest, Trip, type CampusConfig } from "../shared/schemas";
import { SETTINGS } from "../shared/settings";
import { createFleet, type Fleet } from "../engine/fleet";
import { assignCart, createRequest, fail, startTrip, type RideState } from "../engine/rides";
import { cartAt, lineCampus } from "../engine/testRideFixtures";
import { buildApp } from "./app";
import { loadCampus } from "./campus";
import { loadFleet } from "./fleet";
import { createAppStore } from "./state";
import { registerErrorHandler, rideErrorResponse } from "./errors";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function realApp(campusFile?: string): Promise<FastifyInstance> {
  const campus = loadCampus(campusFile);
  const app = await buildApp({ campus, fleet: loadFleet(campus) });
  apps.push(app);
  return app;
}

function fleetFor(campus: CampusConfig, carts: unknown[]): Fleet {
  const f = createFleet(campus, carts);
  if (!f.ok) throw new Error(f.errors.map((e) => e.message).join("\n"));
  return f.fleet;
}

const post = (app: FastifyInstance, payload: unknown) => app.inject({ method: "POST", url: "/api/ride-requests", payload: payload as object });
const VALID = { studentId: "stu-lina", pickupId: "pickup-main-plaza", destinationId: "library" };

/** Everything the API can show about the state: carts, campus, and every known request and trip. */
async function apiSnapshot(app: FastifyInstance, requestIds: string[]) {
  const carts = (await app.inject("/api/carts")).json();
  const campus = (await app.inject("/api/campus")).json();
  const requests = await Promise.all(requestIds.map(async (id) => (await app.inject(`/api/ride-requests/${id}`)).json()));
  const trips = await Promise.all(requestIds.map(async (id) => (await app.inject(`/api/ride-requests/${id}/trip`)).json()));
  return JSON.stringify({ carts, campus, requests, trips });
}

function writeTemp(name: string, content: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), "fleet-")), name);
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

// ---------- 1, 2: initialization ----------

describe("initialization", () => {
  it("starts with the configured campus and the seeded fleet for it", async () => {
    for (const [file, id] of [[undefined, "wadi-cedar"], ["campus/demo-valley.json", "demo-valley"]] as const) {
      const app = await realApp(file);
      expect((await app.inject("/api/health")).json()).toMatchObject({ ok: true, campus: id });
      const carts = (await app.inject("/api/carts")).json();
      expect(carts.map((c: { id: string }) => c.id)).toEqual(["CART-01", "CART-02"]);
    }
  });

  it("the seed fleets use the persona drivers and validate against the shared Cart schema", () => {
    for (const file of ["campus/fleets/wadi-cedar.json", "campus/fleets/demo-valley.json"]) {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      for (const c of raw.carts) expect(Cart.safeParse(c).success).toBe(true);
      expect(raw.carts.map((c: { driverId: string }) => c.driverId)).toEqual(["drv-yazan", "drv-rana"]);
      expect(raw.carts.every((c: { simulated: boolean }) => c.simulated)).toBe(true);
    }
  });

  it("refuses a missing fleet file, a fleet for another campus, or invalid carts, with readable messages", () => {
    const campus = loadCampus();
    expect(() => loadFleet(campus, "campus/fleets/nope.json")).toThrow(/Could not read fleet file/);
    expect(() => loadFleet(campus, "campus/fleets/demo-valley.json")).toThrow(/is for campus "demo-valley", but the loaded campus is "wadi-cedar"/);
    expect(() => loadFleet(campus, writeTemp("bad.json", "{not json"))).toThrow(/Could not read fleet file/);
    expect(() => loadFleet(campus, writeTemp("empty.json", { campusId: "wadi-cedar", carts: [] }))).toThrow(/at least one cart/);
    expect(() => loadFleet(campus, writeTemp("extra.json", { campusId: "wadi-cedar", carts: [cartAt("CART-01", "depot")], dispatch: "x" }))).toThrow(/is invalid/);
    const twoProblems = writeTemp("carts.json", {
      campusId: "wadi-cedar",
      carts: [cartAt("CART-01", "depot", { batteryPercent: 140 }), cartAt("CART-02", "moon-base")],
    });
    expect(() => loadFleet(campus, twoProblems)).toThrow(/CART-01[\s\S]*Battery must be between 0 and 100%[\s\S]*CART-02 is at "moon-base"/);
    const dup = writeTemp("dup.json", { campusId: "wadi-cedar", carts: [cartAt("CART-01", "depot"), cartAt("CART-01", "library")] });
    expect(() => loadFleet(campus, dup)).toThrow(/used more than once/);
  });

  it("FLEET_FILE picks the fleet file", () => {
    const campus = loadCampus();
    const file = writeTemp("one.json", { campusId: "wadi-cedar", carts: [cartAt("CART-07", "library")] });
    const prev = process.env.FLEET_FILE;
    process.env.FLEET_FILE = file;
    try {
      expect([...loadFleet(campus).carts.keys()]).toEqual(["CART-07"]);
    } finally {
      if (prev === undefined) delete process.env.FLEET_FILE;
      else process.env.FLEET_FILE = prev;
    }
  });

  it("buildApp refuses a fleet that does not belong to the campus instead of starting with a default state", async () => {
    const wadi = loadCampus();
    const valleyFleet = loadFleet(loadCampus("campus/demo-valley.json"));
    await expect(buildApp({ campus: wadi, fleet: valleyFleet })).rejects.toThrow(/Could not start the ride engine: The fleet was built for campus "demo-valley"/);
  });

  it("does not change the caller's campus object", async () => {
    const campus = loadCampus();
    const before = JSON.stringify(campus);
    apps.push(await buildApp({ campus, fleet: loadFleet(campus) }));
    expect(Object.isFrozen(campus)).toBe(false);
    expect(JSON.stringify(campus)).toBe(before);
  });
});

// ---------- 3, 4: campus and fleet endpoints ----------

describe("campus and fleet endpoints", () => {
  it("serves the campus with its locations", async () => {
    const app = await realApp();
    const campus = (await app.inject("/api/campus")).json();
    expect(campus.id).toBe("wadi-cedar");
    expect(campus.locations).toHaveLength(15);
    expect(campus.locations.find((l: { id: string }) => l.id === "library")).toMatchObject({ canStop: true });
  });

  it("lists carts with their full status, and serves one cart by id", async () => {
    const app = await realApp();
    const res = await app.inject("/api/carts");
    expect(res.statusCode).toBe(200);
    const carts = res.json();
    for (const c of carts) expect(Cart.safeParse(c).success).toBe(true);
    expect(carts[0]).toMatchObject({ id: "CART-01", status: "idle", position: { kind: "at", locationId: "depot" }, passengerCount: 0, maxSpeedKmh: 15, simulated: true });

    const one = await app.inject("/api/carts/CART-02");
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ id: "CART-02", driverId: "drv-rana" });
  });

  it("returns 404 with a stable code for an unknown cart", async () => {
    const app = await realApp();
    const res = await app.inject("/api/carts/CART-99");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'No cart with id "CART-99" in this fleet', code: "UNKNOWN_CART" });
  });
});

// ---------- 5-9: creating and reading ride requests ----------

describe("ride requests", () => {
  it("creates a request with engine-generated id, status, fare and timestamps", async () => {
    const app = await realApp();
    const res = await post(app, VALID);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(RideRequest.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      id: "REQ-0001", studentId: "stu-lina", pickupId: "pickup-main-plaza", destinationId: "library",
      mode: "solo", priority: false, status: "requested", createdAt: 0, updatedAt: 0,
      fareJod: SETTINGS.fareJod, freeLoyaltyRide: false,
    });
  });

  it("creating a request does not assign a cart or change the fleet", async () => {
    const app = await realApp();
    const before = (await app.inject("/api/carts")).body;
    await post(app, VALID);
    expect((await app.inject("/api/carts")).body).toBe(before);
    expect((await app.inject("/api/ride-requests/REQ-0001/trip")).json()).toEqual({ trip: null });
  });

  it("reads a created request back by id", async () => {
    const app = await realApp();
    const created = (await post(app, VALID)).json();
    const res = await app.inject(`/api/ride-requests/${created.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(created);
  });

  it("rejects unknown, non-stop and identical locations with 400 and the engine's code", async () => {
    const campus = lineCampus();
    const app = await buildApp({ campus, fleet: fleetFor(campus, [cartAt("CART-01", "a")]) });
    apps.push(app);
    const cases: [object, string, RegExp][] = [
      [{ studentId: "s", pickupId: "nowhere", destinationId: "b" }, "UNKNOWN_LOCATION", /pickupId "nowhere" is not a location/],
      [{ studentId: "s", pickupId: "a", destinationId: "nowhere" }, "UNKNOWN_LOCATION", /destinationId "nowhere" is not a location/],
      [{ studentId: "s", pickupId: "x", destinationId: "b" }, "NOT_A_STOP", /pickupId "x" is not a place where carts can stop/],
      [{ studentId: "s", pickupId: "a", destinationId: "x" }, "NOT_A_STOP", /destinationId "x"/],
      [{ studentId: "s", pickupId: "b", destinationId: "b" }, "SAME_LOCATION", /must differ/],
    ];
    for (const [payload, code, msg] of cases) {
      const res = await post(app, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().code).toBe(code);
      expect(res.json().error).toMatch(msg);
    }
  });

  it("rejects malformed and unsupported input with 400", async () => {
    const app = await realApp();
    const bad: unknown[] = [
      {},
      { pickupId: "pickup-main-plaza", destinationId: "library" },
      { ...VALID, studentId: "" },
      { ...VALID, pickupId: 42 },
      { ...VALID, destinationId: null },
      [VALID],
      { ...VALID, mode: "shared" },
      { ...VALID, mode: "solo" },
      { ...VALID, priority: true },
    ];
    for (const payload of bad) {
      const res = await post(app, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toMatchObject({ code: "INVALID_REQUEST" });
      expect(Array.isArray(res.json().issues)).toBe(true);
    }
    // Broken JSON or an unsupported content type: Fastify's own errors, in the same body shape.
    const notJson = await app.inject({ method: "POST", url: "/api/ride-requests", headers: { "content-type": "application/json" }, payload: "{oops" });
    expect(notJson.statusCode).toBe(400);
    expect(Object.keys(notJson.json()).sort()).toEqual(["code", "error"]);
    const text = await app.inject({ method: "POST", url: "/api/ride-requests", headers: { "content-type": "text/plain" }, payload: "hello" });
    expect(text.statusCode).toBe(400); // Fastify parses text/plain as a string; the schema refuses it
    expect(text.json().code).toBe("INVALID_REQUEST");
    const xml = await app.inject({ method: "POST", url: "/api/ride-requests", headers: { "content-type": "application/xml" }, payload: "<a/>" });
    expect(xml.statusCode).toBe(415);
    expect(Object.keys(xml.json()).sort()).toEqual(["code", "error"]);
    const jsonString = await app.inject({ method: "POST", url: "/api/ride-requests", headers: { "content-type": "application/json" }, payload: '"pickup-main-plaza"' });
    expect(jsonString.statusCode).toBe(400);
    expect(jsonString.json().code).toBe("INVALID_REQUEST");
    const empty = await app.inject({ method: "POST", url: "/api/ride-requests" });
    expect(empty.statusCode).toBe(400);
    // Nothing was created by any of them.
    expect((await app.inject("/api/ride-requests/REQ-0001")).statusCode).toBe(404);
  });

  it("rejects every client-controlled internal value instead of ignoring it", async () => {
    const app = await realApp();
    const internal: Record<string, unknown> = {
      id: "REQ-9999", status: "completed", fareJod: 0, freeLoyaltyRide: true, createdAt: 123, updatedAt: 456,
      cartId: "CART-01", tripId: "TRIP-0001", passengerCount: 3, boarded: true, clockSeconds: 999,
      position: { kind: "at", locationId: "library" }, cartStatus: "occupied", nextRequestNo: 50,
    };
    for (const [field, value] of Object.entries(internal)) {
      const res = await post(app, { ...VALID, [field]: value });
      expect(res.statusCode, field).toBe(400);
      expect(res.json().code).toBe("INVALID_REQUEST");
      expect(res.json().error).toContain(`Field(s) not allowed: ${field}`);
    }
    // The next real request still gets the first engine id and the approved fare.
    const ok = (await post(app, VALID)).json();
    expect(ok).toMatchObject({ id: "REQ-0001", status: "requested", fareJod: SETTINGS.fareJod, createdAt: 0 });
  });

  it("returns 404 for unknown request ids, on the request and on its trip", async () => {
    const app = await realApp();
    for (const id of ["REQ-0001", "nope", "__proto__", "REQ-0001%20"]) {
      for (const url of [`/api/ride-requests/${id}`, `/api/ride-requests/${id}/trip`]) {
        const res = await app.inject(url);
        expect(res.statusCode, url).toBe(404);
        expect(res.json().code).toBe("UNKNOWN_REQUEST");
      }
    }
  });

  it("duplicate submissions create separate requests (the engine has no idempotency rule)", async () => {
    const app = await realApp();
    const a = (await post(app, VALID)).json();
    const b = (await post(app, VALID)).json();
    expect([a.id, b.id]).toEqual(["REQ-0001", "REQ-0002"]);
    expect({ ...a, id: "" }).toEqual({ ...b, id: "" });
  });
});

// ---------- 10: current trip ----------

describe("current trip", () => {
  it("is null while the request has no cart", async () => {
    const app = await realApp();
    const { id } = (await post(app, VALID)).json();
    const res = await app.inject(`/api/ride-requests/${id}/trip`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ trip: null });
  });

  it("returns the trip once the engine has assigned and started it (state prepared with engine operations)", async () => {
    const campus = loadCampus();
    const store = createAppStore(campus, loadFleet(campus));
    const created = store.apply((s) => createRequest(s, VALID));
    if (!created.ok) throw new Error(created.error.message);
    expect(store.apply((s) => assignCart(s, created.request.id, "CART-01")).ok).toBe(true);
    const app = await buildApp({ store });
    apps.push(app);

    const planned = (await app.inject(`/api/ride-requests/${created.request.id}/trip`)).json();
    expect(Trip.safeParse(planned.trip).success).toBe(true);
    expect(planned.trip).toMatchObject({ id: "TRIP-0001", cartId: "CART-01", status: "planned", leg: null, passengers: [{ requestId: "REQ-0001", boarded: false }] });
    expect((await app.inject(`/api/ride-requests/${created.request.id}`)).json().status).toBe("assigned");
    expect((await app.inject("/api/carts/CART-01")).json().status).toBe("assigned");

    expect(store.apply((s) => startTrip(s, created.request.id)).ok).toBe(true);
    const active = (await app.inject(`/api/ride-requests/${created.request.id}/trip`)).json();
    expect(active.trip).toMatchObject({ status: "active", stopIndex: 0 });
    expect(active.trip.leg.locationIds[0]).toBe("depot");
    expect(active.trip.leg.locationIds.at(-1)).toBe("pickup-main-plaza");
  });
});

// ---------- 11: error mapping ----------

describe("error mapping", () => {
  it("maps engine codes to 400, 404, 409 and 500, hiding details of internal errors", () => {
    const status = (code: Parameters<typeof fail>[0]) => rideErrorResponse(fail(code, "details").error).status;
    expect(status("INVALID_REQUEST")).toBe(400);
    expect(status("UNKNOWN_LOCATION")).toBe(400);
    expect(status("NOT_A_STOP")).toBe(400);
    expect(status("SAME_LOCATION")).toBe(400);
    expect(status("UNKNOWN_REQUEST")).toBe(404);
    expect(status("UNKNOWN_CART")).toBe(404);
    expect(status("NO_ROUTE")).toBe(409);
    expect(status("CART_ALREADY_ASSIGNED")).toBe(409);
    expect(status("RIDE_FINISHED")).toBe(409);
    expect(status("CANNOT_CANCEL_ON_BOARD")).toBe(409);
    expect(rideErrorResponse(fail("INCONSISTENT_STATE", "secret internals").error)).toEqual({ status: 500, body: { error: "Internal server error", code: "INTERNAL_ERROR" } });
    expect(rideErrorResponse(fail("INVALID_MOVEMENT", "x").error).status).toBe(500);
    expect(rideErrorResponse(fail("CART_ON_TRIP", "msg").error).body).toEqual({ error: "msg", code: "CART_ON_TRIP" });
  });

  it("an unexpected exception becomes a generic 500 with no stack trace", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = Fastify();
    apps.push(app);
    registerErrorHandler(app);
    app.get("/boom", async () => { throw new Error("secret stack details"); });
    try {
      const res = await app.inject("/boom");
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: "Internal server error", code: "INTERNAL_ERROR" });
      expect(res.body).not.toContain("secret");
      expect(err).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
    }
  });
});

// ---------- 12-15: authoritative state, atomicity, isolation, copies ----------

describe("authoritative state", () => {
  it("failed operations leave the state completely unchanged", async () => {
    const app = await realApp();
    await post(app, VALID);
    const before = await apiSnapshot(app, ["REQ-0001", "REQ-0002"]);
    const failures = [
      { ...VALID, pickupId: "nowhere" },
      { ...VALID, destinationId: VALID.pickupId },
      { ...VALID, fareJod: 0 },
      {},
    ];
    for (const f of failures) expect((await post(app, f)).statusCode).toBe(400);
    expect(await apiSnapshot(app, ["REQ-0001", "REQ-0002"])).toBe(before);
    // The id counter did not move either: the next success is REQ-0002.
    expect((await post(app, VALID)).json().id).toBe("REQ-0002");
  });

  it("the store keeps the exact previous state object when an operation fails or throws", () => {
    const campus = loadCampus();
    const store = createAppStore(campus, loadFleet(campus));
    const seen: RideState[] = [];
    const peek = () => store.apply((s) => { seen.push(s); return fail("INVALID_REQUEST", "peek only"); });

    peek();
    expect(store.apply((s) => createRequest(s, { ...VALID, pickupId: "nowhere" })).ok).toBe(false);
    peek();
    expect(() => store.apply(() => { throw new Error("bug in an operation"); })).toThrow("bug in an operation");
    peek();
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toBe(seen[0]);

    expect(store.apply((s) => createRequest(s, VALID)).ok).toBe(true);
    peek();
    expect(seen[3]).not.toBe(seen[0]);
    expect(seen[3]!.requests.size).toBe(1);
  });

  it("every route of one app shares one state", async () => {
    const app = await realApp();
    const a = (await post(app, VALID)).json();
    const b = (await post(app, { studentId: "stu-omar", pickupId: "library", destinationId: "sports" })).json();
    expect([a.id, b.id]).toEqual(["REQ-0001", "REQ-0002"]);
    expect((await app.inject("/api/ride-requests/REQ-0001")).json()).toEqual(a);
    expect((await app.inject("/api/ride-requests/REQ-0002")).json()).toEqual(b);
    expect((await app.inject("/api/ride-requests/REQ-0002/trip")).json()).toEqual({ trip: null });
  });

  it("concurrent requests are applied one at a time with no lost update", async () => {
    const app = await realApp();
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => post(app, { ...VALID, studentId: `stu-${i}` })));
    const ids = results.map((r) => r.json().id).sort();
    expect(new Set(ids).size).toBe(25);
    expect(ids[0]).toBe("REQ-0001");
    expect(ids.at(-1)).toBe("REQ-0025");
    for (let i = 1; i <= 25; i++) expect((await app.inject(`/api/ride-requests/REQ-${String(i).padStart(4, "0")}`)).statusCode).toBe(200);
  });

  it("separate app instances are isolated from each other", async () => {
    const one = await realApp();
    const two = await realApp();
    expect((await post(one, VALID)).json().id).toBe("REQ-0001");
    expect((await two.inject("/api/ride-requests/REQ-0001")).statusCode).toBe(404);
    expect((await post(two, VALID)).json().id).toBe("REQ-0001");
    expect((await post(one, VALID)).json().id).toBe("REQ-0002");
  });

  it("values read from or returned by the store are copies that cannot change the stored state", () => {
    const campus = loadCampus();
    const store = createAppStore(campus, loadFleet(campus));
    const created = store.apply((s) => createRequest(s, VALID));
    if (!created.ok) throw new Error(created.error.message);

    // Change everything we were handed.
    (created.request as { status: string }).status = "completed";
    const carts = store.read((s) => [...s.fleet.carts.values()]);
    (carts[0] as { batteryPercent: number }).batteryPercent = 1;
    (carts[0]!.position as { locationId: string }).locationId = "library";
    const read = store.read((s) => s.requests.get("REQ-0001")!);
    (read as { fareJod: number }).fareJod = 99;
    const c = store.read((s) => s.campus);
    c.locations.pop();
    (c as { name: string }).name = "Changed";

    expect(store.read((s) => s.requests.get("REQ-0001"))).toMatchObject({ status: "requested", fareJod: SETTINGS.fareJod });
    expect(store.read((s) => s.fleet.carts.get("CART-01"))).toMatchObject({ batteryPercent: 100, position: { kind: "at", locationId: "depot" } });
    expect(store.read((s) => s.campus.locations.length)).toBe(15);
    expect(store.read((s) => s.campus.name)).toBe("Wadi Cedar University");
  });

  it("the stored campus is deep-frozen, so even a selector cannot change it", () => {
    const campus = loadCampus();
    const store = createAppStore(campus, loadFleet(campus));
    expect(() => store.read((s) => (s.campus.locations[0] as { name: string }).name = "x")).toThrow(TypeError);
    expect(() => store.read((s) => (s.campus.locations as unknown[]).push({}))).toThrow(TypeError);
  });

  it("GET responses are plain JSON: changing one response does not affect the next", async () => {
    const app = await realApp();
    await post(app, VALID);
    for (const url of ["/api/campus", "/api/carts", "/api/carts/CART-01", "/api/ride-requests/REQ-0001", "/api/ride-requests/REQ-0001/trip"]) {
      const first = await app.inject(url);
      const parsed = first.json();
      if (Array.isArray(parsed)) parsed.length = 0;
      else for (const k of Object.keys(parsed)) delete parsed[k];
      expect((await app.inject(url)).body, url).toBe(first.body);
    }
  });

  it("there are no write routes besides creating a request", async () => {
    const app = await realApp();
    await post(app, VALID);
    for (const [method, url] of [
      ["PUT", "/api/ride-requests/REQ-0001"], ["PATCH", "/api/ride-requests/REQ-0001"], ["DELETE", "/api/ride-requests/REQ-0001"],
      ["POST", "/api/carts"], ["PATCH", "/api/carts/CART-01"], ["POST", "/api/ride-requests/REQ-0001/trip"], ["POST", "/api/campus"],
    ] as const) {
      expect((await app.inject({ method, url, payload: {} })).statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await app.inject("/api/ride-requests/REQ-0001")).json().status).toBe("requested");
  });
});
