import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CampusConfig } from "../../../shared/schemas";
import { answer, findLocation } from "./copilot";

const campus = CampusConfig.parse(JSON.parse(readFileSync("campus/fictional-campus.json", "utf8")));
const ctx = { campus, rides: [], activeRide: null, data: null };

describe("Campus Copilot (rule-based)", () => {
  it("finds campus places by name or a distinctive word, and offers real booking actions for stops", () => {
    expect(findLocation(campus, "where is the library?")?.id).toBe("library");
    expect(findLocation(campus, "take me to engineering")?.id).toBe("engineering");
    const a = answer("Where is the library?", ctx);
    expect(a.topic).toBe("place");
    expect(a.text).toContain("Central Library");
    expect(a.actions.map((x) => x.kind)).toEqual(["set-pickup", "set-destination"]);
  });

  it("answers fares, free rides, Tap-In and shared rides from the approved rules", () => {
    expect(answer("how much is a ride", ctx).text).toContain("0.25 JOD");
    expect(answer("how do free rides work?", ctx).text).toMatch(/After 5 completed paid rides.*0 of 5 completed paid rides/);
    expect(answer("does NFC tap in board me?", ctx).text).toMatch(/check-in only: it does not board you/);
    expect(answer("what is a ghost ride", ctx).text).toContain("4 minutes");
  });

  it("is honest about what it cannot do", () => {
    expect(answer("call an ambulance", ctx).topic).toBe("sos");
    expect(answer("call an ambulance", ctx).text).toMatch(/not connected to any emergency service/);
    expect(answer("I need a wheelchair pickup", ctx).text).toMatch(/not available in this build/);
    expect(answer("what's the weather tomorrow", ctx)).toMatchObject({ topic: "unknown", actions: [] });
    expect(answer("where is my cart", ctx).text).toMatch(/no active ride/);
    expect(answer("how many carts are free", ctx).text).toMatch(/don't have the live state yet/);
  });
});
