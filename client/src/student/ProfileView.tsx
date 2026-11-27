import { useNavigate } from "react-router-dom";
import { savePersona } from "../lib/persona";
import { Badge } from "../ui/Badge";
import { Card } from "../ui/Card";
import { ThemeSelector } from "../ui/ThemeSelector";
import { GLYPHS } from "./QuickView";
import { ActionRow, StudentPage } from "./StudentPage";
import { useStudent } from "./studentContext";

const Glyph = ({ d }: { d: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

/** Profile: the demo persona (no account behind it), appearance, and links to rewards and support screens. */
export function ProfileView() {
  const { persona, campus } = useStudent();
  const navigate = useNavigate();
  return (
    <StudentPage id="profile-title" title="Profile">
      <Card className="flex items-center gap-4 p-4">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-brand-tint text-[22px] font-extrabold text-brand-strong" aria-hidden="true">{persona.name.slice(0, 1)}</span>
        <span className="min-w-0">
          <span className="block text-[20px] font-extrabold leading-tight">{persona.name}</span>
          <span className="block text-[14px] text-muted">{persona.subtitle}</span>
          <span className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-muted">{campus.name} <Badge>Student</Badge></span>
        </span>
      </Card>
      <p className="-mt-2 text-[13px] text-muted">No account or sign-in in this build: your role is saved on this device.</p>

      <Card className="p-4"><ThemeSelector /></Card>

      <div className="flex flex-col gap-2.5">
        <ActionRow to="/student/impact" icon={<Glyph d={GLYPHS.impact} />} title="Campus Impact and rewards" text="Your ride record and the 6th-ride-free rule." />
        <ActionRow to="/student/priority" icon={<Glyph d={GLYPHS.priority} />} title="Priority Mobility and emergency info" text="Accessible pickup and SOS: what this build can and cannot do." />
        <ActionRow to="/student/copilot" icon={<Glyph d={GLYPHS.copilot} />} title="Help via Campus Copilot" text="Ask about stops, Tap-In, fares and your ride." />
      </div>

      <button
        type="button"
        onClick={() => { savePersona(null); navigate("/#choose-student"); }}
        className="min-h-12 rounded-full bg-card px-4 text-[15px] font-semibold text-ink ring-1 ring-line transition-colors duration-150 hover:bg-surface"
      >
        Switch role
      </button>
      <p className="text-center text-[13px] text-muted">Jeeny INSIDE · independent hackathon prototype, not an official Jeeny product.</p>
    </StudentPage>
  );
}
