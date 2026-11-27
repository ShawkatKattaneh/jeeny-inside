import type { CampusConfig, Location, StateSnapshot } from "../../../shared/schemas";
import { SETTINGS } from "../../../shared/settings";
import { LOCATION_TYPE_LABEL } from "../lib/mapGeometry";
import { PHASE_LABEL, canCancel, phaseDetail, type StudentRide } from "../lib/studentRides";
import { showTapInEntry, tapPath } from "../lib/tapIn";
import { formatJod } from "./format";
import { loyaltyLine } from "./loyalty";

/**
 * Campus Copilot: a deterministic, rule-based assistant. It answers only from the campus file, the live
 * ride state, the server's ETA and the approved rules, and offers only actions the app really has. Anything
 * else gets an honest "I can't help with that". No language model is used and nothing leaves this server.
 */
export type CopilotAction = { kind: "set-pickup" | "set-destination"; locationId: string; label: string } | { kind: "link"; to: string; label: string };
export interface CopilotAnswer { text: string; actions: CopilotAction[]; topic: string }
export interface CopilotContext { campus: CampusConfig; rides: StudentRide[]; activeRide: StudentRide | null; data: StateSnapshot | null; etaText?: string | null }

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const has = (q: string, ...words: string[]) => words.some((w) => new RegExp(`\\b${w}`).test(q));

