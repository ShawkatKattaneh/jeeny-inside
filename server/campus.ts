import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CampusConfig } from "../shared/schemas.js";
import { checkCampus } from "../engine/campusValidation.js";

export const DEFAULT_CAMPUS_FILE = "campus/fictional-campus.json";

/**
 * Load and validate a campus config file. Swapping campuses = pointing CAMPUS_FILE at another file.
 * Fails loudly at startup with a readable message instead of serving a broken map.
 */
export function loadCampus(fileArg?: string): CampusConfig {
  const file = fileArg ?? process.env.CAMPUS_FILE ?? DEFAULT_CAMPUS_FILE;
  const fullPath = resolve(process.cwd(), file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(fullPath, "utf8"));
  } catch (err) {
    throw new Error(`Could not read campus file ${fullPath}: ${(err as Error).message}`);
  }
  const parsed = CampusConfig.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Campus file ${fullPath} is invalid:\n${issues}`);
  }
  // Graph and map checks: errors stop the server, warnings are printed for someone to review.
  const { errors, warnings } = checkCampus(parsed.data);
  if (errors.length) {
    throw new Error(`Campus file ${fullPath} fails connectivity checks:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
  for (const w of warnings) console.warn(`[campus] Warning (${file}): ${w}`);
  return parsed.data;
}
