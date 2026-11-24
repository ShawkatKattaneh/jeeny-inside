/**
 * Phase 3 Prompt 1: the Student screens rendered with React (react-dom/server, no browser), wired to
 * the real realtime store fed with snapshots from the real engine. Covers routing and persona gating,
 * what each screen shows for actual ride states, the booking error message, and fare wording.
 * Interaction in a real browser at a phone viewport was checked separately (see the report).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { CampusConfig, Persona } from "../../../shared/schemas";
import { PERSONAS } from "../../../shared/personas";
import { createRequest } from "../../../engine/rides";
import { dispatchRequest } from "../../../engine/dispatch";
import { CampusContext } from "../lib/campusContext";
import { createBookingController } from "../lib/booking";
import { RealtimeProvider } from "../lib/realtimeContext";
import { createRealtimeStore } from "../lib/realtimeStore";
import type { RideApi } from "../lib/rideApi";
import { studentRides } from "../lib/studentRides";
import { FakeSocket, lineCampus, memoryStorage, recordingStore } from "../lib/testSupport";
import { StudentHome } from "../routes/StudentHome";
import { BookingPanel } from "./BookingPanel";
import { StudentDataContext, type StudentData } from "./studentContext";

const lina = PERSONAS.find((p) => p.id === "stu-lina")!;
const omar = PERSONAS.find((p) => p.id === "stu-omar")!;
const unusedApi: RideApi = {
  createRideRequest: () => Promise.reject(new Error("not used")),
  cancelRide: () => Promise.reject(new Error("not used")),
};

beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));
afterEach(() => vi.unstubAllGlobals());

const usePersona = (p: Persona | null) => vi.stubGlobal("localStorage", memoryStorage(p ? { "jeeny-inside:persona": JSON.stringify(p) } : {}));

/** A realtime store that has received `snapshot` as its connection snapshot (or nothing yet). */
function liveStore(snapshot?: ReturnType<ReturnType<typeof recordingStore>["snapshot"]>) {
  const socket = new FakeSocket();
  const store = createRealtimeStore({ socket, fetchSnapshot: () => Promise.reject(new Error("unused")) });
  store.start();
  if (snapshot) socket.serverConnect(snapshot);
  return store;
}

function render(path: string, store = liveStore(), campus: CampusConfig = lineCampus()) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <CampusContext.Provider value={campus}>
        <Routes>
          <Route path="/" element={<p>PERSONA PICKER</p>} />
          <Route path="/student/*" element={<StudentHome store={store} api={unusedApi} />} />
        </Routes>
      </CampusContext.Provider>
    </MemoryRouter>,
  );
}

/** Visible text of rendered HTML, with React's entity escapes decoded. */
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("routing and persona", () => {
  it("a student persona gets the Student App with navigation, campus and persona name", () => {
    usePersona(lina);
    const rec = recordingStore();
    const t = text(render("/student", liveStore(rec.snapshot())));
    expect(t).toContain("Hi Lina");
    expect(t).toContain("Line"); // campus name from the campus data
    expect(t).toContain("Home");
    expect(t).toContain("Your rides");
    expect(t).toContain("Where to?");
    expect(t).toContain("Live");
  });

  it("without a student persona, nothing of the Student App renders (the layout sends back to the picker)", () => {
    usePersona(null);
    expect(text(render("/student"))).not.toContain("Where to?");
    usePersona(PERSONAS.find((p) => p.role === "driver")!);
    expect(text(render("/student"))).not.toContain("Where to?");
  });

  it("before the first snapshot it shows a loading state, not an empty booking or history", () => {
    usePersona(lina);
    expect(text(render("/student"))).toContain("Loading your rides…");
    expect(text(render("/student/rides"))).toContain("Loading your rides…");
  });
});

