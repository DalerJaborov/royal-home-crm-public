import { describe, expect, it } from "vitest";
import { nextSomonAgent } from "../src/lib/somonLeads/roundRobin.js";
const a = (id:string, active=true, linked=true, enabled=true) => ({id,active,linked,enabled});
describe("Somon agent queue", () => {
  it("distributes in order and wraps", () => {
    const queue = [a("noza"),a("surayyo"),a("umed"),a("maruf")];
    expect(nextSomonAgent(queue, null)).toBe("noza");
    expect(nextSomonAgent(queue, "noza")).toBe("surayyo");
    expect(nextSomonAgent(queue, "maruf")).toBe("noza");
  });
  it("skips inactive, unlinked and disabled agents", () => {
    const queue=[a("a"),a("b",false),a("c",true,false),a("d",true,true,false),a("e")];
    expect(nextSomonAgent(queue, "a")).toBe("e");
    expect(nextSomonAgent([a("a",true,false)],null)).toBeNull();
  });
  it("includes a newly enabled agent without changing the function", () => {
    expect(nextSomonAgent([a("a"),a("new")],"a")).toBe("new");
  });
});
