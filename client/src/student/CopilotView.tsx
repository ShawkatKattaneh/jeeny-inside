import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { etaText, useRideEta } from "../lib/rideEta";
import { Badge } from "../ui/Badge";
import { answer, SUGGESTIONS, type CopilotAnswer } from "./copilot";
import { StudentPage } from "./StudentPage";
import { useStudent } from "./studentContext";

interface Turn { id: number; question: string; reply: CopilotAnswer }

/**
 * Campus Copilot: ask about stops, booking, fares, free rides, Tap-In, shared rides, your ride or the carts.
 * Answers come from the campus file, the live ride state and the approved rules (student/copilot.ts).
 */
export function CopilotView() {
  const ctx = useStudent();
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const ride = ctx.activeRide;
  const eta = useRideEta(ride?.cart ? ride.request.id : null, ctx.realtime.data?.revision ?? null, !!ride?.cart);
  const etaLine = eta ? (eta.pickupSeconds !== null ? (eta.pickupSeconds === 0 ? "Your cart is at the pickup." : `Estimated pickup in ${etaText(eta.pickupSeconds)}.`) : `Estimated arrival in ${etaText(eta.destinationSeconds)}.`) : null;

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [turns.length]);

  const ask = (q: string) => {
    const question = q.trim();
    if (!question) return;
    setTurns((t) => [...t, { id: t.length + 1, question, reply: answer(question, { campus: ctx.campus, rides: ctx.rides, activeRide: ride, data: ctx.realtime.data, etaText: etaLine }) }]);
    setInput("");
  };
  const submit = (e: FormEvent) => { e.preventDefault(); ask(input); };

  return (
    <StudentPage id="copilot-title" title="Campus Copilot" back={{ to: "/student/quick", label: "Quick actions" }} intro={<>Answers from campus data and your live ride. <Badge>Rule-based, no AI model</Badge></>}>
      <div className="flex flex-wrap gap-2" aria-label="Suggested questions">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" onClick={() => ask(s)} className="min-h-11 rounded-full bg-card px-3.5 text-[13px] font-semibold text-ink-2 ring-1 ring-line hover:bg-surface hover:text-ink">{s}</button>
        ))}
      </div>
      <ol className="flex flex-col gap-3" aria-live="polite" aria-label="Conversation" data-testid="copilot-log">
        {turns.length === 0 && <li className="rounded-card bg-surface px-4 py-3 text-[14px] text-muted">Ask a question or choose one above.</li>}
        {turns.map((t) => (
          <li key={t.id} className="flex flex-col gap-2">
            <p className="self-end rounded-card rounded-br-md bg-brand px-3.5 py-2 text-[15px] font-semibold text-white">{t.question}</p>
            <div className="self-start rounded-card rounded-bl-md bg-card px-3.5 py-2.5 text-[15px] text-ink ring-1 ring-line" data-testid="copilot-answer" data-topic={t.reply.topic}>
              {t.reply.text}
              {t.reply.actions.length > 0 && (
                <span className="mt-2 flex flex-wrap gap-2">
                  {t.reply.actions.map((a) => a.kind === "link" ? (
                    <Link key={a.label} to={a.to} className="inline-flex min-h-11 items-center rounded-full bg-brand-tint px-3.5 text-[13px] font-bold text-ink ring-1 ring-brand/30">{a.label}</Link>
                  ) : (
                    <button key={a.label} type="button" onClick={() => navigate("/student", { state: a.kind === "set-pickup" ? { pickupId: a.locationId } : { destinationId: a.locationId } })} className="min-h-11 rounded-full bg-brand-tint px-3.5 text-[13px] font-bold text-ink ring-1 ring-brand/30" data-testid="copilot-action">
                      {a.label}
                    </button>
                  ))}
                </span>
              )}
            </div>
          </li>
        ))}
        <div ref={endRef} />
      </ol>
      <form onSubmit={submit} className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.5rem)] flex gap-2 rounded-full bg-card p-1.5 shadow-pop ring-1 ring-line">
        <label htmlFor="copilot-input" className="sr-only">Ask Campus Copilot</label>
        <input id="copilot-input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about stops, fares, your ride…" autoComplete="off" className="min-h-11 min-w-0 flex-1 rounded-full bg-transparent px-3 text-[15px] text-ink placeholder:text-muted focus:outline-none" />
        <button type="submit" disabled={!input.trim()} className="min-h-11 rounded-full bg-brand px-4 text-sm font-bold text-white disabled:bg-surface disabled:text-muted">Ask</button>
      </form>
    </StudentPage>
  );
}
