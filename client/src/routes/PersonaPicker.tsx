import { useNavigate } from "react-router-dom";
import type { Persona, Role } from "../../../shared/schemas";
import { INDEPENDENCE_NOTE } from "../../../shared/settings";
import { fetchPersonas } from "../lib/api";
import { useApi } from "../lib/useApi";
import { ROLE_HOME, savePersona } from "../lib/persona";
import { useCampus } from "../lib/campusContext";
import { BrandLockup } from "../ui/Brand";
import { Badge } from "../ui/Badge";
import { CampusMap } from "../ui/CampusMap";
import { ChevronIcon } from "../ui/icons";

const GROUPS: { role: Role; title: string; hint: string }[] = [
  { role: "student", title: "Students", hint: "Book and track campus rides" },
  { role: "driver", title: "Drivers", hint: "Run your cart's trips" },
  { role: "operator", title: "Operations", hint: "Watch the fleet and every decision" },
];

export function PersonaPicker() {
  const campus = useCampus();
  const personas = useApi(fetchPersonas);
  const navigate = useNavigate();

  function choose(p: Persona) {
    savePersona(p);
    navigate(ROLE_HOME[p.role]);
  }

  return (
    <div className="mx-auto flex min-h-full max-w-5xl flex-col gap-6 px-4 pb-8 pt-[max(1.25rem,env(safe-area-inset-top))] md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] md:gap-10 md:pt-10">
      <section className="flex flex-col gap-5">
        <BrandLockup size={36} />
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Choose a demo persona</h1>
          <p className="mt-1 text-sm text-muted">No login for the prototype. Your choice is remembered on this device.</p>
        </div>

        {personas.status === "loading" && <p className="text-sm text-muted">Loading personas…</p>}
        {personas.status === "error" && <p className="text-sm text-danger">Could not load personas: {personas.message}</p>}
        {personas.status === "ready" &&
          GROUPS.map((g) => (
            <div key={g.role}>
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-sm font-bold">{g.title}</h2>
                <span className="text-xs text-muted">{g.hint}</span>
              </div>
              <ul className="flex flex-col gap-2">
                {personas.data
                  .filter((p) => p.role === g.role)
                  .map((p) => (
                    <li key={p.id}>
                      <button
                        onClick={() => choose(p)}
                        className="flex w-full items-center gap-3 rounded-tile bg-surface px-4 py-3 text-left transition active:bg-brand-tint"
                      >
                        <span className="grid h-10 w-10 place-items-center rounded-full bg-white text-sm font-bold text-brand ring-1 ring-line">
                          {p.name.slice(0, 1)}
                        </span>
                        <span className="flex-1">
                          <span className="block font-bold">{p.name}</span>
                          <span className="block text-xs text-muted">{p.subtitle}</span>
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
          <h2 className="text-sm font-bold">{campus.name}</h2>
          {campus.fictional && <Badge>Fictional campus</Badge>}
          <Badge>Sample data</Badge>
        </div>
        <CampusMap campus={campus} />
        <p className="text-xs leading-relaxed text-muted">
          {INDEPENDENCE_NOTE} Campus, personas and ride history are sample data. Fares and the fleet will be simulated.
        </p>
      </section>
    </div>
  );
}
