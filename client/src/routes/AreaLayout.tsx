import { useEffect, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import type { Persona, Role } from "../../../shared/schemas";
import { loadPersona } from "../lib/persona";
import { BrandLockup } from "../ui/Brand";
import { ModeSwitcher } from "../ui/ModeSwitcher";
import { rememberPath, rememberPersona } from "./modeMemory";

const ROLE_NAME: Record<Role, string> = { student: "Student", driver: "Driver", operator: "Operations" };

/** Width of the Student and Driver phone column. On wider screens it is centred on the canvas. */
export const PHONE_COLUMN = "max-w-[430px]";

/**
 * Shared frame for /student, /driver and /ops: one header (mode switcher, lockup, demo persona), then
 * each area's own layout. Wrong or missing persona goes back to the picker.
 * Student and Driver are mobile apps: on a computer they stay a phone-width column centred on the
 * canvas, never a desktop two-column layout. Operations is a desktop control centre up to 1440px.
 * Student and Driver screens set their own side padding so the map can run edge to edge.
 */
export function AreaLayout({ role, children }: { role: Role; wide?: boolean; children: (p: Persona) => ReactNode }) {
  const persona = loadPersona();
  const { pathname } = useLocation();
  const ok = !!persona && persona.role === role;
  const phone = role !== "operator";

  useEffect(() => {
    if (ok) {
      rememberPersona(persona);
      rememberPath(role, pathname);
    }
  }, [ok, persona?.id, role, pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ok) return <Navigate to="/" replace />;

  const header = (
    <header className="sticky top-0 z-30 border-b border-line bg-card pt-[env(safe-area-inset-top)]">
      <div className={`mx-auto flex h-16 items-center gap-3 px-4 ${phone ? "" : "max-w-[1440px] lg:px-6"}`}>
        <ModeSwitcher current={role} />
        <span className="shrink-0"><BrandLockup size={28} compact /></span>
        <span className="ml-auto min-w-0 flex-1 text-right leading-tight">
          <span className="block truncate text-[14px] font-bold text-ink">{persona.name}</span>
          {/* The role, so it never truncates; Operations adds the subtitle where there is room. */}
          <span className="block truncate text-[13px] text-muted" title={persona.subtitle}>
            {ROLE_NAME[role]}{phone ? null : <span className="hidden md:inline"> · {persona.subtitle}</span>}
          </span>
        </span>
      </div>
    </header>
  );

  if (phone) {
    return (
      <div className="min-h-full bg-canvas">
        <div className={`relative mx-auto flex min-h-dvh w-full ${PHONE_COLUMN} flex-col bg-page min-[431px]:border-x min-[431px]:border-line min-[431px]:shadow-pop`} data-testid="phone-column">
          {header}
          <main className="flex min-h-0 w-full flex-1 flex-col">{children(persona)}</main>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col bg-canvas">
      {header}
      <main className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-4 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4 lg:px-6">
        {children(persona)}
      </main>
    </div>
  );
}

/** Honest placeholder for what the next phases add, so nothing looks finished that is not. */
export function ComingNext({ phase, text }: { phase: string; text: string }) {
  return (
    <div className="rounded-tile border border-dashed border-line px-4 py-3 text-[13px] text-muted">
      <span className="font-semibold text-ink">{phase}:</span> {text}
    </div>
  );
}
