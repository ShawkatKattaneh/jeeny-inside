import type { CampusConfig, Cart, Persona } from "../../../shared/schemas";
import { formatSimTime, locationName } from "../student/format";

/** Simulation clock (seconds since the server started), never wall-clock time. */
export const simClock = (clockSeconds: number) => formatSimTime(clockSeconds * 1000);

/** A cart's server position in campus words. */
export function cartWhere(cart: Cart, campus: CampusConfig): string {
  const pos = cart.position;
  if (pos.kind === "at") return locationName(campus, pos.locationId);
  const path = campus.paths.find((p) => p.id === pos.pathId);
  return path ? `Between ${locationName(campus, path.from)} and ${locationName(campus, path.to)}` : "On a campus path";
}

/** The cart's driverId from the fleet, plus the seeded persona's name only for an exact id match. */
export function driverText(cart: Cart, personas: Persona[]): string {
  if (!cart.driverId) return "No driver";
  const p = personas.find((x) => x.id === cart.driverId && x.role === "driver");
  return p ? `${p.name} (${cart.driverId})` : cart.driverId;
}

export function studentText(studentId: string, personas: Persona[]): string {
  const p = personas.find((x) => x.id === studentId && x.role === "student");
  return p ? `${p.name} (${studentId})` : studentId;
}
