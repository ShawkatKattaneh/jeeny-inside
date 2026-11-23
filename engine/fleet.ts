/**
 * Fleet state: an immutable, validated set of carts for one campus.
 * Pure functions: imports only from shared and the cart rules. No database, timers or network.
 *
 * Every update returns a NEW fleet and leaves the old one untouched, so an update is atomic by
 * construction: it either fully succeeds or nothing changes. Carts that were not updated are the
 * same frozen objects in both fleets.
 */
import { Cart, CartStatePatch, type CampusConfig } from "../shared/schemas.js";
import { transitionError } from "./cartRules.js";

export interface Fleet {
  readonly campusId: string;
  readonly carts: ReadonlyMap<string, Readonly<Cart>>;
  readonly locationIds: ReadonlySet<string>;
  readonly pathIds: ReadonlySet<string>;
}

export type FleetError =
  | { code: "UNKNOWN_CART"; cartId: string; message: string }
  | { code: "DUPLICATE_CART_ID"; cartId: string; message: string }
  | { code: "INVALID_CART"; cartId: string | null; message: string }
  | { code: "INVALID_UPDATE"; cartId: string; message: string }
  | { code: "UNKNOWN_LOCATION"; cartId: string; message: string }
  | { code: "INVALID_TRANSITION"; cartId: string; message: string };

const issuesText = (issues: { path: PropertyKey[]; message: string }[]) =>
  issues.map((i) => `${i.path.map(String).join(".") || "cart"}: ${i.message}`).join("; ");

function freeze(c: Cart): Readonly<Cart> {
  Object.freeze(c.position);
  return Object.freeze(c);
}

/** The cart's position must point at a location or path of this campus. Carts are never moved to make it fit. */
function positionError(fleet: Pick<Fleet, "campusId" | "locationIds" | "pathIds">, c: Cart): FleetError | null {
  const p = c.position;
  if (p.kind === "at" && !fleet.locationIds.has(p.locationId)) {
    return { code: "UNKNOWN_LOCATION", cartId: c.id, message: `${c.id} is at "${p.locationId}", which is not a location on campus "${fleet.campusId}"` };
  }
  if (p.kind === "on_path" && !fleet.pathIds.has(p.pathId)) {
    return { code: "UNKNOWN_LOCATION", cartId: c.id, message: `${c.id} is on path "${p.pathId}", which is not a path on campus "${fleet.campusId}"` };
  }
  return null;
}

/**
 * Build a fleet from cart data for the given campus. Reports every problem at once:
 * invalid carts, duplicate ids, and positions that do not exist on this campus.
 */
export function createFleet(
  campus: CampusConfig,
  carts: unknown[],
): { ok: true; fleet: Fleet } | { ok: false; errors: FleetError[] } {
  const base = {
    campusId: campus.id,
    locationIds: new Set(campus.locations.map((l) => l.id)),
    pathIds: new Set(campus.paths.map((p) => p.id)),
  };
  const errors: FleetError[] = [];
  const valid: Cart[] = [];
  const seen = new Set<string>();
  carts.forEach((raw, i) => {
    const parsed = Cart.safeParse(raw);
    if (!parsed.success) {
      const id = typeof (raw as { id?: unknown })?.id === "string" ? (raw as { id: string }).id : null;
      errors.push({ code: "INVALID_CART", cartId: id, message: `Cart ${i}${id ? ` (${id})` : ""} is invalid: ${issuesText(parsed.error.issues)}` });
      return;
    }
    const c = parsed.data;
    if (seen.has(c.id)) {
      errors.push({ code: "DUPLICATE_CART_ID", cartId: c.id, message: `Cart id "${c.id}" is used more than once` });
      return;
    }
    seen.add(c.id);
    const posErr = positionError(base, c);
    if (posErr) errors.push(posErr);
    else valid.push(c);
  });
  if (errors.length) return { ok: false, errors };
  valid.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { ok: true, fleet: Object.freeze({ ...base, carts: new Map(valid.map((c) => [c.id, freeze(c)])) }) };
}

export function getCart(fleet: Fleet, cartId: string): { ok: true; cart: Readonly<Cart> } | { ok: false; error: FleetError } {
  const cart = fleet.carts.get(cartId);
  return cart ? { ok: true, cart } : { ok: false, error: { code: "UNKNOWN_CART", cartId, message: `No cart with id "${cartId}" in this fleet` } };
}

/** All carts, sorted by id. */
export function listCarts(fleet: Fleet): Readonly<Cart>[] {
  return [...fleet.carts.values()];
}

/**
 * Apply a state update to one cart. The patch may only change operational fields
 * (status, position, batteryPercent, passengerCount, rangeKm, driverId). The result is checked
 * as a whole: valid fields, consistent status and passengers, an allowed status transition,
 * and a position on this campus. On any failure the original fleet is returned unchanged.
 */
export function updateCart(
  fleet: Fleet,
  cartId: string,
  patch: unknown,
): { ok: true; fleet: Fleet; cart: Readonly<Cart> } | { ok: false; error: FleetError } {
  const found = getCart(fleet, cartId);
  if (!found.ok) return found;
  const current = found.cart;

  const p = CartStatePatch.safeParse(patch);
  if (!p.success) {
    const extra = p.error.issues.flatMap((i) => (i.code === "unrecognized_keys" ? i.keys : []));
    const message = extra.length
      ? `${cartId}: ${extra.map((k) => `"${k}"`).join(", ")} cannot be changed by a state update (only status, position, batteryPercent, passengerCount, rangeKm, driverId)`
      : `${cartId}: ${issuesText(p.error.issues)}`;
    return { ok: false, error: { code: "INVALID_UPDATE", cartId, message } };
  }

  const next = Cart.safeParse({ ...current, position: { ...current.position }, ...p.data });
  if (!next.success) return { ok: false, error: { code: "INVALID_UPDATE", cartId, message: `${cartId}: ${issuesText(next.error.issues)}` } };

  const tErr = transitionError(current.status, next.data.status);
  if (tErr) return { ok: false, error: { code: "INVALID_TRANSITION", cartId, message: `${cartId}: ${tErr}` } };

  const posErr = positionError(fleet, next.data);
  if (posErr) return { ok: false, error: posErr };

  const cart = freeze(next.data);
  const carts = new Map(fleet.carts);
  carts.set(cartId, cart);
  return { ok: true, fleet: Object.freeze({ ...fleet, carts }), cart };
}
