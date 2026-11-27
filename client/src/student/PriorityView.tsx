import { Badge } from "../ui/Badge";
import { Card } from "../ui/Card";
import { StudentPage } from "./StudentPage";

/**
 * Priority Mobility / SOS. Neither is connected in this build: there is no eligibility check, no priority
 * dispatch and no emergency service. The screen says so instead of offering buttons that do nothing.
 */
export function PriorityView() {
  return (
    <StudentPage id="priority-title" title="Priority Mobility / SOS" back={{ to: "/student/quick", label: "Quick actions" }}>
      <Card className="flex flex-col gap-3 p-4" role="region" aria-labelledby="pm-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="pm-title" className="text-[19px] font-extrabold">Priority Mobility</h2>
          <Badge>Not available yet</Badge>
        </div>
        <p className="text-[14px] text-ink">Step-free, priority cart pickup for students with temporary or ongoing mobility needs.</p>
        <p className="rounded-tile bg-surface px-3 py-2 text-[13px] text-ink-2" data-testid="priority-unavailable">
          Not in this build: there is no eligibility check and no priority dispatch. Every booking is a standard request, and the server marks it as not priority.
        </p>
      </Card>
      <Card className="flex flex-col gap-3 p-4" role="region" aria-labelledby="sos-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="sos-title" className="text-[19px] font-extrabold">Emergency assistance (SOS)</h2>
          <Badge tone="danger">Not connected</Badge>
        </div>
        <p className="rounded-tile bg-danger-tint px-3 py-2 text-[14px] font-semibold text-ink" role="note" data-testid="sos-guidance">
          This demo is not connected to any emergency service. If you are in danger, contact campus security or your local emergency number directly.
        </p>
        <p className="text-[13px] text-muted">No alert is sent from this app, and no location is shared.</p>
      </Card>
    </StudentPage>
  );
}
