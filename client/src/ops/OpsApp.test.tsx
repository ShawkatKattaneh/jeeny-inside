/**
 * Phase 3 Prompt 3: the Operations Dashboard rendered with React (react-dom/server, no browser), fed by
 * the real realtime store with snapshots from the real engine. Covers persona gating, loading and empty
 * states, separate counts, that idle carts are never presented as dispatch-eligible, that simulation
 * time comes from the live state, that nothing is dispatched or advanced while rendering, that no
 * identity or authorization is claimed, and the single shared socket.
 * Real interaction at desktop and phone viewports was checked separately in Chromium (see the report).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { Persona, StateSnapshot } from "../../../shared/schemas";
import { PERSONAS } from "../../../shared/personas";
import { createRequest, startTrip } from "../../../engine/rides";
import { dispatchRequest } from "../../../engine/dispatch";
import { advance } from "../../../engine/simulation";
import { CampusContext } from "../lib/campusContext";
import { createRealtimeStore } from "../lib/realtimeStore";
import type { OpsApi } from "../lib/rideApi";
import { FakeSocket, cartAt, lineCampus, memoryStorage, recordingStore } from "../lib/testSupport";
import { OpsHome } from "../routes/OpsHome";

const ioCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("socket.io-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("socket.io-client")>();
  return { ...real, io: (...args: Parameters<typeof real.io>) => { ioCalls.count += 1; return real.io(...args); } };
});

const hadi = PERSONAS.find((p) => p.id === "ops-hadi")!;
const calls: string[] = [];
const noApi: OpsApi = {
  dispatch: (id) => { calls.push(`dispatch ${id}`); return Promise.reject(new Error("must not be called while rendering")); },
  advance: (b) => { calls.push(`advance ${b.seconds}`); return Promise.reject(new Error("must not be called while rendering")); },
};

beforeEach(() => { vi.stubGlobal("localStorage", memoryStorage()); calls.length = 0; });
afterEach(() => vi.unstubAllGlobals());
const usePersona = (p: Persona | null) => vi.stubGlobal("localStorage", memoryStorage(p ? { "jeeny-inside:persona": JSON.stringify(p) } : {}));

const server = (carts = [cartAt("CART-01", "a", { driverId: "drv-yazan" }), cartAt("CART-02", "e", { driverId: "drv-rana" })]) => recordingStore(lineCampus(), carts);
function liveStore(snapshot?: StateSnapshot, status: "live" | "offline" = "live") {
  const socket = new FakeSocket();
  const store = createRealtimeStore({ socket, fetchSnapshot: () => Promise.reject(new Error("unused")) });
  store.start();
  if (snapshot) socket.serverConnect(snapshot);
  if (status === "offline") socket.serverDisconnect();
  return store;
}
function render(snapshot?: StateSnapshot, store = liveStore(snapshot)) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/ops"]}>
      <CampusContext.Provider value={lineCampus()}>
        <Routes>
          <Route path="/" element={<p>PERSONA PICKER</p>} />
          <Route path="/ops" element={<OpsHome store={store} api={noApi} personas={PERSONAS} />} />
        </Routes>
      </CampusContext.Provider>
    </MemoryRouter>,
  );
}
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const count = (html: string, id: string) => html.match(new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`))?.[1];

describe("persona and identity", () => {
  it("only the operator persona gets the dashboard", () => {
    for (const p of [PERSONAS.find((x) => x.id === "stu-lina")!, PERSONAS.find((x) => x.id === "drv-yazan")!, null]) {
      usePersona(p);
      expect(text(render(server().snapshot()))).not.toContain("Operations Center");
    }
    usePersona(hadi);
    expect(text(render(server().snapshot()))).toContain("Operations Center");
  });

  it("is labelled a demo operator interface and claims no sign-in or authorization", () => {
    usePersona(hadi);
    const t = text(render(server().snapshot()));
    expect(t).toContain("Demo operator interface");
    expect(t).toContain("No sign-in");
    for (const claim of ["Logged in", "Signed in as", "Authorized", "Admin", "Secure"]) expect(t).not.toContain(claim);
  });
});

describe("loading, empty and offline", () => {
  it("before the first snapshot: loading, no counts and no empty states", () => {
    usePersona(hadi);
    const html = render();
    expect(html).toContain('data-testid="ops-loading"');
    expect(text(html)).toContain("Loading the live state…");
    expect(html).not.toContain('data-testid="m-carts"');
    expect(html).not.toContain('data-testid="dispatch-empty"');
  });

  it("an empty system shows the real empty states and zero counts", () => {
    usePersona(hadi);
    const html = render(server().snapshot());
    expect(html).toContain('data-testid="dispatch-empty"');
    expect(html).toContain('data-testid="requests-empty"');
    expect(html).toContain('data-testid="trips-empty"');
    expect(count(html, "m-carts")).toBe("2");
    expect(count(html, "m-awaiting")).toBe("0");
    expect(html.match(/data-testid="fleet-row"/g)).toHaveLength(2);
  });

  it("offline keeps the last state visible and says so", () => {
    usePersona(hadi);
    const html = render(undefined, liveStore(server().snapshot(), "offline"));
    expect(html).toContain('data-testid="ops-not-live"');
    expect(text(html)).toContain("Offline: showing the last state received.");
    expect(count(html, "m-carts")).toBe("2");
  });
});

describe("counts and tables", () => {
  function busy() {
    const rec = server([cartAt("CART-01", "a", { driverId: "drv-yazan" }), cartAt("CART-02", "e", { driverId: "drv-rana" }), cartAt("CART-03", "b", { status: "charging" })]);
    const mk = (studentId: string, p: string, d: string) => { const r = rec.store.apply((s) => createRequest(s, { studentId, pickupId: p, destinationId: d })); if (!r.ok) throw new Error(r.error.message); return r.request.id; };
    const a = mk("stu-lina", "c", "e");
    mk("stu-omar", "b", "d");
    rec.store.apply((s) => dispatchRequest(s, a));
    rec.store.apply((s) => startTrip(s, a));
    rec.store.apply((s) => advance(s, 5));
    return rec;
  }

  it("cart, request and trip counts are separate, each by its own statuses", () => {
    usePersona(hadi);
    const html = render(busy().snapshot());
    expect(count(html, "m-carts")).toBe("3");
    expect(count(html, "m-idle")).toBe("1");
    expect(count(html, "m-awaiting")).toBe("1");
    expect(count(html, "m-active")).toBe("2");
    expect(count(html, "m-trips")).toBe("1");
    expect(html).toMatch(/data-testid="cart-assigned"[^>]*>Assigned <b>1<\/b>/);
    expect(html).toMatch(/data-testid="cart-charging"[^>]*>Charging <b>1<\/b>/);
    expect(html).toMatch(/data-testid="req-requested"[^>]*>Requested <b>1<\/b>/);
    expect(html).toMatch(/data-testid="req-arriving"[^>]*>Arriving <b>1<\/b>/);
    expect(html).toMatch(/data-testid="trip-active"[^>]*>Active <b>1<\/b>/);
    expect(html.match(/data-testid="request-row"/g)).toHaveLength(2);
    expect(html.match(/data-testid="trip-row"/g)).toHaveLength(1);
    const t = text(html);
    expect(t).toContain("Yazan (drv-yazan)");
    expect(t).toContain("Between a and b");
  });

  it("idle carts are never presented as dispatch-eligible; requests are 'awaiting dispatch evaluation'", () => {
    usePersona(hadi);
    const html = render(busy().snapshot());
    const t = text(html);
    expect(t).toContain("awaiting dispatch evaluation");
    expect(t).toContain("Idle is a cart status, not a dispatch promise");
    expect(t.toLowerCase()).not.toMatch(/eligible cart|available cart|carts available|ready to dispatch/);
    expect(html.match(/data-testid="dispatch-item"/g)).toHaveLength(1); // only the "requested" one
    expect(t).toContain("Dispatch REQ-0002");
    expect(t).not.toContain("Dispatch REQ-0001");
  });

  it("shows no fabricated metrics: no wait times, utilization, revenue, trends or charts", () => {
    usePersona(hadi);
    const t = text(render(busy().snapshot())).toLowerCase();
    for (const w of ["wait time", "utilization", "revenue", "trend", "forecast", "average", "%" + " utilized"]) expect(t).not.toContain(w);
    expect(t).not.toMatch(/\bjod\b.*total/);
  });

  it("simulation time comes from the live state, labelled as simulation time", () => {
    usePersona(hadi);
    const html = render(busy().snapshot());
    expect(count(html, "sim-clock")).toBe("sim 0:05");
    expect(text(html)).toContain("Simulation time sim 0:05 · revision 5");
    expect(text(html)).toContain("Simulation time, not clock time");
  });
});

describe("nothing runs on its own", () => {
  it("rendering never dispatches or advances, and no success or result is shown", () => {
    usePersona(hadi);
    const rec = server();
    rec.store.apply((s) => createRequest(s, { studentId: "stu-lina", pickupId: "c", destinationId: "e" }));
    const html = render(rec.snapshot());
    expect(calls).toEqual([]);
    expect(html).not.toContain('data-testid="dispatch-success"');
    expect(html).not.toContain('data-testid="sim-success"');
    expect(html).not.toContain("(selected)");
  });
});

describe("one shared socket", () => {
  it("the Ops area creates exactly one Socket.IO client and does not connect while rendering", () => {
    usePersona(hadi);
    ioCalls.count = 0;
    renderToStaticMarkup(
      <MemoryRouter initialEntries={["/ops"]}>
        <CampusContext.Provider value={lineCampus()}>
          <Routes>
            <Route path="/ops" element={<OpsHome api={noApi} personas={PERSONAS} />} />
          </Routes>
        </CampusContext.Provider>
      </MemoryRouter>,
    );
    expect(ioCalls.count).toBe(1);
  });

  it("the dashboard reads the injected shared store (no parallel state): a newer snapshot is what renders", () => {
    usePersona(hadi);
    const rec = server();
    const socket = new FakeSocket();
    const store = createRealtimeStore({ socket, fetchSnapshot: () => Promise.reject(new Error("unused")) });
    store.start();
    socket.serverConnect(rec.snapshot());
    rec.store.apply((s) => advance(s, 30));
    socket.emit("state:update", rec.updates.at(-1));
    expect(store.getState().data!.revision).toBe(1);
    expect(count(render(undefined, store), "sim-clock")).toBe("sim 0:30");
  });
});
