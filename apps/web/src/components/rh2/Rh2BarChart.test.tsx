import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Rh2BarChart } from "./Rh2BarChart";

function render(values: number[]) {
  const html = renderToStaticMarkup(<Rh2BarChart ariaLabel="Прибыль" items={values.map((value, index) => ({ key: String(index), label: String(index), value, tip: String(value) }))} />);
  const attribute = (tag: string, name: string) => Number(tag.match(new RegExp(` ${name}="([^"]+)"`))?.[1]);
  const axis = html.match(/<line class="ax"[^>]+>/)?.[0] ?? "";
  const bars = [...html.matchAll(/<rect class="br(?: alt)?"[^>]+>/g)].map(([tag]) => ({ y: attribute(tag, "y"), height: attribute(tag, "height") }));
  return { html, zero: attribute(axis, "y1"), bars };
}

describe("financial bar chart", () => {
  it("renders a loss below zero instead of silently clipping it away", () => {
    const result = render([-5000]);
    expect(result.zero).toBe(20);
    expect(result.bars).toEqual([{ y: 20, height: 150 }]);
    expect(result.html).toContain("-5к");
  });
  it("keeps positive and negative values on opposite sides of one zero line", () => {
    const result = render([-5000, 10000]);
    expect(result.zero).toBe(120);
    expect(result.bars).toEqual([{ y: 120, height: 50 }, { y: 20, height: 100 }]);
  });
  it("preserves the original positive-only chart geometry", () => {
    const result = render([10000]);
    expect(result.zero).toBe(170);
    expect(result.bars).toEqual([{ y: 20, height: 150 }]);
  });
  it("does not invent activity or emit invalid coordinates for an empty history", () => {
    const result = render([0, 0]);
    expect(result.bars.every((bar) => bar.height === 0)).toBe(true);
    expect(result.html).not.toMatch(/NaN|Infinity/);
    expect(render([]).html).toBe("");
  });
});
