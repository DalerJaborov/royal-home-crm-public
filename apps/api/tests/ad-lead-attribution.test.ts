import { describe, expect, it } from "vitest";
import {
  attributeLeads,
  leadStatsOf,
  periodInstants,
  type AttributionAd,
  type LeadFact,
} from "../src/lib/ads/adLeadAttribution.js";
import { allocateCents } from "../src/lib/ads/adAllocation.js";

/**
 * РЕАЛЬНАЯ ЦЕНА КЛИЕНТА (волна 1 рекламы, 03.10.2026) — чистая логика, без базы.
 *
 * Инвариант, ради которого файл: клиенты и их воронка делятся между объектами
 * объявления ТОЙ ЖЕ allocateCents, что и деньги, — поэтому сумма по объектам равна
 * итогу объявления (клиентов, показов, сделок, комиссии и расхода), а цена клиента
 * объекта согласована с расходом объекта.
 */

const fact = (adExternalId: string, extra: Partial<LeadFact> = {}): LeadFact => ({
  adExternalId,
  pinnedPropertyId: null,
  showed: false,
  deals: 0,
  commissionCents: 0,
  dealLines: [],
  ...extra,
});

const four = (weights = [1, 1, 1, 1]) => weights.map((weight, i) => ({ propertyId: `p${i}`, weight }));
const sumOf = (m: Map<string, { leads: number }>) => Array.from(m.values()).reduce((a, c) => a + c.leads, 0);

