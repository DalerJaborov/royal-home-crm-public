import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketOnPlatformsView, priceDiffText } from "./MarketOnPlatforms";
import type { OwnMarketMatch, OwnMarketMatchesData } from "../types";

const match: OwnMarketMatch = {
  id: "m1",
  status: "CANDIDATE",
  score: 88,
  reasons: [{ code: "phone", label: "Телефон владельца совпал" }],
  foundAt: "2026-11-02T10:00:00Z",
  source: "somon.tj",
  sourceUrl: "https://somon.tj/adv/1_x/",
  title: "3-комн. квартира, Сино",
  priceTjs: 1196000,
  priceDiffPercent: 4,
  areaSqm: 82,
  areaDiffSqm: 2,
  rooms: 3,
  floor: 5,
  totalFloors: 9,
  sellerName: "Фируз",
  sellerPhone: "+992900000056",
  sellerPhoneHidden: false,
  isAgency: false,
  firstSeenAt: "2026-10-20T10:00:00Z",
  isActive: true,
};
const data = (matches: OwnMarketMatch[]): OwnMarketMatchesData => ({ ourPriceTjs: 1150000, matches });
const noop = () => {};

describe("MarketOnPlatformsView", () => {
  it("без совпадений ничего не рисует", () => {
    expect(renderToStaticMarkup(<MarketOnPlatformsView data={data([])} onStatus={noop} />)).toBe("");
  });

  it("показывает площадку, цену, сравнение, продавца, ссылку и кнопки", () => {
    const html = renderToStaticMarkup(<MarketOnPlatformsView data={data([match])} onStatus={noop} />);
    expect(html).toContain("Этот объект на площадках");
    expect(html).toContain("Somon");
    expect(html).toContain("на 4% дороже, чем у нас");
    expect(html).toContain("Фируз");
    expect(html).toContain("+992900000056");
    expect(html).toContain('href="https://somon.tj/adv/1_x/"');
    expect(html).toContain("Открыть объявление");
    expect(html).toContain("Это наш");
    expect(html).toContain("Не наш");
  });

  it("подтверждённое: бейдж и нет кнопки «Это наш»; снятое помечено", () => {
    const html = renderToStaticMarkup(
      <MarketOnPlatformsView data={data([{ ...match, status: "CONFIRMED", isActive: false }])} onStatus={noop} />
    );
    expect(html).toContain("Подтверждено");
    expect(html).toContain("Снято с площадки");
    expect(html).not.toContain("Это наш");
    expect(html).toContain("Не наш");
  });

  it("скрытый телефон не рисуется ссылкой, есть пометка", () => {
    const html = renderToStaticMarkup(
      <MarketOnPlatformsView data={data([{ ...match, sellerPhone: null, sellerPhoneHidden: true }])} onStatus={noop} />
    );
    expect(html).not.toContain("tel:");
    expect(html).toContain("телефон скрыт");
  });
});

describe("MarketOnPlatformsView: доступ и вид кнопок", () => {
  it("телефон скрыт правами — кнопки WhatsApp нет (иначе номер открылся бы через сервер)", () => {
    const hidden = renderToStaticMarkup(
      <MarketOnPlatformsView data={data([{ ...match, sellerPhone: null, sellerPhoneHidden: true }])} onStatus={noop} />
    );
    expect(hidden).not.toContain("WhatsApp");
    const open = renderToStaticMarkup(<MarketOnPlatformsView data={data([match])} onStatus={noop} />);
    expect(open).toContain("Написать продавцу в WhatsApp");
  });

  it("кнопки решения и WhatsApp на .pill темы, а не на glass-btn (его бьёт сброс .rh2 button)", () => {
    const html = renderToStaticMarkup(<MarketOnPlatformsView data={data([match])} onStatus={noop} />);
    expect(html).not.toContain("glass-btn");
    const our = html.match(/<button[^>]*>Это наш/)?.[0] ?? "";
    expect(our).toMatch(/class="pill /);
    expect(our).toContain("px-3!");
    const not = html.match(/<button[^>]*>Не наш/)?.[0] ?? "";
    expect(not).toMatch(/class="pill ghost /);
    const wa = html.match(/<button[^>]*aria-label="Написать продавцу в WhatsApp"[^>]*>/)?.[0] ?? "";
    expect(wa).toMatch(/class="pill ghost /);
  });
});

describe("priceDiffText", () => {
  it("знак разницы", () => {
    expect(priceDiffText(4)?.text).toBe("на 4% дороже, чем у нас");
    expect(priceDiffText(-7)?.text).toBe("на 7% дешевле, чем у нас");
    expect(priceDiffText(0)?.tone).toBe("same");
    expect(priceDiffText(null)).toBeNull();
  });
});
