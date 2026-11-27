import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { LiveStatus } from "./LiveStatus";
import { useStudent } from "./studentContext";

/** Shared frame for the Student secondary screens: heading, optional back link, live status. */
export function StudentPage({ title, intro, back, children, id }: { title: string; intro?: ReactNode; back?: { to: string; label: string }; children: ReactNode; id: string }) {
  const { realtime } = useStudent();
  return (
    <section className="flex flex-col gap-5 px-4 pb-6 pt-4" aria-labelledby={id}>
      <div>
        {back && (
          <Link to={back.to} className="mb-1 inline-flex min-h-11 items-center text-sm font-semibold text-brand-strong">← {back.label}</Link>
        )}
        <div className="flex items-center justify-between gap-3">
          <h1 id={id} className="text-[26px] font-extrabold leading-tight tracking-tight">{title}</h1>
          <LiveStatus status={realtime.status} />
        </div>
        {intro && <p className="mt-1 text-[14px] text-muted">{intro}</p>}
      </div>
      {children}
    </section>
  );
}

/** A tappable row card used by Quick Actions and Profile. `disabled` rows explain why instead of linking. */
export function ActionRow({ to, title, text, icon, tag, disabled }: { to?: string; title: string; text: string; icon: ReactNode; tag?: ReactNode; disabled?: boolean }) {
  const body = (
    <>
      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${disabled ? "bg-surface text-muted" : "bg-brand-tint text-brand-strong"}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className={`text-[16px] font-bold ${disabled ? "text-ink-2" : "text-ink"}`}>{title}</span>
          {tag}
        </span>
        <span className="mt-0.5 block text-[13px] leading-snug text-muted">{text}</span>
      </span>
      {!disabled && <span className="text-muted" aria-hidden="true">›</span>}
    </>
  );
  const cls = "flex min-h-16 w-full items-center gap-3 rounded-card bg-card px-4 py-3 text-left ring-1 ring-line";
  if (disabled || !to) return <div className={cls} aria-disabled={disabled ? true : undefined}>{body}</div>;
  return <Link to={to} className={`${cls} transition-colors duration-150 hover:bg-surface`}>{body}</Link>;
}
