import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CleanDealsApprovalRows, CleanDealsGuide, CleanDealsHeader, CleanDealsSummary } from "./CleanDealsOverview";

describe("clean deals overview", () => {
  it("keeps creation and filters gated by the supplied real capabilities", () => {
    const readonly = renderToStaticMarkup(<CleanDealsHeader teamWide onCreate={null} onFilter={null} />);
    expect(readonly).not.toContain("<button");
    expect(readonly).toContain("Сделки всей команды");
    const allowed = renderToStaticMarkup(<CleanDealsHeader teamWide filterName="Мадина" onCreate={() => {}} onFilter={() => {}} />);
    expect(allowed).toContain("Агент: Мадина");
    expect(allowed).toContain("Новая сделка");
    expect(allowed).toContain("Фильтры");
    expect((allowed.match(/<button[^>]*>/g) ?? []).filter((button) => /\bbg-blue\b/.test(button))).toHaveLength(1);
  });

  it("hides finance amounts without finance view and keeps actual filter-scoped counts", () => {
    const props = { ready: true, activeCount: 7, approvalCount: 4, closedCount: 2, commissionTjs: 98765 };
    const hidden = renderToStaticMarkup(<CleanDealsSummary {...props} seesMoney={false} />);
    expect(hidden).not.toContain("Комиссия за месяц");
    expect(hidden).not.toMatch(/98.?765/);
    for (const value of [">7</p>", ">4</p>", ">2</p>"]) expect(hidden).toContain(value);
    expect(hidden).toContain("текущего фильтра");
    const visible = renderToStaticMarkup(<CleanDealsSummary {...props} seesMoney />);
    expect(visible).toContain("Комиссия за месяц");
  });

  it("distinguishes loading/failure from a genuine zero", () => {
    const props = { activeCount: 0, approvalCount: 0, closedCount: 0, commissionTjs: 0, seesMoney: false };
    const pending = renderToStaticMarkup(<CleanDealsSummary {...props} ready={false} />);
    expect(pending.match(/>—<\/p>/g)).toHaveLength(3);
    expect(pending).not.toContain(">0</p>");
    const ready = renderToStaticMarkup(<CleanDealsSummary {...props} ready />);
    expect(ready.match(/>0<\/p>/g)).toHaveLength(3);
  });

  it("preserves every approval row and action with a closed, labelled remainder", () => {
    const rows = [1, 2, 3, 4, 5].map((id) => <div key={id}><button>Одобрить {id}</button></div>);
    const html = renderToStaticMarkup(<CleanDealsApprovalRows enabled>{rows}</CleanDealsApprovalRows>);
    expect(html).toContain("Ещё 2 на согласовании");
    expect(html.match(/<button>/g)).toHaveLength(5);
    expect(html.indexOf("Одобрить 3")).toBeLessThan(html.indexOf("<details>"));
    expect(html.indexOf("Одобрить 4")).toBeGreaterThan(html.indexOf("<details>"));
    expect(html).not.toContain("<details open");
    const legacy = renderToStaticMarkup(<CleanDealsApprovalRows enabled={false}>{rows}</CleanDealsApprovalRows>);
    expect(legacy).not.toContain("<details");
    expect(legacy.match(/<button>/g)).toHaveLength(5);
  });

  it("does not tell read-only users to move or close deals", () => {
    const html = renderToStaticMarkup(<CleanDealsGuide canMove={false} />);
    expect(html).toContain("Документы доступны");
    expect(html).not.toContain("Перетащите");
    expect(html).not.toContain("отправить сделку на закрытие");
  });
});
