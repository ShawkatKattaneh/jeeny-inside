/**
 * Cart rules: status transitions, the battery reserve, and the basic eligibility check.
 * Pure functions: imports only from shared. Nothing here changes a cart, picks a cart or touches rides.
 */
import { Cart, type CartStatus } from "../shared/schemas.js";
import { SETTINGS } from "../shared/settings.js";

/** States in which a cart is in service. Charging, offline and maintenance carts are never available. */
export const IN_SERVICE_STATUSES: readonly CartStatus[] = ["idle", "occupied"];

/**
 * Status transitions. The rule is short on purpose:
 * - A cart becomes occupied only from idle (charging, offline or maintenance carts take no passengers).
 * - An occupied cart can only become idle, once everyone is off. Going to charging, offline or
 *   maintenance with passengers on board would strand them.
 * - Idle, charging, offline and maintenance can change freely between each other: these are operator
 *   decisions that carry no passengers.
 * - Staying in the same status is always allowed (for example updating battery only).
 */
export function canTransition(from: CartStatus, to: CartStatus): boolean {
  if (from === to) return true;
  if (to === "occupied") return from === "idle";
  if (from === "occupied") return to === "idle";
  return true;
}

/** Why a transition is refused, in plain words, or null when it is allowed. */
export function transitionError(from: CartStatus, to: CartStatus): string | null {
  if (canTransition(from, to)) return null;
  if (to === "occupied") return `A cart can take passengers only when it is idle, not "${from}"`;
  return `An occupied cart must drop off its passengers (become idle) before going "${to}"`;
}

function checkReserve(reservePercent: number): void {
  if (!Number.isFinite(reservePercent) || reservePercent < 0 || reservePercent > 100) {
    throw new RangeError(`Battery reserve must be between 0 and 100%, got ${reservePercent}`);
  }
}

/**
 * The approved battery rule (F3): a cart is battery-eligible when its battery is at or above the
 * reserve. Exactly 15% passes with the default reserve.
 */
export function meetsBatteryReserve(batteryPercent: number, reservePercent: number = SETTINGS.batteryReservePercent): boolean {
  checkReserve(reservePercent);
  if (!Number.isFinite(batteryPercent) || batteryPercent < 0 || batteryPercent > 100) {
    throw new RangeError(`Battery must be between 0 and 100%, got ${batteryPercent}`);
  }
  return batteryPercent >= reservePercent;
}

export type IneligibleReason =
  | "INVALID_CART_DATA"
  | "NOT_IN_SERVICE"
  | "BATTERY_BELOW_RESERVE"
  | "NOT_ENOUGH_FREE_SEATS";

export interface Eligibility {
  eligible: boolean;
  /** Every reason that applies, in a fixed order. Empty when eligible. */
  reasons: IneligibleReason[];
  /** Plain-language explanation for each reason, same order. */
  messages: string[];
}

export interface EligibilityOptions {
  /** Seats the check asks for. Defaults to 1. */
  seatsNeeded?: number;
  /** Battery reserve in percent. Defaults to the approved 15%. */
  reservePercent?: number;
}

/**
 * Basic rule check: does this cart meet the operating rules for taking `seatsNeeded` more passengers?
 * In service (idle or occupied), battery at or above the reserve, and enough free seats.
 * An occupied cart with free seats passes this check; whether a ride may actually share it is for
 * later rules to decide. This check never assigns or selects a cart.
 */
export function checkCartEligibility(cart: unknown, options: EligibilityOptions = {}): Eligibility {
  const seatsNeeded = options.seatsNeeded ?? 1;
  const reservePercent = options.reservePercent ?? SETTINGS.batteryReservePercent;
  if (!Number.isInteger(seatsNeeded) || seatsNeeded < 1) throw new RangeError(`Seats needed must be a whole number of at least 1, got ${seatsNeeded}`);
  checkReserve(reservePercent);

  const parsed = Cart.safeParse(cart);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "cart"}: ${i.message}`).join("; ");
    return { eligible: false, reasons: ["INVALID_CART_DATA"], messages: [`Cart data is invalid: ${detail}`] };
  }
  const c = parsed.data;
  const reasons: IneligibleReason[] = [];
  const messages: string[] = [];
  if (!IN_SERVICE_STATUSES.includes(c.status)) {
    reasons.push("NOT_IN_SERVICE");
    messages.push(`${c.id} is ${c.status} and not available`);
  }
  if (!meetsBatteryReserve(c.batteryPercent, reservePercent)) {
    reasons.push("BATTERY_BELOW_RESERVE");
    messages.push(`${c.id} battery ${c.batteryPercent}% is below the ${reservePercent}% reserve`);
  }
  const free = c.seats - c.passengerCount;
  if (free < seatsNeeded) {
    reasons.push("NOT_ENOUGH_FREE_SEATS");
    messages.push(`${c.id} has ${free} free seat${free === 1 ? "" : "s"}, ${seatsNeeded} needed`);
  }
  return { eligible: reasons.length === 0, reasons, messages };
}
