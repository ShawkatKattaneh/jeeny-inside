import { Persona, type Role } from "../../../shared/schemas";
import { PERSONAS } from "../../../shared/personas";

const KEY = "jeeny-inside:persona";

/**
 * Per-frame persona (the three-phone demo view): a page opened with ?as=<persona id> keeps that persona for
 * its own frame only, in window.name (which survives reloads of that frame), so three frames on one device
 * can be Student, Driver and Operations at once. Without ?as, the device-wide choice below is used.
 */
const FRAME_PREFIX = "jeeny-inside-as:";
let frameOverride: Persona | null = null;
let frameMode = false;
if (typeof window !== "undefined") {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("as");
    const fromName = window.name.startsWith(FRAME_PREFIX) ? window.name.slice(FRAME_PREFIX.length) : null;
    const id = fromUrl ?? fromName;
    const found = id ? PERSONAS.find((p) => p.id === id) : undefined;
    if (found) {
      frameOverride = Persona.parse(found);
      frameMode = true;
      window.name = FRAME_PREFIX + found.id;
    }
  } catch {
    /* no window.name or URL access: device-wide persona only */
  }
}
/** True inside a demo frame (the persona belongs to this frame, not the device). */
export const inDemoFrame = () => frameMode;

/** The chosen persona is remembered on this device only (no real login). */
export function loadPersona(): Persona | null {
  if (frameMode) return frameOverride;
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
  if (frameMode) {
    frameOverride = p;
    try { window.name = p ? FRAME_PREFIX + p.id : ""; } catch { /* ignore */ }
    if (!p) frameMode = false;
    return;
  }
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