describe("attributeLeads", () => {
  it("клиенты без объявления и с чужим объявлением нигде не считаются", () => {
    const ads: AttributionAd[] = [{ adId: "A", externalId: "ext-A", spendCents: 10_000, items: four() }];
    const result = attributeLeads(ads, [fact("ext-чужое"), fact("ext-другое", { showed: true })]);
    expect(result.byAd.get("A")!.total).toEqual({ leads: 0, showings: 0, deals: 0, commissionCents: 0 });
    // Расход при этом разложен по объектам: цена клиента будет null, а не «ноль».
    expect(sumOf(result.byProperty)).toBe(0);
  });

  it("объявление с 4 объектами: клиенты делятся по весам, а приколотый уходит своему объекту целиком", () => {
    const ads: AttributionAd[] = [{ adId: "A", externalId: "ext-A", spendCents: 100_00, items: four([4, 3, 2, 1]) }];
    const facts: LeadFact[] = [
      // Диалог бота связал клиента с p2: он, его показ, сделка и комиссия — p2 целиком.
      fact("ext-A", {
        pinnedPropertyId: "p2",
        showed: true,
        deals: 1,
        commissionCents: 50_00,
        dealLines: [{ propertyId: "p2", count: 1, commissionCents: 50_00 }],
      }),
      fact("ext-A", { showed: true }),
      fact("ext-A"),
      fact("ext-A"),
    ];
    const { byAd, byProperty } = attributeLeads(ads, facts);
    const ad = byAd.get("A")!;
    expect(ad.total).toEqual({ leads: 4, showings: 2, deals: 1, commissionCents: 50_00 });

    // Остальные трое делятся по весам 4/3/2/1 ДОЛЯМИ клиента (1,2 · 0,9 · 0,6 · 0,3);
    // приколотый добавляет p2 ещё одного целиком. Целыми «последние объекты» остались бы с нулём.
    expect(ad.byProperty.get("p0")!.leads).toBe(1.2);
    expect(ad.byProperty.get("p1")!.leads).toBe(0.9);
    expect(ad.byProperty.get("p2")!.leads).toBe(1.6);
    expect(ad.byProperty.get("p3")!.leads).toBe(0.3);
    // Сделка и комиссия — только p2 (объект сделки), ни цента соседям.
    expect(ad.byProperty.get("p2")!.deals).toBe(1);
    expect(ad.byProperty.get("p2")!.commissionCents).toBe(50_00);
    for (const id of ["p0", "p1", "p3"]) {
      expect(ad.byProperty.get(id)!.deals).toBe(0);
      expect(ad.byProperty.get(id)!.commissionCents).toBe(0);
    }

    // Клиенты и показы по объектам в сумме равны итогу объявления (с точностью до сотой).
    for (const key of ["leads", "showings"] as const) {
      const sum = Array.from(ad.byProperty.values()).reduce((a, c) => a + c[key], 0);
      expect(Math.round(sum * 100) / 100).toBe(ad.total[key]);
    }
    // Общий по объекту (поверх объявлений) = то же самое: объявление одно.
    expect(byProperty.get("p2")!.leads).toBe(1.6);
  });

  it("сделка по ДРУГОМУ объекту не попадает в окупаемость объекта объявления, а итог объявления её учитывает", () => {
    // Клиент пришёл с объявления про p0 и p1, но купил объект p9 (его в объявлении нет).
    const ads: AttributionAd[] = [
      { adId: "A", externalId: "ext-A", spendCents: 100_00, items: [{ propertyId: "p0", weight: 1 }, { propertyId: "p1", weight: 1 }] },
    ];
    const facts = [
      fact("ext-A", {
        showed: true,
        deals: 2,
        commissionCents: 300_00,
        dealLines: [
          { propertyId: "p9", count: 1, commissionCents: 200_00 },
          { propertyId: "p1", count: 1, commissionCents: 100_00 },
        ],
      }),
    ];
    const { byAd } = attributeLeads(ads, facts);
    const ad = byAd.get("A")!;
    // Итог объявления — всё, что принёс клиент объявления (как в adSpendReport.enrichRows).
    expect(ad.total).toMatchObject({ deals: 2, commissionCents: 300_00 });
    // Разбивка: p1 — только своя сделка; у p0 комиссии нет вовсе; сделка по p9 ни на ком из объявления.
    expect(ad.byProperty.get("p1")).toMatchObject({ deals: 1, commissionCents: 100_00 });
    expect(ad.byProperty.get("p0")).toMatchObject({ deals: 0, commissionCents: 0 });
    // Один клиент делится пополам: у каждого по 0,5 клиента (а не «один у p0, ноль у p1»).
    expect(ad.byProperty.get("p0")!.leads).toBe(0.5);
    expect(ad.byProperty.get("p1")!.leads).toBe(0.5);
  });

  it("дробные клиенты: последние объекты не остаются с «клиентов нет», цена клиента — по доле", () => {
    // 3 клиента на 4 равных объекта: по 0,75 клиента каждому (целыми у четвёртого было бы 0).
    const ads: AttributionAd[] = [{ adId: "A", externalId: "ext-A", spendCents: 120_00, items: four() }];
    const { byAd } = attributeLeads(ads, [fact("ext-A"), fact("ext-A"), fact("ext-A")]);
    const ad = byAd.get("A")!;
    for (const id of ["p0", "p1", "p2", "p3"]) expect(ad.byProperty.get(id)!.leads).toBe(0.75);
    expect(ad.total.leads).toBe(3);
    // Цена клиента объекта: доля расхода (30 с.) / 0,75 клиента = 40 с. — как цена по объявлению (120 / 3).
    const stats = leadStatsOf(30_00, ad.byProperty.get("p3")!, 0, { shares: true });
    expect(stats.leadsAreShares).toBe(true);
    expect(stats.costPerLeadTjs).toBe(40);
    // Итог объявления целыми и без флага долей.
    expect(leadStatsOf(120_00, ad.total, 0).leadsAreShares).toBeUndefined();
    expect(leadStatsOf(120_00, ad.total, 0).costPerLeadTjs).toBe(40);
  });

  it("расход объектов согласован с аллокацией денег: те же доли, та же сумма до цента", () => {
    const ads: AttributionAd[] = [{ adId: "A", externalId: "ext-A", spendCents: 3_506, items: four() }];
    const { byProperty } = attributeLeads(ads, [fact("ext-A"), fact("ext-A")]);
    const expected = allocateCents(3_506, four());
    for (const share of expected) expect(byProperty.get(share.propertyId)!.spendCents).toBe(share.cents);
    const total = Array.from(byProperty.values()).reduce((a, c) => a + c.spendCents, 0);
    expect(total).toBe(3_506);
  });

  it("сумма цены по объектам не расходится с объявлением: деньги и клиенты одной аллокацией", () => {
    // Равные веса, 10 клиентов, расход не делится на четыре: клиенты — доли по 2,5, расход — без потери цента.
    const ads: AttributionAd[] = [{ adId: "A", externalId: "ext-A", spendCents: 1_001, items: four() }];
    const facts = Array.from({ length: 10 }, () => fact("ext-A"));
    const { byAd, byProperty } = attributeLeads(ads, facts);
    expect(Math.round(sumOf(byAd.get("A")!.byProperty) * 100) / 100).toBe(10);
    const spend = Array.from(byProperty.values()).reduce((a, c) => a + c.spendCents, 0);
    expect(spend).toBe(1_001);
  });

  it("клиент, приколотый к объекту, которого нет в объявлении, делится по весам как все", () => {
    const ads: AttributionAd[] = [{ adId: "A", externalId: "ext-A", spendCents: 100, items: four() }];
    const { byAd } = attributeLeads(ads, [fact("ext-A", { pinnedPropertyId: "чужой-объект" })]);
    expect(Math.round(sumOf(byAd.get("A")!.byProperty) * 100) / 100).toBe(1);
    expect(byAd.get("A")!.byProperty.has("чужой-объект")).toBe(false);
  });

  it("объявление без объектов: клиенты в итоге объявления есть, по объектам — пусто", () => {
    const ads: AttributionAd[] = [{ adId: "A", externalId: "ext-A", spendCents: 500, items: [] }];
    const { byAd, byProperty } = attributeLeads(ads, [fact("ext-A", { showed: true })]);
    expect(byAd.get("A")!.total.leads).toBe(1);
    expect(byAd.get("A")!.byProperty.size).toBe(0);
    expect(byProperty.size).toBe(0);
  });

  it("один объект в двух объявлениях: клиенты и расход складываются", () => {
    const ads: AttributionAd[] = [
      { adId: "A", externalId: "ext-A", spendCents: 1_000, items: [{ propertyId: "p0", weight: 1 }] },
      { adId: "B", externalId: "ext-B", spendCents: 2_000, items: [{ propertyId: "p0", weight: 1 }] },
    ];
    const { byProperty } = attributeLeads(ads, [fact("ext-A"), fact("ext-B"), fact("ext-B")]);
    expect(byProperty.get("p0")).toMatchObject({ leads: 3, spendCents: 3_000 });
  });
});

