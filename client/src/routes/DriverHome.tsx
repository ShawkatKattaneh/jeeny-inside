import { useCampus } from "../lib/campusContext";
import { CampusMap } from "../ui/CampusMap";
import { Card } from "../ui/Card";
import { AreaLayout, ComingNext } from "./AreaLayout";

export function DriverHome() {
  const campus = useCampus();
  return (
    <AreaLayout role="driver">
      {(p) => (
        <>
          <Card className="flex items-center justify-between px-4 py-3">
            <div>
              <div className="text-xs text-muted">Your cart</div>
              <div className="text-lg font-extrabold">{p.cartId ?? "No cart"}</div>
            </div>
            <span className="rounded-full bg-surface px-3 py-1 text-xs font-semibold text-muted">Off shift</span>
          </Card>
          <CampusMap campus={campus} />
          <ComingNext phase="Phase 4" text="current trip, next stop, passenger list, Arrived / Boarded / Complete, and the cart's battery." />
        </>
      )}
    </AreaLayout>
  );
}
