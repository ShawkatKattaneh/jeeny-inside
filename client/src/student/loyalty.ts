import { SETTINGS } from "../../../shared/settings";
import type { StudentRide } from "../lib/studentRides";

/**
 * Loyalty progress, by the same rule the server applies when it creates a request (engine loyaltyProgress):
 * completed paid rides since the last completed free ride, in request order. The server decides whether a
 * ride is free (its freeLoyaltyRide flag); this only shows the student where they stand.
 */
export function loyaltyOf(rides: StudentRide[]): { paidSinceFree: number; needed: number; freeRideDue: boolean } {
  const needed = SETTINGS.loyaltyPaidRidesForFree;
  let paidSinceFree = 0;
  const done = rides.filter((r) => r.request.status === "completed").sort((a, b) => (a.request.id < b.request.id ? -1 : 1));
  for (const r of done) paidSinceFree = r.request.freeLoyaltyRide ? 0 : paidSinceFree + 1;
  return { paidSinceFree, needed, freeRideDue: paidSinceFree >= needed };
}

/** One sentence for the student's loyalty status. Never claims a free ride the server has not granted. */
export function loyaltyLine(rides: StudentRide[]): string {
  const l = loyaltyOf(rides);
  if (l.freeRideDue) return `You have ${l.paidSinceFree} completed paid rides: your next ride request is free.`;
  return `${l.paidSinceFree} of ${l.needed} completed paid rides towards a free ride.`;
}
