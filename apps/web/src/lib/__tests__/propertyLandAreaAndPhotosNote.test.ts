import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIN_PROPERTY_PHOTOS } from "@royal-home/shared";
import { formatLandSotka, hasLandArea, landAreaFormValue, landAreaPayload } from "../propertyLandArea";
import { propertyPhotosNote } from "../propertyPhotosNote";
import { propertyParams } from "../propertyParams";
import type { Property } from "../../types";

/** Находки №183 (сотки участка) и №185 (текст про число фото). */
const house = {
  type: "HOUSE",
  condition: "GOOD",
  areaSqm: 120,
  landAreaSotka: "6.00",
  rooms: 4,
  floor: null,
  totalFloors: null,
  district: { id: "d1", name: "Сино" },
} as unknown as Property;

describe("№185 — подпись над фото берёт число из общей константы", () => {
  it("при минимуме в одно фото не говорит про шесть", () => {
    expect(MIN_PROPERTY_PHOTOS).toBe(1);
    expect(propertyPhotosNote(MIN_PROPERTY_PHOTOS)).not.toContain("шест");
    expect(propertyPhotosNote(MIN_PROPERTY_PHOTOS)).toContain("одна фотография");
  });
  it("форма правки не содержит захардкоженного «шести»", () => {
    const src = readFileSync(fileURLToPath(new URL("../../components/PropertyFormModal.tsx", import.meta.url)), "utf8");
    expect(src).not.toContain("не меньше шести");
    expect(src).toContain("propertyPhotosNote(MIN_PROPERTY_PHOTOS)");
  });
});

describe("№183 — площадь участка видна и правится", () => {
  it("у дома и земли есть плитка «Участок», у квартиры и коммерции нет", () => {
    expect(propertyParams(house).find((i) => i.label === "Участок")?.value).toBe("6 сот.");
    expect(propertyParams({ ...house, type: "LAND" } as Property).some((i) => i.label === "Участок")).toBe(true);
    expect(propertyParams({ ...house, type: "APARTMENT" } as Property).some((i) => i.label === "Участок")).toBe(false);
    expect(propertyParams({ ...house, type: "COMMERCIAL" } as Property).some((i) => i.label === "Участок")).toBe(false);
  });
  it("не заполнено — «не указано», а не «null»", () => {
    expect(formatLandSotka(null)).toBe("не указано");
    expect(propertyParams({ ...house, landAreaSotka: null } as Property).find((i) => i.label === "Участок")?.value).toBe("не указано");
  });
  it("в тело правки идёт число для земли и дома", () => {
    expect(landAreaPayload("LAND", "6", true)).toEqual({ landAreaSotka: 6 });
    expect(landAreaPayload("HOUSE", "6,5", true)).toEqual({ landAreaSotka: 6.5 });
  });
  it("очистка при правке — null, при создании поле не шлётся", () => {
    expect(landAreaPayload("HOUSE", "", true)).toEqual({ landAreaSotka: null });
    expect(landAreaPayload("HOUSE", "", false)).toEqual({});
  });
  it("у квартиры поле не отправляется вовсе", () => {
    expect(landAreaPayload("APARTMENT", "6", true)).toEqual({});
    expect(hasLandArea("APARTMENT")).toBe(false);
  });
  it("значение из базы попадает в форму без хвостовых нулей", () => {
    expect(landAreaFormValue("6.00")).toBe("6");
    expect(landAreaFormValue(null)).toBe("");
  });
  it("форма правки подключает поле и тело запроса", () => {
    const src = readFileSync(fileURLToPath(new URL("../../components/PropertyFormModal.tsx", import.meta.url)), "utf8");
    expect(src).toContain("landAreaPayload(form.type, form.landAreaSotka, isEdit)");
    expect(src).toContain("Участок, соток");
  });
});
