import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketDynamicsView, dynamicsTiles } from "./MarketDynamics";
import type { MarketDynamicsData } from "../types";

const base: MarketDynamicsData = {
  status: "ok",
  windowDays: 90,
  minSample: 8,
  minHistoryDays: 3,
  basis: "Сино, 3-комнатные",
  goneCount: 24,
  activeCount: 31,
  speed: { sampleSize: 24, medianDays: 21 },
  price: {
    goneSampleSize: 24, activeSampleSize: 31, goneMedianPerSqm: 10000, activeMedianPerSqm: 11400, diffPercent: -12,
    cutSampleSize: 24, cutSharePercent: 38, avgCutPercent: 6,
  },
  sellers: { sampleSize: 55, realtorPercent: 62, ownerPercent: 38, realtorListings: 34 },
  recentlyGone: Array.from({ length: 5 }, (_, i) => ({
    sourceUrl: `https://somon.tj/adv/g${i}`, source: "somon.tj", title: `3-комн. квартира ${i}`, priceTjs: 800000 + i,
    daysListed: 14 + i, goneDaysAgo: i, priceCutPercent: i === 0 ? 5 : null, isRealtor: i % 2 === 0,
    sellerName: i === 0 ? "Фарход" : null, sellerPhone: i === 0 ? "+992900000002" : null,
  })),
};

describe("dynamicsTiles", () => {
  it("формулирует четыре цифры простым русским", () => {
    const text = dynamicsTiles(base).map((t) => t.text);
    expect(text).toEqual([
      "Уходят за ~21 день",
      "Ушедшие дешевле висящих на 12%",
      "Снижали цену: 38% объявлений, в среднем −6%",
      "Риелторов 62%, собственников 38%",
    ]);
  });

  it("склоняет дни и различает «дороже» и «как висящие»", () => {
    expect(dynamicsTiles({ ...base, speed: { sampleSize: 9, medianDays: 33 } })[0].text).toBe("Уходят за ~33 дня");
    expect(dynamicsTiles({ ...base, speed: { sampleSize: 9, medianDays: 12 } })[0].text).toBe("Уходят за ~12 дней");
    expect(dynamicsTiles({ ...base, price: { ...base.price, diffPercent: 15 } })[1].text).toBe("Ушедшие дороже висящих на 15%");
    expect(dynamicsTiles({ ...base, price: { ...base.price, diffPercent: 1 } })[1].text).toBe("Ушедшие по цене как висящие");
  });

  it("пропускает блоки без данных", () => {
    const tiles = dynamicsTiles({
      ...base,
      speed: { sampleSize: 3, medianDays: null },
      price: { ...base.price, diffPercent: null, cutSharePercent: null, avgCutPercent: null },
    });
    expect(tiles.map((t) => t.key)).toEqual(["sellers"]);
  });
});

describe("MarketDynamicsView", () => {
  it("показывает цифры, подписи «ушло с площадки» и список недавно ушедших", () => {
    const html = renderToStaticMarkup(<MarketDynamicsView data={base} />);
    expect(html).toContain("Динамика рынка");
    expect(html).toContain("Уходят за ~21 день");
    expect(html).toContain("Ушедшие дешевле висящих на 12%");
    expect(html).toContain("Риелторов 62%, собственников 38%");
    expect(html).toContain("Недавно ушли с площадки");
    expect(html).toContain("https://somon.tj/adv/g0");
    expect(html).toContain("висело 14 дн.");
    expect(html).toContain("ушло сегодня");
    expect(html).toContain("снижали на 5%");
    expect(html).toContain("продать, снять или оно истекло");
    expect(html).not.toContain("продано");
  });

  it("телефон продавца — только в списке недавно ушедших, не в плитках", () => {
    const html = renderToStaticMarkup(<MarketDynamicsView data={base} />);
    expect(html).toContain("tel:+992900000002");
    const tilesHtml = html.slice(0, html.indexOf("Недавно ушли"));
    expect(tilesHtml).not.toContain("+992900000002");
  });

  it("на телефоне свёрнуто, на ПК раскрыто (кнопка sm:hidden, контент hidden sm:block)", () => {
    const html = renderToStaticMarkup(<MarketDynamicsView data={base} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("sm:hidden");
    expect(html).toContain('class="hidden sm:block mt-2 sm:mt-0"');
  });

  it("мало данных — одна строка без цифр", () => {
    const html = renderToStaticMarkup(
      <MarketDynamicsView
        data={{
          ...base, status: "insufficient", goneCount: 2, activeCount: 1,
          speed: { sampleSize: 2, medianDays: null },
          price: { ...base.price, diffPercent: null, cutSharePercent: null, avgCutPercent: null },
          sellers: { sampleSize: 3, realtorPercent: null, ownerPercent: null, realtorListings: 0 },
          recentlyGone: [],
        }}
      />,
    );
    expect(html).toContain("Данных о динамике пока мало (каталог собирается)");
    expect(html).not.toContain("Уходят за");
    expect(html).not.toContain("Недавно ушли");
  });

  it("unsupported — ничего не рисует", () => {
    expect(renderToStaticMarkup(<MarketDynamicsView data={{ ...base, status: "unsupported" }} />)).toBe("");
  });
});
