import { useSyncExternalStore } from "react";

/**
 * Appearance: Light, Dark or System (follows the device). Stored on this device only. The inline script
 * in index.html applies the same rule before first paint; this module keeps it in sync afterwards.
 * Changing the appearance only switches the data-theme attribute on <html>: no route, persona, ride or
 * other application state is touched.
 */
export type ThemePref = "light" | "dark" | "system";
const KEY = "jeeny-inside:theme";
const listeners = new Set<() => void>();

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

function systemDark(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(pref: ThemePref): void {
  if (typeof document === "undefined") return;
  const dark = pref === "dark" || (pref === "system" && systemDark());
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}

export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* storage blocked: the choice still applies for this visit */
  }
  current = pref;
  applyTheme(pref);
  listeners.forEach((l) => l());
}

let current: ThemePref = typeof window === "undefined" ? "system" : readPref();

// While "System" is chosen, follow the device when it switches scheme, whichever screen is open.
if (typeof window !== "undefined" && window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if (current === "system") applyTheme("system");
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The saved preference (Light, Dark or System). */
export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, () => current, () => "system" as ThemePref);
}
