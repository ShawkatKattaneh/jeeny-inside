import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FleetConfig, type CampusConfig } from "../shared/schemas.js";
import { createFleet, type Fleet } from "../engine/fleet.js";

/** Default fleet file for a campus: one file per campus id, next to the campus files. */
export const defaultFleetFile = (campusId: string) => `campus/fleets/${campusId}.json`;

/**
 * Load and validate the starting fleet for an already loaded campus. Like loadCampus, it fails
 * loudly with a readable message: a missing file, a fleet for another campus, or any invalid cart
 * stops the server. It never falls back to an empty or made-up fleet.
 */
export function loadFleet(campus: CampusConfig, fileArg?: string): Fleet {
  const file = fileArg ?? process.env.FLEET_FILE ?? defaultFleetFile(campus.id);
  const fullPath = resolve(process.cwd(), file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(fullPath, "utf8"));
  } catch (err) {
    throw new Error(`Could not read fleet file ${fullPath}: ${(err as Error).message}`);
  }
  const parsed = FleetConfig.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(file)"}: ${i.message}`).join("\n");
    throw new Error(`Fleet file ${fullPath} is invalid:\n${issues}`);
  }
  if (parsed.data.campusId !== campus.id) {
    throw new Error(`Fleet file ${fullPath} is for campus "${parsed.data.campusId}", but the loaded campus is "${campus.id}"`);
  }
  const fleet = createFleet(campus, parsed.data.carts);
  if (!fleet.ok) {
    throw new Error(`Fleet file ${fullPath} has invalid carts:\n${fleet.errors.map((e) => `  - ${e.message}`).join("\n")}`);
  }
  return fleet.fleet;
}
