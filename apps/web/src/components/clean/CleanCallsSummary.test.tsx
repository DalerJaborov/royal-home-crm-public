import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { CleanCallsSummary, CallsInsightsDisclosure } from "./CleanCallsSummary";
function buttons(node: ReactNode): ReactElement<{ children?: ReactNode; onClick?: () => void }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!node || typeof node !== "object") return [];
  const element = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
  return [...(element.type === "button" ? [element] : []), ...buttons(element.props.children)];
}
describe("clean calls journal summary", () => {
  it("keeps daily counters and monthly quality distinct, including real zeroes", () => {
    const html = renderToStaticMarkup(<CleanCallsSummary today={{ incoming: 0, outgoing: 12, missed: 3 }} averageScore={72} onSlice={() => {}} />);
    expect(html).toContain("Сегодня · Душанбе");
    expect(html).toContain("Средний балл · 30 дней");
    for (const value of [0, 12, 3, 72]) expect(html).toContain(`>${value}</span>`);
  });
  it("does not turn unavailable counters into zeroes", () => {
    const html = renderToStaticMarkup(<CleanCallsSummary onSlice={() => {}} />);
    expect(html.match(/>—<\/span>/g)).toHaveLength(4);
  });
  it("uses existing slice callbacks for every metric and the quality warning", () => {
    const onSlice = vi.fn();
    buttons(CleanCallsSummary({ onSlice, agreedNextStep: 30 })).forEach((button) => button.props.onClick?.());
    expect(onSlice.mock.calls.map(([slice]) => slice)).toEqual(["incoming", "outgoing", "missed", "problems", "problems"]);
  });
  it("labels the no-callback count as page-local and keeps its action", () => {
    const onSlice = vi.fn();
    const tree = CleanCallsSummary({ onSlice, unreturnedOnPage: 2 });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("на текущей странице входящих: 2");
    buttons(tree).at(-1)?.props.onClick?.();
    expect(onSlice).toHaveBeenCalledWith("missed");
  });
  it("keeps complete analysis available and only collapses it for clean desktop", () => {
    const clean = renderToStaticMarkup(<CallsInsightsDisclosure clean><p>Рекомендации и возражения</p></CallsInsightsDisclosure>);
    expect(clean).toContain("<details");
    expect(clean).toContain("Рекомендации и возражения");
    const legacy = renderToStaticMarkup(<CallsInsightsDisclosure clean={false}><p>Рекомендации и возражения</p></CallsInsightsDisclosure>);
    expect(legacy).toBe("<p>Рекомендации и возражения</p>");
  });
});
