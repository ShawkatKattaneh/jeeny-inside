import { useState } from "react";
import type { CampusConfig } from "../../../shared/schemas";
import { copyText, fetchTapBaseUrl, qrModules, tapPoints, tapUrl, type CopyOutcome } from "../lib/tapIn";
import { useApi } from "../lib/useApi";
import { Card } from "../ui/Card";

/**
 * Phase 4 Tap Points: every supported pickup point (canStop) with its one Tap-In URL, for writing NFC
 * tags and printing QR codes. The URL starts with the server's configured public host
 * (--public-host= / PUBLIC_HOST, GET /api/about tapBaseUrl); without one, no URLs are shown, so the
 * page never guesses an address. The QR code and the NFC tag hold the identical URL.
 * `baseUrl` is for tests (undefined = load it from the server).
 */
export function TapPointsPanel({ campus, baseUrl: injected }: { campus: CampusConfig; baseUrl?: string | null }) {
  const fetched = useApi(injected !== undefined ? () => Promise.resolve(injected) : () => fetchTapBaseUrl());
  const loaded: typeof fetched = injected !== undefined ? { status: "ready", data: injected } : fetched;
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [copied, setCopied] = useState<{ id: string; outcome: CopyOutcome } | null>(null);
  async function copy(id: string, url: string) {
    const outcome = await copyText(url);
    setCopied({ id, outcome });
    // Manual fallback: select the URL so the person can copy it with the system menu or Ctrl/Cmd+C.
    if (outcome === "manual") {
      const field = document.getElementById(`tap-url-${id}`) as HTMLInputElement | null;
      field?.focus();
      field?.select();
    }
  }
  const points = tapPoints(campus);

  return (
    <Card id="ops-tap-points" className="scroll-mt-4 flex flex-col gap-3 p-4" role="region" aria-labelledby="tap-points-title" data-testid="tap-points">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="tap-points-title" className="text-base font-extrabold">Tap Points · {campus.name}</h2>
        <span className="text-[13px] text-muted">{points.length} pickup points (campus id: {campus.id})</span>
      </div>
      <p className="text-[13px] text-muted">
        Write each URL to an NFC tag (a plain URL record) and print the same URL as a QR code next to it. Phones open it with their own NFC reader or camera.
        A Tap-In records a check-in only: it doesn't verify presence or identity, and it never boards anyone.
      </p>
      {loaded.status === "loading" && <p className="text-sm text-muted">Loading the configured host…</p>}
      {loaded.status === "error" && <p role="alert" className="text-sm text-danger">Couldn't load the configured host: {loaded.message}</p>}
      {loaded.status === "ready" && loaded.data === null && (
        <p role="status" className="rounded-tile bg-amber-50 px-3 py-2 text-sm text-ink" data-testid="tap-points-no-host">
          Tap URLs need a configured host. Restart the server with <code>npm start -- --public-host=&lt;the "On phones" address&gt;</code> (or set PUBLIC_HOST), then reload this page.
        </p>
      )}
      {loaded.status === "ready" && loaded.data !== null && (
        <>
          <p className="rounded-tile bg-amber-50 px-3 py-2 text-[13px] text-ink" data-testid="tap-points-host">
            Host in use: <b>{loaded.data}</b>. If the host changes, every NFC tag must be rewritten and every QR code reprinted.
          </p>
          <ul className="flex flex-col divide-y divide-line" data-testid="tap-points-list">
            {points.map((l) => {
              const url = tapUrl(loaded.data!, campus.id, l.id);
              return (
                <li key={l.id} className="flex flex-col gap-1 py-2" data-testid={`tap-point-${l.id}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold">{l.name} <span className="text-[13px] font-normal text-muted">({l.id})</span></span>
                    <span className="flex gap-2">
                      <button type="button" onClick={() => void copy(l.id, url)} className="min-h-11 rounded-full px-4 py-1 text-[13px] font-semibold ring-1 ring-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" data-testid="tap-point-copy">Copy URL</button>
                      <button type="button" onClick={() => setQrFor(qrFor === l.id ? null : l.id)} className="min-h-11 rounded-full px-4 py-1 text-[13px] font-semibold ring-1 ring-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" aria-expanded={qrFor === l.id}>
                        {qrFor === l.id ? "Hide QR" : "Show QR"}
                      </button>
                    </span>
                  </div>
                  <input id={`tap-url-${l.id}`} readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label={`Tap-In URL for ${l.name}`} className="w-full rounded-tile bg-surface px-2 py-1 font-mono text-[13px]" data-testid="tap-point-url" />
                  {copied?.id === l.id && <CopyFeedback outcome={copied.outcome} />}
                  {qrFor === l.id && <QrCode text={url} label={`QR code for ${l.name}: ${url}`} />}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
}

/** Result of a "Copy URL" press: success, or a visible manual-copy fallback (plain-HTTP LAN access). */
export function CopyFeedback({ outcome }: { outcome: CopyOutcome }) {
  return outcome === "copied" ? (
    <p role="status" className="text-[13px] font-semibold text-ink" data-testid="tap-copy-ok">Copied to the clipboard.</p>
  ) : (
    <p role="alert" className="rounded-tile bg-amber-50 px-2 py-1 text-[13px] text-ink" data-testid="tap-copy-manual">
      Couldn't copy automatically (the browser blocks it on this connection, for example plain HTTP). The URL above is selected: copy it with Ctrl+C or Cmd+C, or press and hold it and choose Copy.
    </p>
  );
}

/** A QR code drawn as SVG squares from the encoded modules; the text is exactly the NFC URL. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const modules = qrModules(text);
  const n = modules.length;
  const quiet = 4;
  const size = n + quiet * 2;
  const cells: string[] = [];
  modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) cells.push(`M${x + quiet} ${y + quiet}h1v1h-1z`); }));
  return (
    <figure className="flex flex-col items-start gap-1">
      <svg viewBox={`0 0 ${size} ${size}`} width={192} height={192} role="img" aria-label={label} data-testid="tap-point-qr" data-qr-text={text} shapeRendering="crispEdges">
        <rect width={size} height={size} fill="#ffffff" />
        <path d={cells.join("")} fill="#000000" />
      </svg>
      <figcaption className="font-mono text-[13px] text-muted">{text}</figcaption>
    </figure>
  );
}
