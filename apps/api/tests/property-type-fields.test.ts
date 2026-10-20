import { describe, expect, it } from "vitest";
import {
  normalizePropertyPatchForType,
  propertyCreateSchema,
  propertyFinishSummary,
  propertyFloorsLabel,
  propertyHeadline,
  propertyTypesWithoutField,
  visiblePropertyFacts,
} from "@royal-home/shared";
import { reelsCaptionValuesFromProperty } from "../src/lib/reelsCaptionTemplate.js";
import { buildCoverPosterValues } from "../src/lib/video/coverPoster.js";
import { editableFieldShown } from "../src/lib/telegramModeration.js";
import { parseCardPatch } from "../src/lib/propertyChangeRequests.js";

/**
 * ПОЛЯ ПО ТИПУ ОБЪЕКТА (владелец 08.10.2026): «выбираешь дом, а там новостройка/
 * вторичка; этажность будет, а какой этаж — не будет». Одна таблица
 * (packages/shared/src/propertyTypeFields.ts) на мастер, форму правки, сервер,
 * подписи, обложки и подбор.
 */

const BASE = {
  areaSqm: 120,
  price: 900000,
  currency: "TJS" as const,
  districtId: "00000000-0000-0000-0000-000000000000",
  address: "Тестовая, 1",
  condition: "GOOD" as const,
  ownerContact: "+992937000001",
  rooms: 4,
  floor: 3,
  totalFloors: 9,
  windowCount: 6,
};

describe("создание объекта: обязательность и лишние поля по типу", () => {
  it("дом без этажа проходит, а присланный этаж и «новостройка» не сохраняются", () => {
    const { floor: _f, ...rest } = BASE;
    expect(propertyCreateSchema.safeParse({ ...rest, type: "HOUSE" }).success).toBe(true);
    const parsed = propertyCreateSchema.parse({
      ...BASE,
      type: "HOUSE",
      marketType: "NEW_BUILD",
      stage: "SHELL",
      details: { elevator: "1 лифт", heating: "Автономное" },
    });
    expect(parsed.floor).toBeUndefined();
    expect(parsed.marketType).toBeUndefined();
    expect(parsed.stage).toBeUndefined();
    expect(parsed.details).toEqual({ heating: "Автономное" });
    expect(parsed.totalFloors).toBe(9);
  });

  it("дом по-прежнему требует этажность, комнаты и окна", () => {
    const { rooms: _r, totalFloors: _t, windowCount: _w, ...rest } = BASE;
    const parsed = propertyCreateSchema.safeParse({ ...rest, type: "HOUSE" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path[0]);
      expect(paths).toEqual(expect.arrayContaining(["rooms", "totalFloors", "windowCount"]));
      expect(paths).not.toContain("floor");
    }
  });

  it("у дома этаж выше этажности не валит сохранение — этажа у дома нет", () => {
    expect(propertyCreateSchema.safeParse({ ...BASE, type: "HOUSE", floor: 5, totalFloors: 2 }).success).toBe(true);
  });

  it("квартира по-прежнему требует этаж и проверяет его против этажности", () => {
    const { floor: _f, ...rest } = BASE;
    expect(propertyCreateSchema.safeParse({ ...rest, type: "APARTMENT" }).success).toBe(false);
    expect(propertyCreateSchema.safeParse({ ...BASE, type: "APARTMENT", floor: 12 }).success).toBe(false);
  });

  it("коммерция без комнат проходит (свободная планировка)", () => {
    const { rooms: _r, ...rest } = BASE;
    expect(propertyCreateSchema.safeParse({ ...rest, type: "COMMERCIAL" }).success).toBe(true);
  });

  it("у участка комнаты, этажи, окна, «новостройка» и характеристики отбрасываются", () => {
    const parsed = propertyCreateSchema.parse({
      ...BASE,
      type: "LAND",
      landAreaSotka: 6,
      marketType: "SECONDARY",
      details: { balcony: "Балкон" },
    });
    expect(parsed.rooms).toBeUndefined();
    expect(parsed.floor).toBeUndefined();
    expect(parsed.totalFloors).toBeUndefined();
    expect(parsed.windowCount).toBeUndefined();
    expect(parsed.marketType).toBeUndefined();
    expect(parsed.details).toEqual({});
    expect(parsed.landAreaSotka).toBe(6);
  });
});

