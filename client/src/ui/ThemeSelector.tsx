import { useId } from "react";
import { setThemePref, useThemePref, type ThemePref } from "./theme";

const OPTIONS: { value: ThemePref; label: string; icon: JSXIcon }[] = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: AutoIcon },
];
type JSXIcon = () => ReturnType<typeof SunIcon>;

/**
 * Light / Dark / System appearance, as an accessible radio group (arrow keys move between options).
 * Purely visual: it never changes the screen, mode, persona or any ride data.
 */
export function ThemeSelector({ compact = false }: { compact?: boolean }) {
  const pref = useThemePref();
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className={`text-[13px] font-semibold text-muted ${compact ? "px-2" : ""}`}>Appearance</span>
      <div role="radiogroup" aria-labelledby={labelId} className="grid grid-cols-3 gap-1 rounded-full bg-surface p-1 ring-1 ring-line">
        {OPTIONS.map((o) => {
          const on = pref === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onClick={() => setThemePref(o.value)}
              onKeyDown={(e) => {
                const i = OPTIONS.findIndex((x) => x.value === pref);
                const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                if (!step) return;
                e.preventDefault();
                const next = OPTIONS[(i + step + OPTIONS.length) % OPTIONS.length]!;
                setThemePref(next.value);
                (e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[OPTIONS.indexOf(next)])?.focus();
              }}
              className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full px-2 text-[13px] font-semibold transition-colors duration-150 ${on ? "bg-card text-ink shadow-float" : "text-muted hover:text-ink"}`}
            >
              <o.icon />
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SunIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
}
function MoonIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>;
}
function AutoIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>;
}
