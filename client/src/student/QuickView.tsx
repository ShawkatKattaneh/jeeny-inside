import { showTapInEntry, tapPath } from "../lib/tapIn";
import { Badge } from "../ui/Badge";
import { ActionRow, StudentPage } from "./StudentPage";
import { useStudent } from "./studentContext";
import { locationName } from "./format";

const Glyph = ({ d }: { d: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
export const GLYPHS = {
  tap: "M6 8.5a6 6 0 0 1 0 7M9.5 6a10 10 0 0 1 0 12M3 11v2M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5",
  pulse: "M3 12h4l2-6 4 12 2-6h6",
  impact: "M12 21s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.5-7 10-7 10z",
  priority: "M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3zM12 8v5M12 16v.5",
  copilot: "M4 5h16v11H8l-4 4V5zM8 10h8M8 13h5",
} as const;

/**
 * Quick Actions: the Student tools in one place. Each entry opens a working screen, or says plainly why it is
 * not available yet. Nothing here is a placeholder that pretends to work.
 */
export function QuickView() {
  const { campus, activeRide } = useStudent();
  const tapReady = activeRide ? showTapInEntry(activeRide) : false;
  return (
    <StudentPage id="quick-title" title="Quick actions" intro={`Campus mobility tools for ${campus.name}.`}>
      <div className="flex flex-col gap-2.5">
        <ActionRow
          to={tapReady && activeRide ? tapPath(campus.id, activeRide.request.pickupId) : undefined}
          disabled={!tapReady}
          icon={<Glyph d={GLYPHS.tap} />}
          title="NFC Tap-In"
          tag={<Badge tone="info">Check-in only</Badge>}
          text={tapReady && activeRide
            ? `Confirm you're at ${locationName(campus, activeRide.request.pickupId)}. It records your arrival; your driver still confirms boarding.`
            : "Available once a cart is assigned to your ride. You can also tap the NFC tag or scan the QR code at your pickup point."}
        />
        <ActionRow to="/student/pulse" icon={<Glyph d={GLYPHS.pulse} />} title="Campus Pulse" tag={<Badge tone="simulated">Simulated fleet</Badge>} text="Live carts, waiting requests and pickup activity from the demo server." />
        <ActionRow to="/student/impact" icon={<Glyph d={GLYPHS.impact} />} title="Campus Impact and rewards" text="Your completed rides and the 6th-ride-free rule." />
        <ActionRow to="/student/priority" icon={<Glyph d={GLYPHS.priority} />} title="Priority Mobility / SOS" text="What is and is not available for accessible pickup and emergencies." />
        <ActionRow to="/student/copilot" icon={<Glyph d={GLYPHS.copilot} />} title="Campus Copilot" tag={<Badge>Rule-based</Badge>} text="Ask about stops, fares, free rides, Tap-In, shared rides, your ride or the carts." />
      </div>
    </StudentPage>
  );
}
