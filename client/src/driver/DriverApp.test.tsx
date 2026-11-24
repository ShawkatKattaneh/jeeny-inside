/**
 * Phase 3 Prompt 2: Driver Mode rendered with React (react-dom/server, no browser), fed by the real
 * realtime store with snapshots from the real engine. Covers persona gating, the cart link, empty and
 * no-cart states, the next-step button and its "unavailable" reasons, the multiple-trip picker, that
 * nothing renders a success or an assignment the server did not report, and the single socket.
 * Real interaction at a phone viewport was checked separately in Chromium (see the report).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { Persona, StateSnapshot } from "../../../shared/schemas";
import { PERSONAS } from "../../../shared/personas";
import { createRequest, startTrip } from "../../../engine/rides";
import { dispatchRequest } from "../../../engine/dispatch";
import { CampusContext } from "../lib/campusContext";
import { createRealtimeStore } from "../lib/realtimeStore";
import type { DriverApi } from "../lib/rideApi";
import { FakeSocket, cartAt, lineCampus, memoryStorage, recordingStore } from "../lib/testSupport";
import { DriverHome } from "../routes/DriverHome";

const ioCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("socket.io-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("socket.io-client")>();
  return { ...real, io: (...args: Parameters<typeof real.io>) => { ioCalls.count += 1; return real.io(...args); } };
});

const yazan = PERSONAS.find((p) => p.id === "drv-yazan")!;
const lina = PERSONAS.find((p) => p.id === "stu-lina")!;
const noApi: DriverApi = { rideAction: () => Promise.reject(new Error("must not be called while rendering")) };

beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));
afterEach(() => vi.unstubAllGlobals());
const usePersona = (p: Persona | null) => vi.stubGlobal("localStorage", memoryStorage(p ? { "jeeny-inside:persona": JSON.stringify(p) } : {}));

function server(carts = [cartAt("CART-01", "a", { driverId: "drv-yazan" }), cartAt("CART-02", "e", { driverId: "drv-rana" })]) {
  return recordingStore(lineCampus(), carts);
}
function liveStore(snapshot?: StateSnapshot) {
  const socket = new FakeSocket();
  const store = createRealtimeStore({ socket, fetchSnapshot: () => Promise.reject(new Error("unused")) });
  store.start();
  if (snapshot) socket.serverConnect(snapshot);
  return store;
}
function render(snapshot?: StateSnapshot, store = liveStore(snapshot)) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/driver"]}>
      <CampusContext.Provider value={lineCampus()}>
        <Routes>
          <Route path="/" element={<p>PERSONA PICKER</p>} />
          <Route path="/driver" element={<DriverHome store={store} api={noApi} personas={PERSONAS} />} />
        </Routes>
      </CampusContext.Provider>
    </MemoryRouter>,
  );
}
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("persona and identity", () => {
  it("only a driver persona gets Driver Mode", () => {
    usePersona(lina);
    expect(text(render(server().snapshot()))).not.toContain("Driver Mode");
    usePersona(null);
    expect(text(render(server().snapshot()))).not.toContain("Driver Mode");
    usePersona(yazan);
    expect(text(render(server().snapshot()))).toContain("Driver Mode");
  });

  it("before the first snapshot it shows loading, not an empty or no-cart state", () => {
    usePersona(yazan);
    const t = text(render());
    expect(t).toContain("Loading the live fleet…");
    expect(t).not.toContain("No cart is assigned");
    expect(t).not.toContain("No trip assigned");
  });

  it("shows the cart whose server driverId is this driver, with the server's battery, status and seats", () => {
    usePersona(yazan);
    const html = render(server([cartAt("CART-01", "a", { driverId: "drv-yazan", batteryPercent: 64 })]).snapshot());
    expect(html).toMatch(/data-testid="driver-cart">CART-01</);
    expect(html).toMatch(/data-testid="cart-battery">64%</);
    expect(html).toMatch(/data-testid="cart-status">Idle</);
    expect(html).toMatch(/data-testid="cart-passengers">0\/4</);
    expect(text(html)).toContain("No trip assigned to your cart");
  });

  it("no cart in the live fleet for this driver: a clear no-cart state plus the persona mismatch, nothing invented", () => {
    usePersona(yazan);
    const html = render(server([cartAt("CART-01", "a", { driverId: null })]).snapshot());
    expect(html).toContain('data-testid="no-cart"');
    expect(html).toContain('data-testid="cart-mismatch"');
    expect(text(html)).toContain("Your demo profile lists CART-01, but the live fleet does not assign you any cart.");
    expect(html).not.toContain('data-testid="driver-cart"');
  });

  it("several carts for one driver: asks to choose, shows none by default", () => {
    usePersona(yazan);
    const html = render(server([cartAt("CART-01", "a", { driverId: "drv-yazan" }), cartAt("CART-02", "e", { driverId: "drv-yazan" })]).snapshot());
    expect(text(html)).toContain("The live fleet lists you as the driver of 2 carts. Choose one.");
    expect(html).not.toContain('data-testid="driver-cart"');
  });
});

describe("trip and next step", () => {
  function withRide(cartsDriver = "drv-yazan") {
    const rec = server([cartAt("CART-01", "a", { driverId: cartsDriver }), cartAt("CART-02", "e", { driverId: "drv-rana" })]);
    const r = rec.store.apply((s) => createRequest(s, { studentId: "stu-lina", pickupId: "c", destinationId: "e" }));
    if (!r.ok) throw new Error("create failed");
    rec.store.apply((s) => dispatchRequest(s, r.request.id));
    return { rec, id: r.request.id };
  }

  it("an assigned trip shows the passenger, stops, the three separate statuses and a Start button", () => {
    usePersona(yazan);
    const { rec } = withRide();
    const html = render(rec.snapshot());
    const t = text(html);
    expect(t).toContain("Trip assigned to your cart · TRIP-0001");
    expect(t).toContain("Assigned, not started");
    expect(t).toContain("Lina (stu-lina)");
    expect(t).toContain("Ride: assigned");
    expect(t).toContain("Trip: planned");
    expect(t).toContain("Cart: assigned");
    expect(t).toContain("Assigned (no passengers)");
    expect(html).toMatch(/data-testid="trip-action"[^>]*>Start trip</);
    expect(html).not.toContain('data-testid="action-success"');
  });

  it("while driving to the pickup no step is offered, and the reason is shown", () => {
    usePersona(yazan);
    const { rec, id } = withRide();
    rec.store.apply((s) => startTrip(s, id));
    const html = render(rec.snapshot());
    expect(html).not.toContain('data-testid="trip-action"');
    expect(text(html)).toContain("Boarding opens when the cart reaches the pickup.");
  });

  it("another driver never sees this cart's trip", () => {
    usePersona(PERSONAS.find((p) => p.id === "drv-rana")!);
    const { rec } = withRide();
    const t = text(render(rec.snapshot()));
    expect(t).toContain("No trip assigned to your cart");
    expect(t).not.toContain("TRIP-0001");
  });

  it("several open trips on the cart: listed with an explicit choice, none pre-selected", () => {
    // Not reachable on a valid server (one open trip per cart); a copied trip checks the picker only.
    usePersona(yazan);
    const { rec } = withRide();
    const snap = rec.snapshot();
    const twin = { ...structuredClone(snap.trips[0]!), id: "TRIP-0099" };
    const html = render({ ...snap, trips: [...snap.trips, twin] });
    expect(html).toContain('data-testid="trip-picker"');
    expect(text(html)).toContain("2 open trips are assigned to CART-01. Choose the one to work on.");
    expect(html).not.toContain('data-testid="trip-action"');
  });
});

describe("one socket", () => {
  it("the Driver area creates exactly one Socket.IO client and does not connect while rendering", () => {
    usePersona(yazan);
    ioCalls.count = 0;
    renderToStaticMarkup(
      <MemoryRouter initialEntries={["/driver"]}>
        <CampusContext.Provider value={lineCampus()}>
          <Routes>
            <Route path="/driver" element={<DriverHome api={noApi} personas={PERSONAS} />} />
          </Routes>
        </CampusContext.Provider>
      </MemoryRouter>,
    );
    expect(ioCalls.count).toBe(1);
  });
});
