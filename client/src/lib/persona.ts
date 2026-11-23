import { Persona, type Role } from "../../../shared/schemas";

const KEY = "jeeny-inside:persona";

/** The chosen persona is remembered on this device only (no real login). */
export function loadPersona(): Persona | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = Persona.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function savePersona(p: Persona | null): void {
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify(p));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked (private mode): the app still works for this visit */
  }
}

export const ROLE_HOME: Record<Role, string> = {
  student: "/student",
  driver: "/driver",
  operator: "/ops",
};
