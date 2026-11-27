import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { Role } from "../../../shared/schemas";
import { ROLE_HOME, savePersona } from "../lib/persona";
import { rememberedPath, rememberedPersona } from "../routes/modeMemory";
import { ThemeSelector } from "./ThemeSelector";
import { CheckIcon, ChevronDownIcon, DriverIcon, OpsIcon, StudentIcon } from "./icons";

export const MODES: { role: Role; label: string; icon: () => ReactNode }[] = [
  { role: "student", label: "Student", icon: StudentIcon },
  { role: "driver", label: "Driver", icon: DriverIcon },
  { role: "operator", label: "Operations", icon: OpsIcon },
];

/**
 * The persistent "Switch demo view" control in the shared header. Opening it is one step and choosing a
 * mode is a second, so a stray tap never changes mode. On phones the choices open as a bottom sheet, from
 * 640px as a menu under the chip. Each mode returns to its last demo persona and screen on this device;
 * a mode with no remembered persona opens the persona picker at that mode's personas.
 * Demo personas are not accounts: there is no sign-in and no permission check behind this control.
 */
export function ModeSwitcher({ current }: { current: Role | null }) {
  const [open, setOpen] = useState(false);
  /** Phones (below 640px) get a modal bottom sheet; wider screens a non-modal menu under the chip. */
  const [sheet, setSheet] = useState(false);
  const navigate = useNavigate();
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const active = MODES.find((m) => m.role === current) ?? null;

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("[data-mode-item]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return close();
      // Modal sheet: Tab and Shift+Tab stay inside it.
      if (e.key === "Tab" && sheet && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>("button:not([disabled]):not([tabindex='-1'])")];
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    // Menu: when keyboard focus moves outside it (and outside the chip), it closes.
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as Node;
      if (!sheet && !panel.current?.contains(t) && !trigger.current?.contains(t)) close(false);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !trigger.current?.contains(t)) close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open, sheet]);

  function close(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }

  function choose(role: Role) {
    setOpen(false);
    if (role === current) return;
    const p = rememberedPersona(role);
    if (p) {
      savePersona(p);
      navigate(rememberedPath(role, ROLE_HOME[role]));
    } else {
      navigate(`/#choose-${role}`);
    }
  }

  function changePersona() {
    setOpen(false);
    savePersona(null);
    navigate(current ? `/#choose-${current}` : "/");
  }

  return (
    <div className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          setSheet(typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches);
          setOpen((o) => !o);
        }}
        className="inline-flex h-11 items-center gap-1.5 rounded-full bg-card pl-3 pr-2.5 text-[14px] font-semibold text-ink ring-1 ring-line transition-colors duration-150 hover:bg-surface"
        data-testid="mode-switcher"
      >
        {active ? <active.icon /> : <StudentIcon />}
        <span>{active ? active.label : "Demo view"}</span>
        <span className="sr-only">: switch role</span>
        <span className="text-muted"><ChevronDownIcon /></span>
      </button>

      {open && (
        <>
          <div className="anim-fade-in fixed inset-0 z-40 bg-black/40 sm:hidden" aria-hidden="true" />
          <div
            ref={panel}
            id={menuId}
            role="dialog"
            aria-label="Switch role"
            aria-modal={sheet ? true : undefined}
            className="anim-sheet-in fixed inset-x-0 bottom-0 z-50 mx-auto max-h-[90dvh] max-w-[430px] overflow-y-auto rounded-t-sheet bg-card px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-sheet sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:top-12 sm:mx-0 sm:w-72 sm:max-w-none sm:rounded-card sm:p-2 sm:shadow-pop sm:ring-1 sm:ring-line"
          >
            <div className="mx-auto mb-2 h-1 w-9 rounded-full bg-line sm:hidden" aria-hidden="true" />
            <p className="px-2 pb-1 text-[13px] font-semibold text-muted">Switch role</p>
            <ul className="flex flex-col">
              {MODES.map((m) => {
                const p = rememberedPersona(m.role);
                const selected = m.role === current;
                return (
                  <li key={m.role}>
                    <button
                      type="button"
                      data-mode-item
                      aria-current={selected ? "true" : undefined}
                      onClick={() => choose(m.role)}
                      className={`flex min-h-12 w-full items-center gap-3 rounded-tile px-2 py-2 text-left transition-colors duration-150 ${selected ? "bg-brand-tint" : "hover:bg-surface"}`}
                    >
                      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${selected ? "bg-card text-brand-strong" : "bg-surface text-ink"}`}><m.icon /></span>
                      <span className="min-w-0 flex-1">
                        <span className={`block text-[15px] ${selected ? "font-bold" : "font-semibold"}`}>{m.label}</span>
                        <span className="block truncate text-[13px] text-muted">{p ? p.name : "Choose who you are"}</span>
                      </span>
                      {selected && <span className="text-brand-strong"><CheckIcon /></span>}
                    </button>
                  </li>
                );
              })}
            </ul>
            {current && (
              <button type="button" data-mode-item onClick={changePersona} className="mt-1 flex min-h-11 w-full items-center rounded-tile px-2 text-left text-[14px] font-semibold text-ink-2 hover:bg-surface">
                Choose another person
              </button>
            )}
            <p className="px-2 pt-1 text-[13px] text-muted">No sign-in in this build: roles are for demonstration.</p>
            <div className="mt-2 border-t border-line px-1 pb-1 pt-3">
              <ThemeSelector compact />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
