/**
 * Phase 4 Tap-In on the client: tap point URLs, resolving a scanned point, which of the student's rides
 * the /tap screen offers, the arrival state shown on cards, and the POST /api/ride-requests/:id/tap-in
 * call. Everything here is presentation: the server repeats every check on submission (engine/tapIn.ts)
 * and its answer is the only thing that turns into "recorded".
 *
 * NFC tags and printed QR codes hold the SAME plain URL: http://<public host>:<port>/tap/<campusId>/<locationId>.
 * The phone's own NFC reader or camera opens it; there is no Web NFC and no in-app camera scanner.
 */
import { z } from "zod";
import qrcode from "qrcode-generator";
import { Cart, RideRequest, Trip, type CampusConfig, type Location, type TapInBody, type TripPassenger } from "../../../shared/schemas";
import type { ApiResult } from "./rideApi";
import type { StudentRide } from "./studentRides";
import { formatSimTime } from "../student/format";

/** The one URL format for NFC tags and QR codes. No secrets: campus id and location id only. */
export function tapPath(campusId: string, locationId: string): string {
  return `/tap/${encodeURIComponent(campusId)}/${encodeURIComponent(locationId)}`;
}
export function tapUrl(baseUrl: string, campusId: string, locationId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${tapPath(campusId, locationId)}`;
}

/** Points that accept Tap-In: every location where carts can stop (the approved canStop rule). */
export function tapPoints(campus: CampusConfig): Location[] {
  return campus.locations.filter((l) => l.canStop);
}

export type ResolvedPoint =
  | { kind: "ok"; location: Location }
  | { kind: "wrong_campus" }
  | { kind: "unknown" }
  | { kind: "not_supported"; location: Location };

/** What a scanned URL names, against the campus the app has loaded. A hint only: the server checks again. */
export function resolveTapPoint(campus: CampusConfig, campusId: string, locationId: string): ResolvedPoint {
  if (campusId !== campus.id) return { kind: "wrong_campus" };
  const location = campus.locations.find((l) => l.id === locationId);
  if (!location) return { kind: "unknown" };
  return location.canStop ? { kind: "ok", location } : { kind: "not_supported", location };
}

export function passengerOf(trip: Trip | null, requestId: string): TripPassenger | null {
  return trip?.passengers.find((p) => p.requestId === requestId) ?? null;
}

/**
 * - "current": tapped in at the CURRENT pickup and still waiting for the driver (not boarded, not cancelled).
 * - "history": a record exists, but it is not a current arrival (boarded, dropped off, cancelled, finished,
 *   or recorded at a location that is not the current pickup).
 * - null: no Tap-In.
 */
export type ArrivalState = { kind: "current"; locationId: string; atMs: number } | { kind: "history"; locationId: string; atMs: number; atCurrentPickup: boolean } | null;

export function arrivalState(request: RideRequest, passenger: TripPassenger | null): ArrivalState {
  const rec = passenger?.tappedIn;
  if (!rec) return null;
  const atCurrentPickup = rec.locationId === request.pickupId;
  const waiting = !passenger.boarded && !passenger.droppedOff && !passenger.cancelled && (request.status === "assigned" || request.status === "arriving");
  return atCurrentPickup && waiting ? { kind: "current", ...rec } : { kind: "history", ...rec, atCurrentPickup };
}

/** A first Tap-In is possible: dispatched (assigned or arriving) and the rider is still waiting. */
export function canFirstTapIn(ride: StudentRide): boolean {
  const p = passengerOf(ride.trip, ride.request.id);
  return (ride.request.status === "assigned" || ride.request.status === "arriving") && !!p && !p.boarded && !p.droppedOff && !p.cancelled;
}

/** Offer the "I'm at my pickup" entry: a first Tap-In is possible and none is recorded yet. */
export function showTapInEntry(ride: StudentRide): boolean {
  return ride.synced && canFirstTapIn(ride) && !passengerOf(ride.trip, ride.request.id)?.tappedIn;
}

/**
 * How the /tap screen treats one of the student's rides for this point:
 * - "ready": a first Tap-In here can be sent.
 * - "recorded_here": already tapped in at this point (any state, even cancelled): sending again is a replay.
 * - "other_pickup": dispatched and waiting, but its pickup is elsewhere (or it is tapped in elsewhere): not sendable here.
 */
export type CandidateKind = "ready" | "recorded_here" | "other_pickup";
export interface TapCandidate {
  ride: StudentRide;
  kind: CandidateKind;
}

/**
 * The rides the /tap screen lists: the student's rides that could tap in now, plus any already tapped in
 * at this point. Never picks one when several can be sent (the screen asks the student to choose).
 */
export function tapCandidates(rides: StudentRide[], pointId: string): TapCandidate[] {
  const out: TapCandidate[] = [];
  for (const ride of rides) {
    if (!ride.synced) continue;
    const rec = passengerOf(ride.trip, ride.request.id)?.tappedIn;
    if (rec) {
      if (rec.locationId === pointId) out.push({ ride, kind: "recorded_here" });
      else if (canFirstTapIn(ride)) out.push({ ride, kind: "other_pickup" });
      continue;
    }
    if (canFirstTapIn(ride)) out.push({ ride, kind: ride.request.pickupId === pointId ? "ready" : "other_pickup" });
  }
  return out;
}
export const sendable = (c: TapCandidate) => c.kind === "ready" || c.kind === "recorded_here";

/** The student-facing explanation of each server refusal. The server's own message is shown beside it. */
export const TAP_IN_ERROR_TEXT: Record<string, string> = {
  INVALID_REQUEST: "The app sent an incomplete Tap-In. Reload the page and try again.",
  UNKNOWN_REQUEST: "This ride no longer exists on the server.",
  UNKNOWN_POINT: "This tag or QR code names a point this campus doesn't have.",
  POINT_NOT_SUPPORTED: "This place isn't a pickup point, so you can't tap in here.",
  NOT_YOUR_RIDE: "This ride belongs to another student persona.",
  TAP_IN_NOT_ALLOWED: "Tap-In isn't possible for this ride right now.",
  PICKUP_MISMATCH: "This isn't the pickup point for this ride.",
  NETWORK_ERROR: "Couldn't reach the Jeeny INSIDE server. Nothing was recorded.",
};

export const TapInResponse = z.object({
  request: RideRequest,
  trip: Trip,
  cart: Cart,
  tapIn: z.object({ requestId: z.string(), locationId: z.string(), atMs: z.number() }),
  alreadyRecorded: z.boolean(),
});
export type TapInResponse = z.infer<typeof TapInResponse>;

export interface TapInApi {
  /** POST /api/ride-requests/:id/tap-in { studentId, campusId, pointId }. */
  tapIn(requestId: string, body: TapInBody): Promise<ApiResult<TapInResponse>>;
}

const ErrorBody = z.object({ error: z.string(), code: z.string() });
const UNREACHABLE = "Couldn't reach the Jeeny INSIDE server. Check that this phone is on the same network as the server and try again.";

export function createTapInApi(baseUrl = "", fetchImpl: typeof fetch = (...args) => fetch(...args)): TapInApi {
  return {
    async tapIn(requestId, body) {
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}/api/ride-requests/${encodeURIComponent(requestId)}/tap-in`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        return { ok: false, status: null, code: "NETWORK_ERROR", message: UNREACHABLE };
      }
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        /* handled below */
      }
      if (!res.ok) {
        const err = ErrorBody.safeParse(json);
        return err.success
          ? { ok: false, status: res.status, code: err.data.code, message: err.data.error }
          : { ok: false, status: res.status, code: "UNEXPECTED_RESPONSE", message: `The server answered ${res.status}.` };
      }
      const parsed = TapInResponse.safeParse(json);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, status: res.status, code: "UNEXPECTED_RESPONSE", message: "The server's answer was not in the expected format." };
    },
  };
}

