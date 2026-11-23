import type { ReactNode } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import type { Persona, Role } from "../../../shared/schemas";
import { loadPersona, savePersona } from "../lib/persona";
import { BrandLockup } from "../ui/Brand";
import { IconButton } from "../ui/Button";
import { BackIcon } from "../ui/icons";

/**
 * Shared frame for /student, /driver and /ops. Each area keeps its own layout inside it,
 * so the three still feel like separate products. Wrong or missing persona goes back to the picker.
 */
export function AreaLayout({ role, wide = false, children }: { role: Role; wide?: boolean; children: (p: Persona) => ReactNode }) {
  const persona = loadPersona();
  const navigate = useNavigate();
  if (!persona || persona.role !== role) return <Navigate to="/" replace />;

  function switchPersona() {
    savePersona(null);
    navigate("/");
  }

  return (
    <div className={`mx-auto flex min-h-full flex-col px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] ${wide ? "max-w-6xl" : "max-w-md"}`}>
      <header className="flex items-center gap-3 py-2">
        <IconButton label="Switch persona" onClick={switchPersona}>
          <BackIcon />
        </IconButton>
        <BrandLockup size={28} />
        <span className="ml-auto truncate text-right text-xs text-muted">
          <span className="block font-semibold text-ink">{persona.name}</span>
          {persona.subtitle}
        </span>
      </header>
      <main className="flex flex-1 flex-col gap-4 pt-2">{children(persona)}</main>
    </div>
  );
}

/** Honest placeholder for what the next phases add, so nothing looks finished that is not. */
export function ComingNext({ phase, text }: { phase: string; text: string }) {
  return (
    <div className="rounded-tile border border-dashed border-line px-4 py-3 text-xs text-muted">
      <span className="font-semibold text-ink">{phase}:</span> {text}
    </div>
  );
}
