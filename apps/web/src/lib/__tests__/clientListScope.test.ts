import { describe, expect, it } from "vitest";
import { clientListScope } from "../clientListScope";

const normal = { allMine: false, other: false, searching: false, pending: false, noResponseYesterday: false };
describe("working client tab and historical drilldowns", () => {
  it("uses the working scope only for a normal tab", () => {
    expect(clientListScope(normal)).toBe("inWork");
  });
  it.each([
    { searching: true }, { other: true }, { status: "LOST" },
    { workStatus: "INACTIVE" }, { workStatus: "ACTIVE" }, { pending: true }, { noResponseYesterday: true },
  ])("preserves explicit drilldown %j", patch => {
    expect(clientListScope({ ...normal, ...patch })).toBeUndefined();
  });
  it("keeps all-mine including history even while searching", () => {
    expect(clientListScope({ ...normal, allMine: true, searching: true })).toBe("allMine");
  });
});