describe("home screen", () => {
  it("lists only the campus's stop locations (from the campus data) in pickup and destination", () => {
    usePersona(lina);
    const html = render("/student", liveStore(recordingStore().snapshot()));
    const options = [...html.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
    // Two selects, each: placeholder + the stops a..e. "x" (canStop: false) is never offered.
    expect(options).toEqual(["", "a", "b", "c", "d", "e", "", "a", "b", "c", "d", "e"]);
  });

  it("shows the approved fare and pricing rules without claiming any earned loyalty benefit", () => {
    usePersona(lina);
    const t = text(render("/student", liveStore(recordingStore().snapshot())));
    expect(t).toContain("0.25 JOD");
    expect(t).toContain("Approved demo rate");
    expect(t).toContain("after 5 completed paid rides, the next one is free");
    expect(t).toContain("Loyalty tracking is not active in this prototype yet, so no free ride is counted or awarded.");
    expect(t).not.toMatch(/you('ve| have) earned|free ride (unlocked|earned)|rides? (left|to go)/i);
  });

  it("a requested ride shows its real status and no cart", () => {
    usePersona(lina);
    const rec = recordingStore();
    rec.store.apply((s) => createRequest(s, { studentId: "stu-lina", pickupId: "c", destinationId: "e" }));
    const html = render("/student", liveStore(rec.snapshot()));
    const t = text(html);
    expect(t).toContain("Requested");
    expect(t).toContain("Waiting for a cart to be assigned to your ride.");
    expect(html).not.toContain('data-testid="ride-cart"');
    expect(t).not.toContain("Where to?"); // one active ride at a time in the UI
    expect(t).toContain("Cancel ride");
  });

  it("an assigned ride shows the cart the server assigned", () => {
    usePersona(lina);
    const rec = recordingStore();
    const r = rec.store.apply((s) => createRequest(s, { studentId: "stu-lina", pickupId: "c", destinationId: "e" }));
    if (!r.ok) throw new Error("create failed");
    rec.store.apply((s) => dispatchRequest(s, r.request.id));
    const t = text(render("/student", liveStore(rec.snapshot())));
    expect(t).toContain("Cart assigned");
    expect(t).toContain("CART-01 is assigned. The trip to c has not started yet.");
  });

  it("another student's ride is not shown as this student's", () => {
    const rec = recordingStore();
    rec.store.apply((s) => createRequest(s, { studentId: "stu-omar", pickupId: "c", destinationId: "e" }));
    usePersona(lina);
    const t = text(render("/student", liveStore(rec.snapshot())));
    expect(t).toContain("Where to?");
    expect(t).not.toContain("REQ-0001");
    usePersona(omar);
    expect(text(render("/student", liveStore(rec.snapshot())))).toContain("REQ-0001");
  });
});

describe("rides and ride details", () => {
  function twoRides() {
    const rec = recordingStore();
    const a = rec.store.apply((s) => createRequest(s, { studentId: "stu-lina", pickupId: "a", destinationId: "b" }));
    const b = rec.store.apply((s) => createRequest(s, { studentId: "stu-omar", pickupId: "c", destinationId: "d" }));
    if (!a.ok || !b.ok) throw new Error("create failed");
    return { rec, linaId: a.request.id, omarId: b.request.id };
  }

  it("history lists the student's own rides from the live state, with an empty state otherwise", () => {
    const { rec, linaId, omarId } = twoRides();
    usePersona(lina);
    const t = text(render("/student/rides", liveStore(rec.snapshot())));
    expect(t).toContain(linaId);
    expect(t).not.toContain(omarId);
    usePersona(PERSONAS.find((p) => p.id === "stu-sara")!);
    expect(text(render("/student/rides", liveStore(rec.snapshot())))).toContain("No rides yet");
  });

  it("ride details show server values; another student's ride id is 'not found'", () => {
    const { rec, linaId, omarId } = twoRides();
    usePersona(lina);
    const t = text(render(`/student/rides/${linaId}`, liveStore(rec.snapshot())));
    expect(t).toContain("server status: requested");
    expect(t).toContain("Not assigned yet");
    expect(t).toContain("No trip");
    expect(t).toContain("0.25 JOD (simulated, no payment taken)");
    expect(text(render(`/student/rides/${omarId}`, liveStore(rec.snapshot())))).toContain("This ride was not found among your rides.");
  });
});

describe("booking form messages", () => {
  it("a failed booking shows the server's explanation as an alert", async () => {
    const rec = recordingStore();
    const campus = lineCampus();
    const api: RideApi = {
      createRideRequest: async () => ({ ok: false, status: 409, code: "NO_ROUTE", message: "No route from c to e" }),
      cancelRide: unusedApi.cancelRide,
    };
    const store = liveStore(rec.snapshot());
    const booking = createBookingController({ api, campus, currentData: () => store.getState().data });
    expect(await booking.submit({ studentId: "stu-lina", pickupId: "c", destinationId: "e" })).toBe("failed");
    const value: StudentData = {
      persona: lina, campus, api, store, realtime: store.getState(), booking,
      rides: studentRides(store.getState().data!, "stu-lina"), activeRide: null,
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <RealtimeProvider store={store}>
          <StudentDataContext.Provider value={value}>
            <BookingPanel selection={{ pickupId: "c", destinationId: "e" }} onChange={() => {}} />
          </StudentDataContext.Provider>
        </RealtimeProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("Couldn't request the ride: No route from c to e");
  });

  it("identical pickup and destination disable the request button with a clear message", () => {
    const rec = recordingStore();
    const campus = lineCampus();
    const store = liveStore(rec.snapshot());
    const booking = createBookingController({ api: unusedApi, campus, currentData: () => store.getState().data });
    const value: StudentData = { persona: lina, campus, api: unusedApi, store, realtime: store.getState(), booking, rides: [], activeRide: null };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StudentDataContext.Provider value={value}>
          <BookingPanel selection={{ pickupId: "c", destinationId: "c" }} onChange={() => {}} />
        </StudentDataContext.Provider>
      </MemoryRouter>,
    );
    expect(text(html)).toContain("Pickup and destination must be different.");
    expect(html).toMatch(/<button type="submit" disabled=""/);
  });
});
