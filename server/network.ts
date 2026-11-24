import { networkInterfaces } from "node:os";

/** IPv4 addresses phones on the same hotspot / Wi-Fi can use to reach this laptop. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}

/**
 * Phase 4 Tap-In: check the configured public host (--public-host= or PUBLIC_HOST) that NFC tags and
 * QR codes will contain. A bare hostname or IPv4 address only: no scheme, port, path or spaces.
 * Nothing here picks a host by itself; with no value there is no tap base URL.
 */
export function parsePublicHost(value: string | undefined): { ok: true; host: string | null } | { ok: false; message: string } {
  if (value === undefined || value.trim() === "") return { ok: true, host: null };
  const host = value.trim();
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    if (ipv4.slice(1).every((n) => Number(n) <= 255)) return { ok: true, host };
    return { ok: false, message: `"${host}" is not a valid IPv4 address` };
  }
  const label = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
  if (host.length <= 253 && host.split(".").every((l) => label.test(l)) && !/^[\d.]+$/.test(host)) return { ok: true, host };
  return { ok: false, message: `"${host}" is not a bare hostname or IPv4 address (no http://, port or path)` };
}

/** The base URL every Tap-In link starts with: http://<host>:<port>. Plain HTTP, as the demo runs. */
export function tapBaseUrlFor(host: string | null, port: number): string | null {
  return host === null ? null : `http://${host}:${port}`;
}
