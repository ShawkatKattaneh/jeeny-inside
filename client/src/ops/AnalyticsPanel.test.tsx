/**
 * Phase 5 Prompt 2: the Operations dashboard's analytics card, rendered with react-dom/server from a
 * response computed by the real engine on a real Ghost Ride state. Checks that displayed values are the
 * API's values, that unavailable metrics are never shown as zero, and that loading, error and ready
 * states stay distinct.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalyticsResponse } from "../../../shared/analytics";
import { computeAnalytics } from "../../../engine/analytics";
import { dispatchRequest } from "../../../engine/dispatch";
import { createRequest, startTrip } from "../../../engine/rides";
import { advance } from "../../../engine/simulation";
import { tapIn } from "../../../engine/tapIn";
import { cartAt, lineCampus, ok, setup } from "../../../engine/testRideFixtures";
import { applyAnalyticsReply, createFetchAnalytics, type AnalyticsLoad } from "../lib/analyticsApi";
import { AnalyticsView, simSeconds } from "./AnalyticsPanel";

function dispatched(state: Parameters<typeof dispatchRequest>[0], id: string) {
  const r = dispatchRequest(state, id);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.state;
}

function sample(): AnalyticsResponse {
  let s = setup(lineCampus(), [cartAt("CART-01", "a"), cartAt("CART-02", "e"), cartAt("CART-03", "c", { status: "maintenance" })]);
  const lina = ok(createRequest(s, { studentId: "stu-lina", pickupId: "b", destinationId: "d", mode: "shared" }));
  s = dispatched(lina.state, lina.request.id);
  const omar = ok(createRequest(s, { studentId: "stu-omar", pickupId: "c", destinationId: "e", mode: "shared" }));
  s = dispatched(omar.state, omar.request.id);
  s = ok(startTrip(s, lina.request.id)).state;
  s = ok(advance(s, 10)).state;
  s = ok(tapIn(s, lina.request.id, { studentId: "stu-lina", campusId: "line", pointId: "b" })).state;
  s = ok(advance(s, 4)).state;
  return AnalyticsResponse.parse(JSON.parse(JSON.stringify(computeAnalytics(s, 6))));
}
const empty = (): AnalyticsResponse => AnalyticsResponse.parse(JSON.parse(JSON.stringify(computeAnalytics(setup(lineCampus(), [cartAt("CART-01", "a")]), 0))));

const render = (load: AnalyticsLoad) => renderToStaticMarkup(<AnalyticsView load={load} />);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
/** Text inside the element with this data-testid (first match). */
function byTestId(html: string, id: string): string {
  const m = new RegExp(`data-testid="${id}"[^>]*>([\\s\\S]*?)</(div|b|p|table|tr|span)>`).exec(html);
  if (!m) throw new Error(`no element ${id}`);
  return text(m[1]!).trim();
}

describe("analytics card states", () => {
  it("loading, error and ready are distinct", () => {
    const loading = render({ status: "loading" });
    expect(loading).toContain('data-testid="an-loading"');
    expect(loading).not.toContain("an-error");
    expect(loading).not.toContain("an-requests");

    const failed = render({ status: "error", message: "The server answered 500.", data: null });
    expect(failed).toContain('data-testid="an-error"');
    expect(text(failed)).toContain("Could not load analytics: The server answered 500.");
    expect(failed).not.toContain("an-requests");

    const stale = render({ status: "error", message: "Could not reach the server.", data: sample() });
    expect(text(stale)).toContain("Showing the last result (revision 6), which may be out of date.");
    expect(stale).toContain('data-testid="an-requests"');

    const ready = render({ status: "ready", data: sample() });
    expect(ready).not.toContain("an-loading");
    expect(ready).not.toContain("an-error");
    expect(byTestId(ready, "an-revision")).toBe("Computed from revision 6 of the saved ride state.");
  });

  it("an empty database shows zero counts (true for complete history) and 'no measurements', not invented durations", () => {
    const html = render({ status: "ready", data: empty() });
    expect(byTestId(html, "an-requests")).toBe("0");
    expect(html).toContain('data-testid="an-tapin-none"');
    expect(html).toContain('data-testid="an-elapsed-none"');
    expect(html).toContain('data-testid="an-pickups-empty"');
    expect(html).toContain('data-testid="an-observations-empty"');
    expect(byTestId(html, "an-cancel-share")).toBe("0 of 0 (No data yet)");
  });
});

