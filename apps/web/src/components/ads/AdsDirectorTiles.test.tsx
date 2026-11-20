import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AdsDirectorTiles } from "./AdsDirectorTiles";
import type { AdsBoard } from "../../hooks/useAds";

/**
 * Главные цифры «Рекламы» для директора (20.11.2026): цена заявки, цена сделки,
 * окупаемость и сравнение с прошлым периодом — только из ответа доски, без выдумок.
 */
const totals = (over: Partial<AdsBoard["totals"]> = {}, stats: Partial<NonNullable<AdsBoard["totals"]["leadStats"]>> | null = {}): AdsBoard["totals"] => ({
  periodTjs: 1000, lifetimeTjs: 5000, running: 1, stalled: 0, stopped: 0, total: 3, linked: 2, foreign: 0, brandTjs: 0, brandCount: 0, pending: 0, conversations: 40,
  leadStats: stats === null ? null : {
    leads: 20, showings: 6, deals: 2, commissionTjs: 3000, costPerLeadTjs: 50, costPerShowingTjs: 166.67, costPerLeadMeta: 25, romi: 2, ...stats,
  } as NonNullable<AdsBoard["totals"]["leadStats"]>,
  ...over,
});
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ");
const render = (props: Partial<Parameters<typeof AdsDirectorTiles>[0]> = {}) => renderToStaticMarkup(
  <AdsDirectorTiles totals={totals()} previous={undefined} previousLabel="в прошлые 30 дней" pacing={undefined} syncedAt={null} periodLabel="последние 30 дней" seesMoney {...props} />,
);

describe("главные цифры рекламы", () => {
  it("цена заявки, цена сделки и окупаемость — из ответа доски", () => {
    const t = text(render());
    expect(t).toContain("Цена заявки 50,00 с.");
    expect(t).toContain("20 заявок с рекламы");
    expect(t).toContain("Цена сделки 500,00 с.");
    expect(t).toContain("2 сделки с рекламных заявок");
    expect(t).toContain("Окупаемость +200 %");
    expect(t).toContain("комиссия 3 000,00 с. на 1 000,00 с. рекламы");
  });
  it("три разных «нет»: нет данных, нет расхода, нет заявок/сделок — словами, а не нулями", () => {
    const noDeals = text(render({ totals: totals({}, { deals: 0, commissionTjs: 0, romi: -1 }) }));
    expect(noDeals).toContain("сделок пока нет");
    expect(noDeals).toContain("Окупаемость -100 %");
    expect(render({ totals: totals({}, { deals: 0, commissionTjs: 0, romi: -1 }) })).toContain('data-tone="crit"');
    const none = text(render({ totals: totals({}, null) }));
    expect(none).toContain("Цена заявки нет данных");
    expect(none).toContain("заявки с рекламы не посчитались");
    // нет расхода: цен нет — «—» и «расхода не было», даже если сделки есть
    const free = text(render({ totals: totals({ periodTjs: 0 }, { costPerLeadTjs: null, romi: null }) }));
    expect(free).toContain("Цена заявки —");
    expect(free).toContain("Цена сделки —");
    expect(free).toContain("расхода не было");
    expect(free).not.toContain("0,00 с. за");
    // расход есть, заявок нет
    const noLeads = text(render({ totals: totals({}, { leads: 0, deals: 0, costPerLeadTjs: null, commissionTjs: 0, romi: -1 }) }));
    expect(noLeads).toContain("Цена заявки нет заявок");
  });
  it("без права на финансы плитки окупаемости нет (сервер и так отдаёт комиссию пустой)", () => {
    const t = text(render({ seesMoney: false, totals: totals({}, { commissionTjs: null, romi: null }) }));
    expect(t).not.toContain("Окупаемость");
    expect(t).not.toContain("комиссия");
    expect(t).toContain("Цена заявки 50,00 с.");
    // и с правом, но без комиссии в ответе — тоже нет
    expect(text(render({ totals: totals({}, { commissionTjs: null, romi: null }) }))).not.toContain("Окупаемость");
  });
  it("сравнение с прошлым периодом: расход и цена заявки, рост цены — плохо", () => {
    const html = render({ previous: totals({ periodTjs: 800 }, { costPerLeadTjs: 40 }) });
    // расход вырос на 25 %, цена заявки — тоже на 25 %: оба чипа «плохо»
    expect((html.match(/25 %/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("в прошлые 30 дней");
    // без прошлого периода чипов нет
    expect(render()).not.toMatch(/chip delta/);
  });
});
