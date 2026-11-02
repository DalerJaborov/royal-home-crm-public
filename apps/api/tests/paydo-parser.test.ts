import { describe, expect, it } from "vitest";
import { mapRepair, parsePaydoAd, parsePaydoDate, type PaydoRawAd } from "../src/lib/market/paydoParser.js";

// Урезанные фикстуры реальной формы ответа api.paydo.tj (02.11.2026).
const c = (name: string, value: string) => ({ name, value });

const flat: PaydoRawAd = {
  id: 1017446,
  subcategory_id: 201,
  title: "2-комн. • 9 этаж • 107 м² • Новостройка",
  subtitle1: "1 009 560 TJS",
  subtitle2: "Душанбе | Исмоили Сомони",
  price: "1009560.0",
  slug: "2-komn-9-etazh-107-m2-novostroyka-1017446",
  share_url: "https://paydo.tj/advertisement/2-komn-9-etazh-107-m2-novostroyka-1017446",
  promotion_type: "VIP",
  images: [{ url: "https://cdn.paydo.tj/a.webp" }, { url: "https://cdn.paydo.tj/b.webp" }],
  media: [{ url: "https://cdn.paydo.tj/a.webp", type: "IMAGE" }],
  characteristics: [
    c("Общая площадь", "107 м²"),
    c("Этаж", "9 из 18"),
    c("Тип", "Новостройка"),
    c("Количество комнат", "2-комнатная"),
    c("Обмен", "Нет"),
    c("Торг", "Да"),
    c("Ремонт", "Без ремонта"),
    c("Готовность дома", "Строится"),
    c("Дата публикации", "01.07.2026, 11:40"),
  ],
  details: { location: { address: "улица Низома Гянджеви, 315", latitude: 38.5568, longitude: 68.7531 } },
  publisher_info: { id: 39, name: "Farorood Group", is_verified: true, marketplace: { id: 8 } },
};

const flatNoMeta: PaydoRawAd = {
  id: 2,
  title: "1-комн.",
  subtitle1: "500 000 TJS",
  subtitle2: "Душанбе",
  price: "500000.0",
  slug: "x-2",
  characteristics: [
    c("Общая площадь", "47,5 м²"),
    c("Этаж", "3 из 9"),
    c("Тип", "Вторичка"),
    c("Количество комнат", "1-комнатная"),
    c("Обмен", "Да"),
    c("Ремонт", "С ремонтом"),
    c("Готовность дома", "Готовый дом"),
    c("Дата публикации", "Сегодня, 10:57"),
  ],
  details: null,
  publisher_info: null,
};

const house: PaydoRawAd = {
  id: 310898,
  title: "4-комн. • 2 этажный дом",
  subtitle1: "2 150 000 TJS",
  subtitle2: "Душанбе",
  price: "2150000.0",
  share_url: "https://paydo.tj/advertisement/4-komn-2-etazhnyy-dom-380437",
  characteristics: [
    c("Тип дома", "Хавли"),
    c("Количество комнат", "4"),
    c("Количество этажей", "2"),
    c("Ремонт", "Коробка"),
    c("Дата публикации", "Вчера, 14:31"),
  ],
  publisher_info: { id: 7, name: "Частное лицо" },
};

const noPrice: PaydoRawAd = { id: 3, title: "без цены", subtitle2: "Душанбе", price: null, characteristics: [] };

describe("parsePaydoAd", () => {
  const now = new Date("2026-11-02T10:00:00Z"); // 15:00 в Душанбе

  it("квартира: все признаки и ссылка", () => {
    const l = parsePaydoAd(flat, 201, now)!;
    expect(l).toMatchObject({
      sourceId: "1017446",
      sourceUrl: "https://paydo.tj/advertisement/2-komn-9-etazh-107-m2-novostroyka-1017446",
      rooms: 2,
      areaSqm: 107,
      floor: 9,
      totalFloors: 18,
      price: 1009560,
      currency: "TJS",
      negotiable: true,
      exchangePossible: false,
      repair: "SHELL",
      isNewBuilding: true,
      buildingReady: false,
      buildingType: "Новостройка",
      districtName: "Исмоили Сомони",
      city: "Душанбе",
      dealType: "SALE",
      propertyType: "APARTMENT",
      latitude: 38.5568,
      longitude: 68.7531,
      photoCount: 2,
      isPromoted: true,
    });
    expect(l.landmark).toBe("улица Низома Гянджеви, 315");
    // 01.07.2026 11:40 в Душанбе = 06:40 UTC
    expect(l.publishedAt?.toISOString()).toBe("2026-07-01T06:40:00.000Z");
  });

  it("вторичка без координат и продавца; запятая в площади", () => {
    const l = parsePaydoAd(flatNoMeta, 201, now)!;
    expect(l).toMatchObject({
      areaSqm: 47.5,
      isNewBuilding: false,
      buildingReady: true,
      repair: "RENOVATED",
      exchangePossible: true,
      districtName: null,
      landmark: null,
      latitude: null,
      sellerId: null,
      negotiable: false,
    });
    expect(l.sourceUrl).toBe("https://paydo.tj/advertisement/x-2");
    expect(l.publishedAt?.toISOString()).toBe("2026-11-02T05:57:00.000Z");
  });

  it("дом: HOUSE, этажность, без площади и признака новостройки", () => {
    const l = parsePaydoAd(house, 203, now)!;
    expect(l).toMatchObject({
      propertyType: "HOUSE",
      rooms: 4,
      areaSqm: null,
      floor: null,
      totalFloors: 2,
      buildingType: "Хавли",
      isNewBuilding: null,
      repair: "SHELL",
      price: 2150000,
    });
    expect(l.publishedAt?.toISOString()).toBe("2026-11-01T09:31:00.000Z");
  });

  it("без цены и характеристик объявление не теряется", () => {
    const l = parsePaydoAd(noPrice, 201, now)!;
    expect(l.price).toBeNull();
    expect(l.areaSqm).toBeNull();
    expect(l.sourceUrl).toBe("https://paydo.tj/advertisement/3");
  });

  it("без id — null", () => {
    expect(parsePaydoAd({} as PaydoRawAd, 201)).toBeNull();
  });
});

describe("mapRepair / parsePaydoDate", () => {
  it("словарь ремонта", () => {
    expect(mapRepair("Коробка")).toBe("SHELL");
    expect(mapRepair("Предчистовая")).toBe("WHITE");
    expect(mapRepair("Средний")).toBe("PARTIAL");
    expect(mapRepair("Косметический")).toBe("PARTIAL");
    expect(mapRepair("Евроремонт")).toBe("RENOVATED");
    expect(mapRepair("С ремонтом")).toBe("RENOVATED");
    expect(mapRepair("Дизайнерский")).toBe("DESIGNER");
    expect(mapRepair("что-то новое")).toBeNull();
    expect(mapRepair(undefined)).toBeNull();
  });

  it("непонятная дата — null", () => {
    expect(parsePaydoDate("давно")).toBeNull();
  });
});
