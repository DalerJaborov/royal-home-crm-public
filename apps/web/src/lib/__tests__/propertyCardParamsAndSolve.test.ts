import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { propertyParamChips, propertyParams } from "../propertyParams";
import { solveHasContent } from "../propertySolve";
import type { Property } from "../../types";

/**
 * Карточка объекта без повторов (24.09.2026, разбор карточки, пункты 6, 7, 12).
 *
 * Цена за м² стояла дважды (под ценой и плиткой), плитки просмотра и правки
 * были разные, а «Решить сейчас» у агента бывал одним заголовком.
 */
const base = {
  type: "APARTMENT",
  condition: "GOOD",
  areaSqm: 64,
  rooms: 2,
  floor: 5,
  totalFloors: 9,
  district: { id: "d1", name: "Сино" },
  status: "AVAILABLE",
  pipeline: null,
  reviewRejectionReason: null,
  siteUrl: null,
  videoHandoffFinalPath: null,
  publishedChannels: [],
} as unknown as Property;

const agentOpts = {
  canModerate: false,
  canPublish: false,
  canEdit: true,
  isTrashed: false,
  isDealDriven: false,
  marketingRole: false,
  tiktokConnected: false,
};

describe("параметры объекта — один набор", () => {
  it("шесть параметров, без цены за м² (она под ценой)", () => {
    const items = propertyParams(base);
    expect(items.map((i) => i.label)).toEqual(["Площадь", "Комнаты", "Этаж", "Район", "Тип", "Состояние"]);
    expect(items.find((i) => i.label === "Этаж")?.value).toBe("5 из 9");
    expect(items.find((i) => i.label === "Район")?.value).toBe("Сино");
  });

  it("этаж без этажности — просто номер, без «null»", () => {
    const items = propertyParams({ ...base, totalFloors: null } as Property);
    expect(items.find((i) => i.label === "Этаж")?.value).toBe("5");
  });

  it("все раскладки карточки берут параметры отсюда, «Цена за м²» плиткой не рисуется", () => {
    const src = readFileSync(fileURLToPath(new URL("../../pages/PropertyDetail.tsx", import.meta.url)), "utf8");
    expect(src).not.toContain('label: "Цена за м²"');
    expect(src).not.toContain('label="Цена за м²"');
    // С 06.10.2026 параметры чипами один раз (`PropertyPriceCard`), без плиток и сетки.
    expect(src.match(/propertyParams\(property\)/g)).toHaveLength(1);
    const card = readFileSync(fileURLToPath(new URL("../../components/property/PropertyPriceCard.tsx", import.meta.url)), "utf8");
    expect(card.match(/propertyParamChips\(property\)/g)?.length).toBe(1);
  });

  it("чипы параметров: слово у комнат, без района и без «не указано»", () => {
    expect(propertyParamChips(base)).toEqual(["64 м²", "2 комнаты", "5 из 9", "Квартира", "Хорошее состояние"]);
    const sparse = propertyParamChips({ ...base, rooms: null, floor: null } as Property);
    expect(sparse.some((c) => /не указан/i.test(c))).toBe(false);
    expect(sparse).not.toContain("Сино");
  });
});

describe("«Решить сейчас» — только когда есть что решать", () => {
  it("агент, объект в продаже, не на сайте — блока нет", () => {
    expect(solveHasContent(base, agentOpts)).toBe(false);
  });

  it("объект на сайте — есть строка «Сайт» со ссылкой «Отправить клиенту»", () => {
    expect(solveHasContent({ ...base, siteUrl: "https://royalhome.tj/p/1" } as Property, agentOpts)).toBe(true);
  });

  it("право публикации, объект готовится, возврат на доработку, правка, сделка — блок есть", () => {
    expect(solveHasContent(base, { ...agentOpts, canPublish: true })).toBe(true);
    expect(solveHasContent({ ...base, pipeline: { inPipeline: true } } as Property, agentOpts)).toBe(true);
    expect(
      solveHasContent({ ...base, status: "AWAITING_VIDEO", reviewRejectionReason: "Темно" } as Property, agentOpts),
    ).toBe(true);
    expect(solveHasContent({ ...base, status: "EDITING" } as Property, agentOpts)).toBe(true);
    expect(solveHasContent({ ...base, status: "EDITING" } as Property, { ...agentOpts, canEdit: false })).toBe(false);
    expect(solveHasContent(base, { ...agentOpts, isDealDriven: true })).toBe(true);
  });

  it("на проверке — блок только у того, кто одобряет", () => {
    const review = { ...base, status: "PENDING_REVIEW" } as Property;
    expect(solveHasContent(review, agentOpts)).toBe(false);
    expect(solveHasContent(review, { ...agentOpts, canModerate: true })).toBe(true);
  });

  it("TikTok — только маркетингу с готовым роликом и подключённым каналом", () => {
    const ready = { ...base, videoHandoffFinalPath: "final.mp4" } as Property;
    expect(solveHasContent(ready, { ...agentOpts, marketingRole: true })).toBe(false);
    expect(solveHasContent(ready, { ...agentOpts, marketingRole: true, tiktokConnected: true })).toBe(true);
    expect(solveHasContent(ready, { ...agentOpts, tiktokConnected: true })).toBe(false);
  });

  it("служебной подписи «Кнопка есть только у того, у кого есть право» больше нет", () => {
    const src = readFileSync(fileURLToPath(new URL("../../pages/PropertyDetail.tsx", import.meta.url)), "utf8");
    expect(src).not.toContain("Кнопка есть только у того");
  });
});