describe("правка объекта: смена типа очищает лишнее", () => {
  const apartment = {
    type: "APARTMENT",
    rooms: 2,
    floor: 5,
    totalFloors: 9,
    windowCount: 4,
    landAreaSotka: null,
    marketType: "NEW_BUILD",
    stage: "SHELL",
    details: { elevator: "1 лифт", heating: "Центральное" },
  };

  it("квартира → дом: этаж, «новостройка», стадия и лифт очищаются", () => {
    const out = normalizePropertyPatchForType({ type: "HOUSE" }, apartment);
    expect(out).toMatchObject({ type: "HOUSE", floor: null, marketType: null, stage: null });
    expect(out.details).toEqual({ heating: "Центральное" });
    expect("totalFloors" in out).toBe(false);
  });

  it("квартира → участок: комнаты, этажи и окна очищаются, характеристики пустеют", () => {
    const out = normalizePropertyPatchForType({ type: "LAND" }, apartment);
    expect(out).toMatchObject({ rooms: null, floor: null, totalFloors: null, windowCount: null, details: {} });
  });

  it("без смены типа старый этаж дома не трогается, но новый не записывается", () => {
    const house = { ...apartment, type: "HOUSE" };
    expect(normalizePropertyPatchForType({ price: 1 }, house)).toEqual({ price: 1 });
    expect(normalizePropertyPatchForType({ floor: 2, price: 1 }, house)).toEqual({ price: 1 });
  });

  it("заявка на правку опубликованного дома: этаж не принимается", () => {
    const house = { ...apartment, type: "HOUSE", floor: 1, totalFloors: 2 };
    const r = parseCardPatch({ floor: 2 }, house);
    expect(r.ok).toBe(false);
    // этажность у дома меняется, проверка «этаж не выше этажности» его не касается
    const r2 = parseCardPatch({ totalFloors: 1 }, { ...house, floor: 3 });
    expect(r2.ok).toBe(true);
  });
});

describe("показ людям: этаж и «новостройка» только где они есть", () => {
  const oldHouse = {
    type: "HOUSE",
    rooms: 5,
    areaSqm: 200,
    floor: 1,
    totalFloors: 2,
    price: 1500000,
    currency: "TJS",
    condition: "GOOD",
    marketType: "SECONDARY",
    stage: null,
    districtName: "Сино",
    phone: null,
  };

  it("подпись к ролику дома — без этажа и без «вторички», этажность остаётся", () => {
    const v = reelsCaptionValuesFromProperty(oldHouse);
    expect(v.floor).toBeNull();
    expect(v.marketType).toBeNull();
    expect(v.totalFloors).toBe("2");
    expect(v.rooms).toBe("5");
  });

  it("подпись участка — без состояния ремонта и комнат", () => {
    const v = reelsCaptionValuesFromProperty({ ...oldHouse, type: "LAND", landAreaSotka: 6 });
    expect(v.condition).toBe("");
    expect(v.rooms).toBeNull();
    expect(v.totalFloors).toBeNull();
  });

  it("квартира показывает всё как раньше", () => {
    const v = reelsCaptionValuesFromProperty({ ...oldHouse, type: "APARTMENT", marketType: "NEW_BUILD" });
    expect(v.floor).toBe("1");
    expect(v.marketType).toBe("Новостройки");
  });

  it("строка «вторичка/новостройка» у дома — только состояние, у участка — ничего", () => {
    expect(propertyFinishSummary({ type: "HOUSE", marketType: "NEW_BUILD", condition: "NEW_BUILDING" })).toBeNull();
    expect(propertyFinishSummary({ type: "HOUSE", marketType: "SECONDARY", condition: "GOOD" })).toBe("Хорошее состояние");
    expect(propertyFinishSummary({ type: "LAND", condition: "GOOD" })).toBeNull();
    expect(propertyFinishSummary({ type: "APARTMENT", marketType: "SECONDARY", condition: "GOOD" })).toBe("Вторичка, хорошее состояние");
  });

  it("этаж словами: квартира «5 из 9», дом «2 этажа», участок — ничего", () => {
    expect(propertyFloorsLabel({ type: "APARTMENT", floor: 5, totalFloors: 9 })).toEqual({ label: "Этаж", value: "5 из 9" });
    expect(propertyFloorsLabel({ type: "HOUSE", floor: 1, totalFloors: 2 })).toEqual({ label: "Этажность", value: "2 этажа" });
    expect(propertyFloorsLabel({ type: "HOUSE", floor: 1, totalFloors: 5 })?.value).toBe("5 этажей");
    expect(propertyFloorsLabel({ type: "LAND", floor: 1, totalFloors: 1 })).toBeNull();
  });

  it("имя для бота: дом не выдаётся за квартиру", () => {
    expect(propertyHeadline({ type: "APARTMENT", rooms: 2 })).toBe("2-комн");
    expect(propertyHeadline({ type: "HOUSE", rooms: 4 })).toBe("Дом, 4-комн");
    expect(propertyHeadline({ type: "LAND", rooms: 1 })).toBe("Участок");
  });

  it("обложка дома без этажа; участок — крупно сотки, а не комнаты", () => {
    const money = { usdToTjs: 11 } as never;
    const house = buildCoverPosterValues(
      { rooms: 5, areaSqm: 200, floor: null, price: 1, currency: "TJS", districtName: null, address: null },
      money
    );
    expect(house.floor).toBeNull();
    const facts = visiblePropertyFacts({ type: "LAND", rooms: 1, floor: 1 });
    expect(facts).toEqual({ type: "LAND", rooms: null, floor: null });
  });

  it("Telegram-модерация не предлагает «Этаж» у дома", () => {
    expect(editableFieldShown("HOUSE", "floor")).toBe(false);
    expect(editableFieldShown("HOUSE", "totalFloors")).toBe(true);
    expect(editableFieldShown("LAND", "rooms")).toBe(false);
    expect(editableFieldShown("APARTMENT", "floor")).toBe(true);
  });

  it("подбор: этаж не важен у дома и участка", () => {
    expect(propertyTypesWithoutField("floor").sort()).toEqual(["HOUSE", "LAND"]);
  });
});
