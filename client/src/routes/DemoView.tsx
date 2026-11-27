import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PERSONAS } from "../../../shared/personas";
import { BrandLockup } from "../ui/Brand";
import { ThemeSelector } from "../ui/ThemeSelector";

const PHONE_W = 390;
const PHONE_H = 844;
const PHONES = [
  { key: "student", title: "Student", path: "/student", role: "student" as const, initial: "stu-lina" },
  { key: "driver", title: "Driver", path: "/driver", role: "driver" as const, initial: "drv-yazan" },
  { key: "ops", title: "Operations", path: "/ops", role: "operator" as const, initial: "ops-hadi" },
];

/**
 * The three-phone demo: the real Student, Driver and Operations apps side by side, each in its own frame
 * with its own persona (?as=), all talking to the same server, database and live updates. Nothing here is
 * a mockup: every phone is the actual app at that URL.
 */
export function DemoView() {
  const [scale, setScale] = useState(1);
  const [who, setWho] = useState<Record<string, string>>(() => Object.fromEntries(PHONES.map((p) => [p.key, p.initial])));
  useEffect(() => {
    // Side by side on a computer; on a narrow screen the phones stack, each as wide as the screen allows.
    const fit = () => {
      const w = window.innerWidth;
      const sideBySide = w >= 900;
      setScale(sideBySide
        ? Math.min(1, (window.innerHeight - 200) / PHONE_H, (w - 64) / (PHONES.length * PHONE_W + (PHONES.length - 1) * 32))
        : Math.min(1, (w - 52) / PHONE_W));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  return (
    <div className="min-h-full bg-canvas px-4 pb-6 pt-4">
      <header className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3 pb-4">
        <div className="flex items-center gap-4">
          <BrandLockup size={32} />
          <div className="leading-tight">
            <h1 className="text-[20px] font-extrabold">Live demo</h1>
            <p className="text-[13px] text-muted">Student, Driver and Operations on one server: every action updates all three.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-full max-w-[17rem]"><ThemeSelector /></div>
          <Link to="/" className="inline-flex min-h-11 items-center rounded-full bg-card px-4 text-sm font-semibold text-ink ring-1 ring-line hover:bg-surface">All roles</Link>
        </div>
      </header>
      <ol className="mx-auto flex max-w-[1400px] flex-wrap items-start justify-center gap-8" aria-label="Demo phones">
        {PHONES.map((p, i) => {
          const id = who[p.key]!;
          const src = `${p.path}?as=${encodeURIComponent(id)}`;
          return (
            <li key={p.key} className="flex flex-col items-center gap-2">
              <div className="flex w-full flex-wrap items-center justify-between gap-2" style={{ maxWidth: Math.max(PHONE_W * scale + 20, 0) }}>
                <span className="text-[15px] font-bold"><span className="mr-1.5 inline-grid h-6 w-6 place-items-center rounded-full bg-brand text-[13px] text-white">{i + 1}</span>{p.title}</span>
                <span className="flex items-center gap-2">
                  <label className="sr-only" htmlFor={`demo-${p.key}`}>{p.title} persona</label>
                  <select id={`demo-${p.key}`} value={id} onChange={(e) => setWho({ ...who, [p.key]: e.target.value })} className="h-9 rounded-full bg-card px-3 text-[13px] font-semibold ring-1 ring-line">
                    {PERSONAS.filter((x) => x.role === p.role).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                  <a href={src} target="_blank" rel="noreferrer" className="text-[13px] font-semibold text-brand-strong underline-offset-2 hover:underline">Open</a>
                </span>
              </div>
              <div className="overflow-hidden rounded-[2.4rem] bg-ink p-2.5 shadow-pop" style={{ width: PHONE_W * scale + 20, height: PHONE_H * scale + 20 }}>
                <div className="overflow-hidden rounded-[1.9rem] bg-page" style={{ width: PHONE_W * scale, height: PHONE_H * scale }}>
                  <iframe
                    key={src}
                    title={`${p.title} app`}
                    src={src}
                    data-testid={`demo-frame-${p.key}`}
                    style={{ width: PHONE_W, height: PHONE_H, transform: `scale(${scale})`, transformOrigin: "0 0", border: 0, display: "block" }}
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mx-auto mt-4 max-w-3xl text-center text-[13px] text-muted">
        Book as the Student, dispatch it in Operations, then run the trip as the Driver. Operations can start simulated movement so the cart drives its route on every phone. Cart positions are simulated, not GPS.
      </p>
    </div>
  );
}