describe("leadStatsOf", () => {
  const counts = { leads: 4, showings: 2, deals: 1, commissionCents: 600_00 };

  it("цена клиента, цена показа, цена обращения Meta и окупаемость", () => {
    const s = leadStatsOf(400_00, counts, 8);
    expect(s).toEqual({
      leads: 4,
      showings: 2,
      deals: 1,
      commissionTjs: 600,
      costPerLeadTjs: 100,
      costPerShowingTjs: 200,
      costPerLeadMeta: 50,
      // (600 − 400) / 400 = +50 %
      romi: 0.5,
    });
  });

  it("нулевой расход: цен нет (органика не стоит денег), окупаемости нет", () => {
    const s = leadStatsOf(0, counts, 8);
    expect(s.costPerLeadTjs).toBeNull();
    expect(s.costPerShowingTjs).toBeNull();
    expect(s.costPerLeadMeta).toBeNull();
    expect(s.romi).toBeNull();
    expect(s.leads).toBe(4);
  });

  it("нулевые клиенты при расходе: цена клиента null, а не ноль; обращения Meta при этом считаются", () => {
    const s = leadStatsOf(300_00, { leads: 0, showings: 0, deals: 0, commissionCents: 0 }, 3);
    expect(s.costPerLeadTjs).toBeNull();
    expect(s.costPerShowingTjs).toBeNull();
    expect(s.costPerLeadMeta).toBe(100);
    // Ничего не вернулось — −100 %.
    expect(s.romi).toBe(-1);
  });

  it("нет обращений Meta: цена обращения null", () => {
    expect(leadStatsOf(100_00, counts, 0).costPerLeadMeta).toBeNull();
  });
});

describe("periodInstants", () => {
  it("календарные дни периода превращаются в границы суток по Душанбе (UTC+5): [начало, начало следующего)", () => {
    const { start, end } = periodInstants(new Date("2026-10-01T00:00:00.000Z"), new Date("2026-10-03T00:00:00.000Z"));
    expect(start.toISOString()).toBe("2026-09-30T19:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-03T19:00:00.000Z");
  });
});
