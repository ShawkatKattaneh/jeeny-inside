import { useEffect, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { Persona, Role } from "../../../shared/schemas";
import { INDEPENDENCE_NOTE } from "../../../shared/settings";
import { fetchPersonas } from "../lib/api";
import { useApi } from "../lib/useApi";
import { ROLE_HOME, savePersona } from "../lib/persona";
import { useCampus } from "../lib/campusContext";
import { BrandLockup } from "../ui/Brand";
import { Badge } from "../ui/Badge";
import { CampusMap } from "../ui/CampusMap";
import { ThemeSelector } from "../ui/ThemeSelector";
import { ChevronIcon, DriverIcon, OpsIcon, StudentIcon } from "../ui/icons";
import { rememberedPath, rememberPersona } from "./modeMemory";

const GROUPS: { role: Role; title: string; hint: string; icon: () => ReactNode }[] = [
  { role: "student", title: "Students", hint: "Book and track campus rides", icon: StudentIcon },
  { role: "driver", title: "Drivers", hint: "Run your cart's trips", icon: DriverIcon },
  { role: "operator", title: "Operations", hint: "Watch the fleet and every decision", icon: OpsIcon },
];

export function PersonaPicker() {
  const campus = useCampus();
  const personas = useApi(fetchPersonas);
  const navigate = useNavigate();
  const { hash } = useLocation();
  const ready = personas.status === "ready";

  // The mode switcher links here as /#choose-<role> when that mode has no remembered persona.
  useEffect(() => {
    if (!ready || !hash.startsWith("#choose-")) return;
    const el = document.getElementById(hash.slice(1));
    el?.scrollIntoView({ block: "start" });
    el?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }, [ready, hash]);

  function choose(p: Persona) {
    savePersona(p);
    rememberPersona(p);
    navigate(rememberedPath(p.role, ROLE_HOME[p.role]));
  }

  return (
    <div className="min-h-full bg-canvas">
    <div className="mx-auto flex min-h-full max-w-5xl flex-col gap-6 px-4 pb-8 pt-[max(1.25rem,env(safe-area-inset-top))] md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] md:gap-10 md:pt-10">
      <section className="flex flex-col gap-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <BrandLockup size={36} />
          <div className="w-full max-w-[17rem]"><ThemeSelector /></div>
        </div>
        <div>
          <h1 className="text-[28px] font-extrabold leading-tight tracking-tight">Choose your role</h1>
          <p className="mt-1 text-[15px] text-muted">No sign-in needed: pick who you are. Your choice is remembered on this device, and you can switch role at any time from the header.</p>
        </div>

        <Link to="/demo" className="flex items-center gap-3 rounded-card bg-hero px-4 py-3.5 text-hero-fg shadow-float ring-1 ring-hero-ring transition-opacity duration-150 hover:opacity-95" data-testid="open-demo">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand text-white" aria-hidden="true">3</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[16px] font-bold">Live demo: all three roles side by side</span>
            <span className="block text-[13px] text-hero-muted">Student, Driver and Operations on one screen, connected to the same server.</span>
          </span>
          <span aria-hidden="true">›</span>
        </Link>

        {personas.status === "loading" && <p className="text-sm text-muted" role="status">Loading personas…</p>}
        {personas.status === "error" && <p className="rounded-tile bg-danger-tint px-3 py-2 text-sm text-ink" role="alert">Could not load personas: {personas.message}</p>}
        {ready &&
          GROUPS.map((g) => (
            <div key={g.role} id={`choose-${g.role}`} className="scroll-mt-4">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-ink-2"><g.icon /></span>
                <h2 className="text-[17px] font-bold">{g.title}</h2>
                <span className="ml-auto text-[13px] text-muted">{g.hint}</span>
              </div>
              <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-card bg-card shadow-float ring-1 ring-line">
                {personas.data
                  .filter((p) => p.role === g.role)
                  .map((p) => (
                    <li key={p.id}>
                      <button
                        onClick={() => choose(p)}
                        className="flex min-h-14 w-full items-center gap-3 bg-card px-4 py-3 text-left transition-colors duration-150 hover:bg-surface active:bg-brand-tint"
                      >
                        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface text-[15px] font-bold text-brand-strong">
                          {p.name.slice(0, 1)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-bold">{p.name}</span>
                          <span className="block truncate text-[13px] text-muted">{p.subtitle}</span>
                        </span>
                        <span className="text-muted"><ChevronIcon /></span>
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-bold">{campus.name}</h2>
          {campus.fictional && <Badge>Fictional campus</Badge>}
          <Badge>Sample data</Badge>
        </div>
        <div className="rounded-card bg-card p-2 shadow-float ring-1 ring-line"><CampusMap campus={campus} /></div>
        <p className="text-[13px] leading-relaxed text-muted">
          {INDEPENDENCE_NOTE} Campus, personas and ride history are sample data. Fares and the fleet will be simulated.
        </p>
      </section>
    </div>
    </div>
  );
}