/** GET /api/about: only the Tap-In base URL is read here (null when the server has no public host set). */
export const AboutTapInfo = z.object({ tapBaseUrl: z.string().nullable() });
export async function fetchTapBaseUrl(fetchImpl: typeof fetch = (...args) => fetch(...args)): Promise<string | null> {
  const res = await fetchImpl("/api/about");
  if (!res.ok) throw new Error(`/api/about answered ${res.status}`);
  return AboutTapInfo.parse(await res.json()).tapBaseUrl;
}

/** QR modules for a URL (error correction M), as a square boolean grid. The same string as the NFC tag. */
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_r, row) => Array.from({ length: n }, (_c, col) => qr.isDark(row, col)));
}

/** Operations wording for a recorded Tap-In: always "not verified", never arrival or boarding. */
export function opsTapInText(request: RideRequest, passenger: TripPassenger | null, name: (id: string) => string): string | null {
  const a = arrivalState(request, passenger);
  if (!a) return null;
  const base = `Tap-In recorded ${formatSimTime(a.atMs)} at ${name(a.locationId)} (not verified)`;
  return a.kind === "current" ? `${base}, waiting for the driver to board` : `${base}, history${a.atCurrentPickup ? "" : ": not the current pickup"}`;
}

export type TapInSubmitState =
  | { step: "idle" }
  | { step: "sending"; requestId: string }
  | { step: "done"; result: TapInResponse }
  | { step: "error"; requestId: string; code: string; message: string };

export interface TapInSubmitter {
  getState(): TapInSubmitState;
  subscribe(listener: () => void): () => void;
  /** Sends one Tap-In. Ignored while one is in flight. "done" only after the server's 200. */
  submit(requestId: string, body: TapInBody): Promise<void>;
}

/** The /tap screen's submission: one call at a time, success only from the server's answer. */
export function createTapInSubmitter(api: TapInApi, onDone?: (result: TapInResponse) => void): TapInSubmitter {
  let state: TapInSubmitState = { step: "idle" };
  const listeners = new Set<() => void>();
  const set = (s: TapInSubmitState) => {
    state = s;
    for (const l of [...listeners]) l();
  };
  return {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    async submit(requestId, body) {
      if (state.step === "sending") return;
      set({ step: "sending", requestId });
      const res = await api.tapIn(requestId, body);
      if (!res.ok) return set({ step: "error", requestId, code: res.code, message: res.message });
      set({ step: "done", result: res.value });
      onDone?.(res.value);
    },
  };
}

/** What a "Copy URL" press did: copied by the Clipboard API, or the person must copy the URL by hand. */
export type CopyOutcome = "copied" | "manual";

/**
 * Copy with the Clipboard API when the browser offers it. On a plain-HTTP LAN address it is usually
 * missing (it needs a secure context) or refuses: then the caller shows the manual-copy fallback.
 */
export async function copyText(text: string, clipboard: Pick<Clipboard, "writeText"> | undefined = globalThis.navigator?.clipboard): Promise<CopyOutcome> {
  if (!clipboard || typeof clipboard.writeText !== "function") return "manual";
  try {
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "manual";
  }
}
