import { Persona, type Role } from "../../../shared/schemas";

/**
 * Demo-view memory for the mode switcher, on this device only. For each mode it remembers the last demo
 * persona used and the last screen visited, so switching back returns to the same place. This is a
 * convenience for the demo, not a login: nothing here is checked by the server.
 */
const PERSONAS_KEY = "jeeny-inside:persona-by-role";
const PATH_KEY = "jeeny-inside:path-by-role";

function read(key: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function write(key: string, value: Record<string, unknown>): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked: switching still works, it just starts from the picker */
  }
}

export function rememberPersona(p: Persona): void {
  write(PERSONAS_KEY, { ...read(PERSONAS_KEY), [p.role]: p });
}

export function rememberedPersona(role: Role): Persona | null {
  const parsed = Persona.safeParse(read(PERSONAS_KEY)[role]);
  return parsed.success && parsed.data.role === role ? parsed.data : null;
}

export function rememberPath(role: Role, path: string): void {
  write(PATH_KEY, { ...read(PATH_KEY), [role]: path });
}

/** The last screen of a mode, only if it still belongs to that mode's own area. */
export function rememberedPath(role: Role, home: string): string {
  const p = read(PATH_KEY)[role];
  return typeof p === "string" && (p === home || p.startsWith(`${home}/`)) ? p : home;
}