describe("displayed values are the API's values", () => {
  it("counts, durations, fleet and per-cart figures", () => {
    const a = sample();
    const html = render({ status: "ready", data: a });
    expect(byTestId(html, "an-requests")).toBe(String(a.demand.totalRequests));
    expect(byTestId(html, "an-trips")).toBe(String(a.demand.totalTrips));
    expect(byTestId(html, "an-shared-trips")).toBe(String(a.demand.tripsWithTwoOrMoreRiders));
    expect(byTestId(html, "an-riders")).toBe(`${a.demand.totalRiders} / ${a.demand.droppedOffRiders}`);
    expect(byTestId(html, "an-modes")).toBe("0 / 2");
    expect(byTestId(html, "an-tapin-mean")).toBe(simSeconds(a.waiting.requestToTapIn.meanSeconds!));
    expect(byTestId(html, "an-tapin-mean")).toBe("10 s");
    expect(byTestId(html, "an-tapin-n")).toBe("1");
    expect(byTestId(html, "an-elapsed-max")).toBe("14 s");
    expect(byTestId(html, "an-carts")).toBe("3");
    expect(byTestId(html, "an-out-of-service")).toBe("1");
    expect(byTestId(html, "an-occupancy")).toBe("0/12 (0%)");
    expect(text(html)).toContain("Maintenance 1");
    expect(html).toContain('data-testid="an-cart-CART-01"');
    expect(text(html)).not.toMatch(/stu-/);
  });

  it("pickups and destinations are separate tables counted in ride requests", () => {
    const html = render({ status: "ready", data: sample() });
    expect(html).toContain('data-testid="an-pickups-b"');
    expect(html).toContain('data-testid="an-pickups-c"');
    expect(html).toContain('data-testid="an-destinations-d"');
    expect(html).toContain('data-testid="an-destinations-e"');
    expect(html).not.toContain('data-testid="an-pickups-d"');
    expect(text(html)).toContain("counted in ride requests");
  });
});

describe("unavailable metrics", () => {
  it("are shown as 'Not available' with the server's reason, never as a number", () => {
    const a = sample();
    const html = render({ status: "ready", data: a });
    const unavailable = [
      ["an-calendar", a.coverage.calendarWindows.reason],
      ["an-trend", a.coverage.demandOverTime.reason],
      ["an-boarding", a.waiting.requestToBoarding.reason],
      ["an-eligible", a.fleet.dispatchEligibleCarts.reason],
      ["an-utilization", a.fleet.utilizationOverTime.reason],
      ["an-cancel-stage", a.cancellations.cancelledAtStage.reason],
    ] as const;
    for (const [id, reason] of unavailable) {
      const m = new RegExp(`data-testid="${id}" data-unavailable="true">([\\s\\S]*?)</div></div>`).exec(html);
      expect(m, id).not.toBeNull();
      const t = text(m![1]!);
      expect(t, id).toContain("Not available");
      expect(t, id).not.toMatch(/\b0\b/);
      expect(text(html)).toContain(reason.replace(/'/g, "'"));
    }
  });
});

describe("loading from the server", () => {
  const response = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

  it("validates the response with the shared schema and reports failures plainly", async () => {
    const a = sample();
    const urls: string[] = [];
    await expect(createFetchAnalytics("", (u) => { urls.push(String(u)); return response(200, a); })()).resolves.toEqual(a);
    expect(urls).toEqual(["/api/analytics"]);
    await expect(createFetchAnalytics("", () => response(500, { error: "Internal server error", code: "INTERNAL_ERROR" }))()).rejects.toThrow("The server answered 500.");
    await expect(createFetchAnalytics("", () => response(200, { ...a, demand: { ...a.demand, totalRequests: -1 } }))()).rejects.toThrow("did not have the expected shape");
    await expect(createFetchAnalytics("", () => Promise.reject(new TypeError("fetch failed")))()).rejects.toThrow("Could not reach the server.");
  });

  it("a slower, older reply never replaces a newer result; a failure keeps the last result", () => {
    const newer = { ...sample(), revision: 9 };
    const older = { ...sample(), revision: 6 };
    let s: AnalyticsLoad = { status: "loading" };
    s = applyAnalyticsReply(s, { ok: true, data: newer });
    s = applyAnalyticsReply(s, { ok: true, data: older });
    expect(s).toEqual({ status: "ready", data: newer });
    s = applyAnalyticsReply(s, { ok: false, message: "Could not reach the server." });
    expect(s).toEqual({ status: "error", message: "Could not reach the server.", data: newer });
    s = applyAnalyticsReply(s, { ok: true, data: { ...newer, revision: 10 } });
    expect(s.status).toBe("ready");
  });
});
