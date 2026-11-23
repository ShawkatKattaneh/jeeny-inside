/**
 * Named, approved settings from the Foundation Plan (Section 12).
 * Engine phases read these; nothing else should hard-code them.
 */
export const SETTINGS = {
  /** D8: simulated fare per ride, labelled "Simulated fare" wherever shown. */
  fareJod: 0.25,
  /** F1: shared (Ghost) rides charge the same simulated fare for now. */
  sharedFareJod: 0.25,
  /** D8 + F2: 5 completed paid rides earn the 6th free. */
  loyaltyPaidRidesForFree: 5,
  /** F3: carts keep at least this battery after finishing every stop on board. */
  batteryReservePercent: 15,
  /** F3: max extra minutes a shared ride may add for riders already on board. */
  sharedMaxAddedDelayMinutes: 4,
} as const;

/** The honest one-liner shown in About and on the persona picker. */
export const INDEPENDENCE_NOTE =
  "Jeeny INSIDE is an independent hackathon concept inspired by Jeeny. It is not an official Jeeny product.";
