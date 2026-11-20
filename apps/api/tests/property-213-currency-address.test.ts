import { describe, expect, it, vi } from "vitest";
vi.mock("../src/db.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: { $disconnect: async () => {} } }));
import { meaningfulPropertyAddress, propertyWizardStepErrors } from "@royal-home/shared";
import { fillReelsCaptionTemplate, reelsCaptionValuesFromProperty, REELS_FACTS_TEMPLATE } from "../src/lib/reelsCaptionTemplate.js";

/**
 * ОБЪЕКТ №213 (21.11.2026): «107 400» долларов записаны сомони, адрес — одно слово «улица».
 * Обе ошибки ушли в подпись, задание монтажёру и озвучку. Ловим их у источника (мастер CRM и Шабнам —
 * одна функция propertyWizardStepErrors) и не выводим «Адрес: улица» в тексты для людей.
 */
describe("№213: перепутанная валюта и адрес-заготовка", () => {
  const main = { type: "APARTMENT", price: "107400", currency: "TJS", areaSqm: "89.5", rooms: "2", floor: "20", totalFloors: "24" } as never;

  it("мастер не пропускает 107 400 сомони за 89,5 м² квартиры: просит проверить валюту", () => {
    expect(propertyWizardStepErrors("main", main).price).toMatch(/Проверьте валюту/u);
    expect(propertyWizardStepErrors("main", { ...(main as object), currency: "USD" } as never).price).toBeUndefined();
    expect(propertyWizardStepErrors("main", { ...(main as object), price: "1000000" } as never).price).toBeUndefined();
  });

  it("адрес из одного слова-заготовки — не адрес", () => {
    for (const raw of ["улица", " Улица. ", "ул.", "кӯча", "-", "нет", ""]) expect(meaningfulPropertyAddress(raw)).toBeNull();
    for (const raw of ["улица Гурминджа Завкибекова", "V&R Plaza", "кӯчаи Бухоро, назди доми алфемо"]) expect(meaningfulPropertyAddress(raw)).toBe(raw);
    expect(propertyWizardStepErrors("place", { districtId: "d1", address: "улица" } as never).address).toMatch(/полностью/u);
    expect(propertyWizardStepErrors("place", { districtId: "d1", address: "улица Айни 12" } as never).address).toBeUndefined();
  });

  it("подпись (и задание монтажёру из тех же значений) без строки «Адрес: улица»", () => {
    const values = reelsCaptionValuesFromProperty({ type: "APARTMENT", rooms: 2, areaSqm: "89.5", floor: 20, totalFloors: 24, price: "1000000", currency: "TJS",
      condition: "NO_REPAIR", districtName: "Исмоили Сомони", phone: null, address: "улица" });
    expect(values.address).toBeNull();
    const caption = fillReelsCaptionTemplate(REELS_FACTS_TEMPLATE, values);
    expect(caption).not.toMatch(/Адрес/u);
    expect(caption).toMatch(/Район: Исмоили Сомони/u);
  });
});
