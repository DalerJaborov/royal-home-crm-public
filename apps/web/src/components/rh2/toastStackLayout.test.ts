import { describe, expect, it } from "vitest";
import { toastStackOffsets } from "./toastStackLayout";

describe("toast viewport geometry", () => {
  it("keeps a long notice clear of an independently owned undo action", () => {
    const heights = [[112, 64], [76]];
    const offsets = toastStackOffsets(heights, true);
    const occupied = heights.flatMap((group, g) => group.map((height, i) => ({ bottom: offsets[g][i], top: offsets[g][i] + height })));
    for (let a = 0; a < occupied.length; a++) for (let b = a + 1; b < occupied.length; b++) {
      expect(occupied[a].bottom >= occupied[b].top + 8 || occupied[b].bottom >= occupied[a].top + 8).toBe(true);
    }
    expect(offsets[1][0]).toBe(0);
  });
  it("reflows remaining groups after undo leaves or text wraps on resize", () => {
    expect(toastStackOffsets([[80], []], true)).toEqual([[0], []]);
    const before = toastStackOffsets([[80], [44]], true);
    const after = toastStackOffsets([[80], [120]], true);
    expect(after[0][0] - before[0][0]).toBe(76);
    expect(after[1][0]).toBe(0);
  });
  it("keeps legacy groups independent, including the agent phone", () => {
    expect(toastStackOffsets([[80, 44], [120]], false)).toEqual([[52, 0], [0]]);
  });
  it("does not allocate phantom gaps for an empty lifecycle", () => {
    expect(toastStackOffsets([[], [44], []], true)).toEqual([[], [0], []]);
    expect(toastStackOffsets([], true)).toEqual([]);
  });
});
