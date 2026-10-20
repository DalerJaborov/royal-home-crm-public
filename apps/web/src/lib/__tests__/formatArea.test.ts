import { describe, expect, it } from "vitest";
import { formatArea } from "../format";

describe("property area presentation", () => {
  it("removes binary precision tails without changing the source value", () => {
    const area = 94.59999999999999;
    expect(formatArea(area)).toBe("94,6");
    expect(area).toBe(94.59999999999999);
  });
  it("preserves useful precision and does not add decimal zeroes", () => {
    expect(formatArea("109")).toBe("109");
    expect(formatArea("79.25")).toBe("79,25");
    expect(formatArea(0)).toBe("0");
  });
  it.each([null, undefined, "", "bad", -1, Infinity, NaN])("does not invent a valid area for %s", (value) => {
    expect(formatArea(value)).toBe("—");
  });
});
