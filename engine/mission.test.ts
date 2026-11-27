import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CampusConfig } from "../shared/schemas";
import { missionDemand, runMission, MISSION_DEFAULTS } from "./mission";

const campus = CampusConfig.parse(JSON.parse(readFileSync("campus/fictional-campus.json", "utf8")));
const carts = JSON.parse(readFileSync("campus/fleets/wadi-cedar.json", "utf8")).carts;

describe("Mission Mode", () => {
  it("is deterministic: the same seed gives the same demand and the same numbers", () => {
    expect(runMission(campus, carts, { seed: 11 })).toEqual(runMission(campus, carts, { seed: 11 }));
    expect(missionDemand(campus, { ...MISSION_DEFAULTS, seed: 11 })).not.toEqual(missionDemand(campus, { ...MISSION_DEFAULTS, seed: 12 }));
  });

  it("both policies serve the same demand; only pooling differs", () => {
    const r = runMission(campus, carts, { seed: 7, requests: 12 });
    expect(r.demand).toHaveLength(12);
    const [on, off] = r.results;
    expect(on.policy).toBe("pooling_on");
    expect(off.sharedTrips).toBe(0);
    expect(off.trips).toBe(off.completed); // no pooling: one trip per completed ride
    for (const p of r.results) {
      expect(p.completed + p.unserved).toBe(12);
      expect(p.ridersOnSharedTrips).toBeGreaterThanOrEqual(p.sharedTrips * 2);
    }
    // Pickups come from the campus's pickup points, and pickup and destination always differ.
    const pickups = new Set(campus.locations.filter((l) => l.type === "pickup").map((l) => l.id));
    for (const d of r.demand) { expect(pickups.has(d.pickupId)).toBe(true); expect(d.destinationId).not.toBe(d.pickupId); }
  });
});
