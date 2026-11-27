import { describe, expect, it } from "vitest";
import { parsePublicHost, parsePublicUrl, tapBaseUrlFor } from "./network";

describe("Tap-In base address configuration", () => {
  it("PUBLIC_URL (hosted, e.g. Replit) accepts an http(s) origin and drops a trailing slash", () => {
    expect(parsePublicUrl(undefined)).toEqual({ ok: true, url: null });
    expect(parsePublicUrl("  ")).toEqual({ ok: true, url: null });
    expect(parsePublicUrl("https://jeeny-inside.example.replit.app/")).toEqual({ ok: true, url: "https://jeeny-inside.example.replit.app" });
    expect(parsePublicUrl("http://192.168.43.12:3000")).toEqual({ ok: true, url: "http://192.168.43.12:3000" });
  });

  it("PUBLIC_URL refuses anything that is not a bare origin", () => {
    for (const bad of ["jeeny.example.com", "ftp://jeeny.example.com", "https://jeeny.example.com/demo", "https://jeeny.example.com/?a=1", "https://user:pw@jeeny.example.com", "https://"]) {
      expect(parsePublicUrl(bad).ok, bad).toBe(false);
    }
  });

  it("the local hotspot setup is unchanged: PUBLIC_HOST still gives http://<host>:<port>", () => {
    expect(parsePublicHost("192.168.43.12")).toEqual({ ok: true, host: "192.168.43.12" });
    expect(tapBaseUrlFor("192.168.43.12", 3000)).toBe("http://192.168.43.12:3000");
    expect(tapBaseUrlFor(null, 3000)).toBeNull();
  });
});
