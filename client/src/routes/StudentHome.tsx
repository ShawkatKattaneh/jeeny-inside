import { useCampus } from "../lib/campusContext";
import { CampusMap } from "../ui/CampusMap";
import { SearchIcon } from "../ui/icons";
import { AreaLayout, ComingNext } from "./AreaLayout";

export function StudentHome() {
  const campus = useCampus();
  return (
    <AreaLayout role="student">
      {(p) => (
        <>
          <h1 className="text-2xl font-extrabold tracking-tight">Hi {p.name}</h1>
          <div className="flex h-12 items-center gap-2 rounded-full bg-surface px-4 text-muted" aria-disabled="true">
            <SearchIcon />
            <span className="text-sm">Where to on campus, {p.name}?</span>
          </div>
          <CampusMap campus={campus} />
          <ComingNext phase="Phase 3" text="pick pickup and destination, see the simulated 0.25 JOD fare, request a cart and track it live." />
        </>
      )}
    </AreaLayout>
  );
}