/** The campus location a question names, by full name, short name or a distinctive word of the name. */
export function findLocation(campus: CampusConfig, question: string): Location | null {
  const q = ` ${norm(question)} `;
  const scored = campus.locations.map((l) => {
    const names = [l.name, l.shortName ?? ""].filter(Boolean).map(norm);
    let score = 0;
    for (const n of names) if (n && q.includes(` ${n} `)) score = Math.max(score, 100 + n.length);
    if (!score) {
      const words = norm(l.name).split(" ").filter((w) => w.length > 3 && !["stop", "faculty", "school", "building", "center", "centre", "campus"].includes(w));
      for (const w of words) if (q.includes(` ${w} `)) score = Math.max(score, w.length);
    }
    return { l, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  return scored[0]?.l ?? null;
}

function neighbours(campus: CampusConfig, id: string): string[] {
  const name = (x: string) => campus.locations.find((l) => l.id === x)?.name ?? x;
  const ids = new Set<string>();
  for (const p of campus.paths) {
    if (p.from === id) ids.add(p.to);
    if (p.to === id && !p.oneWay) ids.add(p.from);
  }
  return [...ids].map(name);
}

export const SUGGESTIONS = ["Where is the library?", "How much is a ride?", "How does Tap-In work?", "Where is my cart?", "How many carts are free?", "How do free rides work?"];

export function answer(question: string, ctx: CopilotContext): CopilotAnswer {
  const q = norm(question);
  const { campus, activeRide, data, rides } = ctx;
  if (!q) return { topic: "empty", text: "Ask me about campus stops, booking, fares, free rides, Tap-In, shared rides, your ride or the carts.", actions: [] };

  if (has(q, "sos", "emergenc", "danger", "help me", "police", "ambulance", "injur")) {
    return { topic: "sos", text: "I can't call for help: this app is not connected to any emergency service. If you are in danger, contact campus security or your local emergency number directly.", actions: [{ kind: "link", to: "/student/priority", label: "Emergency info" }] };
  }
  if (has(q, "priority", "wheelchair", "accessib", "disab", "mobility")) {
    return { topic: "priority", text: "Priority Mobility is not available in this build: there is no eligibility check or priority dispatch yet, so every booking is a standard request.", actions: [{ kind: "link", to: "/student/priority", label: "Priority Mobility" }] };
  }
  if (has(q, "my ride", "my cart", "my trip", "status", "eta", "how long", "when will", "arriv", "where is my")) {
    if (!activeRide) return { topic: "ride", text: "You have no active ride right now. Choose a pickup and a destination on Home to request one.", actions: [{ kind: "link", to: "/student", label: "Book a ride" }] };
    const parts = [`Your ride ${activeRide.request.id} is "${PHASE_LABEL[activeRide.phase]}". ${phaseDetail(activeRide, campus)}`];
    if (ctx.etaText) parts.push(ctx.etaText);
    if (activeRide.phase === "requested") parts.push("Operations assigns a cart; there is no arrival time until then.");
    const actions: CopilotAction[] = [{ kind: "link", to: `/student/rides/${encodeURIComponent(activeRide.request.id)}`, label: "Ride details" }];
    if (showTapInEntry(activeRide)) actions.push({ kind: "link", to: tapPath(campus.id, activeRide.request.pickupId), label: "I'm at my pickup" });
    return { topic: "ride", text: parts.join(" "), actions };
  }
  if (has(q, "cancel")) {
    if (activeRide && canCancel(activeRide)) return { topic: "cancel", text: "You can cancel your ride before boarding with \"Cancel ride\" on its card. No fare is charged for a cancelled ride.", actions: [{ kind: "link", to: "/student", label: "Go to my ride" }] };
    if (activeRide) return { topic: "cancel", text: "This ride can no longer be cancelled: once you are on board, it ends with the driver's drop-off.", actions: [] };
    return { topic: "cancel", text: "You can cancel a ride before boarding from its card on Home. You have no active ride now.", actions: [] };
  }
  if (has(q, "tap", "nfc", "qr", "check in", "checkin")) {
    const actions: CopilotAction[] = activeRide && showTapInEntry(activeRide) ? [{ kind: "link", to: tapPath(campus.id, activeRide.request.pickupId), label: "Open Tap-In" }] : [];
    return { topic: "tapin", text: "Tap-In records that you are at your pickup point: tap the NFC tag or scan the QR code there, or use \"I'm at my pickup\" once a cart is assigned. It is a check-in only: it does not board you, and the driver still confirms boarding.", actions };
  }
  if (has(q, "carts", "available", "free cart", "how many", "busy", "fleet")) {
    if (!data) return { topic: "fleet", text: "I don't have the live state yet. Try again once the app shows Live.", actions: [] };
    const idle = data.carts.filter((c) => c.status === "idle").length;
    const waiting = data.requests.filter((r) => r.status === "requested").length;
    return { topic: "fleet", text: `Right now ${idle} of ${data.carts.length} carts are idle and ${waiting} ride request${waiting === 1 ? " is" : "s are"} waiting for dispatch. These are simulated carts.`, actions: [{ kind: "link", to: "/student/pulse", label: "Campus Pulse" }] };
  }
  if (has(q, "free", "loyal", "reward", "6th", "sixth")) {
    return { topic: "loyalty", text: `After ${SETTINGS.loyaltyPaidRidesForFree} completed paid rides, your next ride is free. Cancelled and free rides do not count. ${loyaltyLine(rides)}`, actions: [{ kind: "link", to: "/student/impact", label: "Campus Impact" }] };
  }
  if (has(q, "fare", "price", "cost", "how much", "pay", "jod", "money")) {
    return { topic: "fare", text: `Every ride has a simulated fare of ${formatJod(SETTINGS.fareJod)}, and Shared rides cost the same ${formatJod(SETTINGS.sharedFareJod)} per rider. No real payment is taken.`, actions: [] };
  }
  if (has(q, "share", "shared", "ghost", "pool", "together")) {
    return { topic: "shared", text: `Choose Shared when booking and the server may add your ride to a compatible trip on the same cart, as long as it adds no more than ${SETTINGS.sharedMaxAddedDelayMinutes} minutes for riders already on board. A match is not guaranteed, and the fare stays the same.`, actions: [] };
  }
  if (has(q, "book", "request", "order", "get a ride", "ride to")) {
    const loc = findLocation(campus, question);
    const actions: CopilotAction[] = loc && loc.canStop && !activeRide ? [{ kind: "set-destination", locationId: loc.id, label: `Go to ${loc.name}` }] : [];
    return { topic: "book", text: `On Home, choose a pickup and a destination, pick Solo or Shared, then tap "Request a ride". Operations assigns a cart and you can follow it live.${activeRide ? " You already have an active ride." : ""}`, actions };
  }
  const loc = findLocation(campus, question);
  if (loc) {
    const near = neighbours(campus, loc.id);
    const actions: CopilotAction[] = loc.canStop && !activeRide
      ? [{ kind: "set-pickup", locationId: loc.id, label: "Set as pickup" }, { kind: "set-destination", locationId: loc.id, label: "Set as destination" }]
      : [{ kind: "link", to: "/student/map", label: "Open the map" }];
    return { topic: "place", text: `${loc.name} is a ${LOCATION_TYPE_LABEL[loc.type].toLowerCase()} on ${campus.name}.${loc.canStop ? " Carts can stop there." : " Carts don't stop there."}${near.length ? ` It connects directly to ${near.join(", ")}.` : ""}`, actions };
  }
  return { topic: "unknown", text: "I can't help with that. I can answer about campus stops, booking, fares and free rides, Tap-In, shared rides, your ride and the carts.", actions: [] };
}
