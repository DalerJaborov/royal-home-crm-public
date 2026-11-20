import { describe, expect, it, vi } from "vitest";
const ai = vi.hoisted(() => ({ callAiText: vi.fn() }));
vi.mock("../src/db.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: { $disconnect: async () => {} } }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/ai/client.js")>(), callAiText: ai.callAiText }));
import {
  meaningfulPropertyAddress, narrationCurrencyError, propertyWizardErrors, propertyWizardStepErrors, propertyWizardStepWarnings,
  propertyWizardWarningSignature, propertyWizardWarnings, renderNarrationTemplate,
} from "@royal-home/shared";
import { fillReelsCaptionTemplate, reelsCaptionValuesFromProperty, REELS_FACTS_TEMPLATE } from "../src/lib/reelsCaptionTemplate.js";
import { generateSeoFields } from "../src/ai/seoGenerator.js";
import { narrationScriptError } from "../src/lib/propertyNarration.js";

/**
 * ОБЪЕКТ №213 (21.11.2026): «107 400» долларов записаны сомони, адрес — одно слово «улица».
 * Ревью #348: это ПРЕДУПРЕЖДЕНИЯ, а не запрет — мастер правит и старые объекты, а настоящая дешёвая квартира
 * должна сохраняться. Предупреждение у своего поля, кнопкой «Цена верная» / «Адрес верный» снимается до
 * следующей правки этих значений. Адрес-заготовка не выходит ни в подпись, ни на сайт.
 */
const main = { type: "APARTMENT", price: "107400", currency: "TJS", areaSqm: "89.5", rooms: "2", floor: "20", totalFloors: "24" } as never;
const place = { districtId: "d1", address: "улица" } as never;

describe("№213: перепутанная валюта и адрес-заготовка — предупреждения, а не запрет", () => {
  it("сохранить можно: ни валюта, ни адрес не попадают в ошибки мастера", () => {
    expect(propertyWizardStepErrors("main", main).price).toBeUndefined();
    expect(propertyWizardStepErrors("place", place).address).toBeUndefined();
    const all = propertyWizardErrors({ ...(main as object), ...(place as object) } as never);
    expect(all.price).toBeUndefined();
    expect(all.address).toBeUndefined();
  });

  it("предупреждение — на шаге своего поля и только на нём", () => {
    expect(propertyWizardStepWarnings("main", main).price).toMatch(/Проверьте валюту/u);
    expect(propertyWizardStepWarnings("place", main).price).toBeUndefined();
    expect(propertyWizardStepWarnings("place", place).address).toMatch(/адрес не дописан/u);
    expect(propertyWizardStepWarnings("main", place).address).toBeUndefined();
    expect(propertyWizardStepWarnings("main", { ...(main as object), currency: "USD" } as never).price).toBeUndefined();
    expect(propertyWizardStepWarnings("place", { districtId: "d1", address: "улица Айни 12" } as never).address).toBeUndefined();
  });

  it("«Цена верная» действует на эти значения; правка цены, валюты или площади спрашивает снова", () => {
    const confirmed = { price: propertyWizardWarningSignature("price", main) };
    expect(propertyWizardStepWarnings("main", main, confirmed).price).toBeUndefined();
    expect(propertyWizardStepWarnings("main", { ...(main as object), price: "107500" } as never, confirmed).price).toMatch(/Проверьте валюту/u);
    expect(propertyWizardStepWarnings("main", { ...(main as object), areaSqm: "90" } as never, confirmed).price).toMatch(/Проверьте валюту/u);
  });

  it("Шабнам видит те же предупреждения (строкой в карточке, создание не блокируют)", () => {
    expect(Object.keys(propertyWizardWarnings({ ...(main as object), ...(place as object) } as never)).sort()).toEqual(["address", "price"]);
    expect(propertyWizardWarnings({ ...(main as object), ...(place as object), offSite: true } as never).address).toBeUndefined();
  });

  it("адрес из одного слова-заготовки — не адрес", () => {
    for (const raw of ["улица", " Улица. ", "ул.", "кӯча", "-", "нет", ""]) expect(meaningfulPropertyAddress(raw)).toBeNull();
    for (const raw of ["улица Гурминджа Завкибекова", "V&R Plaza", "кӯчаи Бухоро, назди доми алфемо"]) expect(meaningfulPropertyAddress(raw)).toBe(raw);
  });

  it("подпись (и задание монтажёру из тех же значений) без строки «Адрес: улица»", () => {
    const values = reelsCaptionValuesFromProperty({ type: "APARTMENT", rooms: 2, areaSqm: "89.5", floor: 20, totalFloors: 24, price: "1000000", currency: "TJS",
      condition: "NO_REPAIR", districtName: "Исмоили Сомони", phone: null, address: "улица" });
    expect(values.address).toBeNull();
    const caption = fillReelsCaptionTemplate(REELS_FACTS_TEMPLATE, values);
    expect(caption).not.toMatch(/Адрес/u);
    expect(caption).toMatch(/Район: Исмоили Сомони/u);
  });

  it("описание на сайт: ни модели, ни запасному шаблону «Адрес: улица» не уходит", async () => {
    ai.callAiText.mockResolvedValueOnce(null);
    const seo = await generateSeoFields({ type: "APARTMENT", rooms: 2, areaSqm: 89.5, floor: 20, totalFloors: 24, price: 1_000_000, currency: "TJS",
      districtName: "Исмоили Сомони", address: "улица", condition: "NO_REPAIR", amenities: [], urgent: false } as never);
    expect(String(ai.callAiText.mock.calls[0]![0].user)).not.toMatch(/Адрес/u);
    expect(seo.description).not.toMatch(/Адрес|улица/u);
    expect(seo.seoDesc).not.toMatch(/улица/u);
    expect(seo.seoDesc).toMatch(/в районе Исмоили Сомони\. /u);
  });
});

describe("мелочи ревью #348", () => {
  it("сторож долларов ловит «dollar», «долар», «долл» без точки, «USDT», «у.е.»; сомони не трогает", () => {
    for (const t of ["10 dollar", "сто долар", "пять долл", "85000 USDT", "сто у.е.", "сто у. е."]) expect(narrationCurrencyError(t), t).toMatch(/только в сомони/u);
    for (const t of ["нархаш сад ҳазор сомонӣ", "дом у реки", "Душанбе"]) expect(narrationCurrencyError(t), t).toBeNull();
  });

  it("подсказка про {цена} — только для шаблона; свой текст агента получает понятный совет", () => {
    expect(narrationCurrencyError("85 $", { template: true })).toMatch(/\{цена\}/u);
    expect(narrationCurrencyError("85 $")).not.toMatch(/\{цена\}/u);
    expect(narrationScriptError("Цена 85 $")).not.toMatch(/\{цена\}/u);
  });

  it("пустоту не озвучиваем: шаблон из одной фразы про цену без курса пустеет — это ошибка, а не пустой mp3", () => {
    const text = renderNarrationTemplate({ lang: "tg", text: "Нархаш {цена}." }, { type: "APARTMENT", rooms: 2, areaSqm: "60", floor: 3, totalFloors: 9, district: "Сино", price: "85000", currency: "USD" });
    expect(text.trim()).toBe("");
    expect(narrationScriptError(text)).toMatch(/пустой/u);
  });
});
