import { describe, expect, it } from "vitest";
import {
  DEFAULT_REELS_CAPTION_TEMPLATES,
  fillReelsCaptionTemplate,
  generateReelsCaptionFromTemplates,
  parseReelsCaptionTemplates,
  reelsCaptionValuesFromProperty,
  withPostFooter,
  buildPriceDisplay,
  priceInTjsOnly,
  buildReelsHashtags,
} from "../src/lib/reelsCaptionTemplate.js";
import { formatPrice } from "../src/ai/seoGenerator.js";

/**
 * Подпись под Reels по шаблону (решение владельца 04.08.2026: шаблоны вместо
 * ИИ — дешевле и мгновенно). Три вещи легко сломать незаметно: разбор шаблонов
 * по разделителю, подстановку плейсхолдеров и то, что пустой факт убирает
 * строку целиком, а не оставляет дыру вроде «Комнат: ,».
 */

describe("Разбор шаблонов", () => {
  it("зашитые семь шаблонов по умолчанию, когда настройка пуста", () => {
    expect(parseReelsCaptionTemplates(null)).toHaveLength(7);
    expect(parseReelsCaptionTemplates("")).toHaveLength(7);
    expect(parseReelsCaptionTemplates("   ")).toHaveLength(7);
  });

  it("свои шаблоны через разделитель ---", () => {
    const custom = "Раз\n---\nДва\n---\nТри";
    expect(parseReelsCaptionTemplates(custom)).toEqual(["Раз", "Два", "Три"]);
  });

  it("зашитые шаблоны сами проходят собственный разбор без потерь", () => {
    expect(parseReelsCaptionTemplates(DEFAULT_REELS_CAPTION_TEMPLATES)).toHaveLength(7);
  });

  it("настройка из одного голого разделителя откатывается на зашитые по умолчанию, а не даёт пустой список", () => {
    expect(parseReelsCaptionTemplates("\n---\n")).toHaveLength(7);
    expect(parseReelsCaptionTemplates("   \n----\n  ")).toHaveLength(7);
  });
});

describe("Подстановка плейсхолдеров", () => {
  it("заполняет все известные плейсхолдеры", () => {
    const result = fillReelsCaptionTemplate("{{type}} в {{district}}, {{price}}", {
      type: "квартира",
      district: "Сино",
      rooms: "2",
      areaSqm: "60",
      floor: "3",
      totalFloors: "9",
      condition: "хорошее состояние",
      price: "400 000 с.",
      phone: "+992900000000",
      address: "Казокон",
      documents: "Договор",
      windowCount: "2",
      bathroom: "Раздельный",
    });
    expect(result).toBe("квартира в Сино, 400 000 с.");
  });

  it("строка с отсутствующим плейсхолдером убирается целиком, а не остаётся с дырой", () => {
    const result = fillReelsCaptionTemplate("{{type}}\nКомнат: {{rooms}}\n{{price}}", {
      type: "участок",
      district: "Сино",
      rooms: null, // участок — комнат не бывает
      areaSqm: "600",
      floor: null,
      totalFloors: null,
      condition: "хорошее состояние",
      price: "396 000 с.",
      phone: null,
      address: null,
      documents: null,
      windowCount: null,
      bathroom: null,
    });
    expect(result).toBe("участок\n396 000 с.");
    expect(result).not.toContain("Комнат");
  });

  it("новые плейсхолдеры (адрес, документ, санузел, окна) подставляются и убираются по тому же правилу", () => {
    const filled = fillReelsCaptionTemplate(
      "Адрес: {{address}}\nДокумент: {{documents}}\nСанузел: {{bathroom}}\nОкна: {{windowCount}}",
      {
        type: "квартира",
        district: "Сино",
        rooms: "3",
        areaSqm: "75",
        floor: "8",
        totalFloors: "12",
        condition: "новый ремонт",
        price: "1 050 000 с.",
        phone: "+992900000000",
        address: "Казокон",
        documents: "Договор",
        windowCount: "2",
        bathroom: "Раздельный",
      }
    );
    expect(filled).toBe("Адрес: Казокон\nДокумент: Договор\nСанузел: Раздельный\nОкна: 2");

    const withoutOptional = fillReelsCaptionTemplate("{{type}}\nСанузел: {{bathroom}}\n{{price}}", {
      type: "участок",
      district: "Сино",
      rooms: null,
      areaSqm: "600",
      floor: null,
      totalFloors: null,
      condition: "хорошее состояние",
      price: "396 000 с.",
      phone: null,
      address: "Казокон",
      documents: null,
      windowCount: null,
      bathroom: null, // у участка санузла в данных нет
    });
    expect(withoutOptional).toBe("участок\n396 000 с.");
    expect(withoutOptional).not.toContain("Санузел");
  });
});

describe("Сборка значений из полей объекта", () => {
  it("Decimal-подобные значения (toString) приводятся к строке так же, как number", () => {
    const decimalLike = { toString: () => "60" };
    const values = reelsCaptionValuesFromProperty({
      type: "APARTMENT",
      rooms: 2,
      areaSqm: decimalLike,
      floor: 3,
      totalFloors: 9,
      price: decimalLike,
      currency: "TJS",
      condition: "GOOD",
      districtName: "Сино",
      phone: "+992900000000",
    });
    expect(values.areaSqm).toBe("60");
    expect(values.type).toBe("квартира");
    expect(values.condition).toBe("хорошее состояние");
  });

  it("без адреса/документов/окон/деталей — новые поля просто null, старое поведение не ломается", () => {
    const values = reelsCaptionValuesFromProperty({
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 60,
      floor: 3,
      totalFloors: 9,
      price: 400000,
      currency: "TJS",
      condition: "GOOD",
      districtName: "Сино",
      phone: "+992900000000",
    });
    expect(values.address).toBeNull();
    expect(values.documents).toBeNull();
    expect(values.windowCount).toBeNull();
    expect(values.bathroom).toBeNull();
  });

  it("адрес/документ/окна/санузел подтягиваются из полей объекта", () => {
    const values = reelsCaptionValuesFromProperty({
      type: "APARTMENT",
      rooms: 3,
      areaSqm: 75,
      floor: 8,
      totalFloors: 12,
      price: 1050000,
      currency: "TJS",
      condition: "GOOD",
      districtName: "Сино",
      phone: "+992900000000",
      address: "Казокон",
      documents: "Договор",
      windowCount: 2,
      details: { bathroom: "Раздельный" },
    });
    expect(values.address).toBe("Казокон");
    expect(values.documents).toBe("Договор");
    expect(values.windowCount).toBe("2");
    expect(values.bathroom).toBe("Раздельный");
  });

  it("details без bathroom или не-объектом — санузел null, не падает", () => {
    expect(
      reelsCaptionValuesFromProperty({
        type: "LAND",
        rooms: null,
        areaSqm: 600,
        floor: null,
        totalFloors: null,
        price: 396000,
        currency: "TJS",
        condition: "GOOD",
        districtName: "Сино",
        phone: null,
        details: { balcony: "Балкон" },
      }).bathroom
    ).toBeNull();
    expect(
      reelsCaptionValuesFromProperty({
        type: "LAND",
        rooms: null,
        areaSqm: 600,
        floor: null,
        totalFloors: null,
        price: 396000,
        currency: "TJS",
        condition: "GOOD",
        districtName: "Сино",
        phone: null,
        details: null,
      }).bathroom
    ).toBeNull();
  });
});

describe("Цена в сомони + доллары в скобках (владелец, 17.09.2026)", () => {
  const usdProperty = {
    type: "APARTMENT" as const,
    rooms: 3,
    areaSqm: 75,
    floor: 8,
    totalFloors: 12,
    price: 40000,
    currency: "USD",
    condition: "GOOD" as const,
    districtName: "Сино",
    phone: "+992900000000",
  };

  it("USD-объект с переданным курсом — сомони первой строкой, доллары в скобках", () => {
    const values = reelsCaptionValuesFromProperty({ ...usdProperty, money: { usdToTjs: 11 } });
    expect(values.price).toBe(`${formatPrice(440000, "TJS")} (${formatPrice(40000, "USD")})`);
  });

  it("USD-объект БЕЗ курса — прежнее поведение, одни доллары (внутренние тексты вроде подписи монтажёру)", () => {
    const values = reelsCaptionValuesFromProperty(usdProperty);
    expect(values.price).toBe(formatPrice(40000, "USD"));
  });

  it("объект в сомони — курс ни на что не влияет, одна валюта как обычно", () => {
    const values = reelsCaptionValuesFromProperty({
      ...usdProperty,
      price: 440000,
      currency: "TJS",
      money: { usdToTjs: 11 },
    });
    expect(values.price).toBe(formatPrice(440000, "TJS"));
    expect(values.price).not.toContain("$");
  });
});

describe("Полная генерация", () => {
  it("случайный шаблон из пула всегда даёт непустой результат для полного набора данных", () => {
    const values = reelsCaptionValuesFromProperty({
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 60,
      floor: 3,
      totalFloors: 9,
      price: 400000,
      currency: "TJS",
      condition: "GOOD",
      districtName: "Сино",
      phone: "+992900000000",
    });
    for (let i = 0; i < 20; i++) {
      const caption = generateReelsCaptionFromTemplates(values, null);
      expect(caption.length).toBeGreaterThan(0);
      expect(caption).toContain("Сино");
    }
  });

  it("участок без комнат/этажей не ломает генерацию", () => {
    const values = reelsCaptionValuesFromProperty({
      type: "LAND",
      rooms: null,
      areaSqm: 600,
      floor: null,
      totalFloors: null,
      price: 396000,
      currency: "TJS",
      condition: "GOOD",
      districtName: "Сино",
      phone: null,
    });
    const caption = generateReelsCaptionFromTemplates(values, null);
    expect(caption.length).toBeGreaterThan(0);
    expect(caption).not.toMatch(/\{\{/); // ни один плейсхолдер не остался незаполненным
  });

  it("голый разделитель в настройках раньше падал TypeError на .split(undefined) — теперь откат на дефолт", () => {
    const values = reelsCaptionValuesFromProperty({
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 60,
      floor: 3,
      totalFloors: 9,
      price: 400000,
      currency: "TJS",
      condition: "GOOD",
      districtName: "Сино",
      phone: "+992900000000",
    });
    expect(() => generateReelsCaptionFromTemplates(values, "\n---\n")).not.toThrow();
    const caption = generateReelsCaptionFromTemplates(values, "\n---\n");
    expect(caption.length).toBeGreaterThan(0);
  });
});

/**
 * ПОДВАЛ ПОД КАЖДЫМ ПОСТОМ (23.09.2026, владелец: «код агента не надо, код
 * объекта ставить номер типа объект номер 112, а не 00112», и в тот же час
 * «телефоны агентов не надо под объектами ставить»). Под постом — одна строка
 * с номером объекта, без агента.
 *
 * Самое ломкое здесь — идемпотентность: подпись пересобирают кнопкой «Обновить
 * подписи», повторной модерацией и на самой публикации. Подвал обязан
 * ЗАМЕНЯТЬСЯ. Копился бы — под постом висели бы три «Объект №113» подряд, и
 * заметил бы это только клиент.
 */
describe("Подвал под постом", () => {
  it("номер объекта под постом — человеческим числом, без нулей и префикса", () => {
    const caption = withPostFooter("Текст поста", 113);
    expect(caption).toContain("Объект №113");
    // Внутрикрмный вид номера («ОБ-000113») под постом не показываем.
    expect(caption).not.toContain("ОБ-000113");
  });

  it("ни имени, ни телефона агента под постом нет", () => {
    const caption = withPostFooter("Текст поста", 113);
    expect(caption).not.toContain("Ведёт объект");
    expect(caption).not.toContain("Код агента");
  });

  it("пересборка подписи заменяет подвал, а не копит второй", () => {
    const first = withPostFooter("Текст поста", 113);
    const second = withPostFooter(first, 113);
    expect(second).toBe(first);
    expect(second.match(/Объект №/g) ?? []).toHaveLength(1);
  });

  it("номер объекта сменился — в подписи остаётся только новый", () => {
    const after = withPostFooter(withPostFooter("Текст", 113), 7);
    expect(after).toContain("Объект №7");
    expect(after).not.toContain("Объект №113");
  });

  it("сам текст поста подвал не трогает", () => {
    const caption = withPostFooter("Крючок\n\n✅Район: Сино\n✅Цена: 500 000 с.", 113);
    expect(caption).toContain("Крючок");
    expect(caption).toContain("✅Район: Сино");
    expect(caption).toContain("✅Цена: 500 000 с.");
  });
});

/**
 * БОЛЬШЕ ФАКТОВ ПОД ПОСТОМ и ЦЕНА ДВУМЯ СПОСОБАМИ (23.09.2026, владелец:
 * «в описании под постом добавить больше информации» и «монтажёру пусть цена
 * идёт только в сомони, а в автопостинге и в сомони, и в $»).
 */
describe("Новые факты и цена", () => {
  const money = { usdToTjs: 10 } as Parameters<typeof priceInTjsOnly>[2];

  it("рынок, участок и удобства доезжают до значений подписи", () => {
    const v = reelsCaptionValuesFromProperty({
      type: "HOUSE",
      rooms: 4,
      areaSqm: 120,
      floor: null,
      totalFloors: null,
      price: 500000,
      currency: "TJS",
      condition: "GOOD",
      districtName: "Сино",
      phone: null,
      landAreaSotka: 6,
      marketType: "SECONDARY",
      amenities: ["Гараж", "Сад"],
    });
    expect(v.landAreaSotka).toBe("6");
    // У дома «вторички/новостройки» нет (владелец 08.10.2026, propertyTypeFields.ts).
    expect(v.marketType).toBeNull();
    expect(v.amenities).toBe("Гараж, Сад");
    const flat = reelsCaptionValuesFromProperty({
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 60,
      floor: 3,
      totalFloors: 9,
      price: 500000,
      currency: "TJS",
      condition: "GOOD",
      districtName: "Сино",
      phone: null,
      marketType: "SECONDARY",
    });
    expect(flat.marketType).toBe("Вторичка");
  });

  it("публичная подпись — сомони первыми, доллары в скобках", () => {
    // Пробел в числе неразрывный (так печатает Intl) — сверяем с тем же
    // formatPrice, а не с текстом, набранным в тесте руками.
    expect(buildPriceDisplay(1000, "USD", money)).toBe(
      `${formatPrice(10000, "TJS")} (${formatPrice(1000, "USD")})`
    );
  });

  it("монтажёру — только сомони, без скобок: эту цену он набирает в кадр", () => {
    const forMontajer = priceInTjsOnly(1000, "USD", money);
    expect(forMontajer).not.toContain("(");
    expect(forMontajer).toBe(formatPrice(10000, "TJS"));
  });

  it("курса нет — цену не выдаём за сомони, показываем как есть", () => {
    expect(priceInTjsOnly(1000, "USD", undefined)).toBe(formatPrice(1000, "USD"));
  });
});

/**
 * ХЕШТЕГИ РАЙОНА В ПОДПИСИ (26.09.2026, владелец: «в Душанбе ищут по району»).
 * {{hashtags}} — последняя строка в каждом из 7 дефолтных шаблонов.
 */
describe("Хештеги района в подписи", () => {
  it("район с пробелом → слитный тег", () => {
    expect(buildReelsHashtags("Исмоили Сомони", "APARTMENT")).toBe("#ИсмоилиСомони #Душанбе #недвижимость #RoyalHome #квартира");
  });

  it("район с дефисом тоже склеивается", () => {
    expect(buildReelsHashtags("Сино-Профсоюзный", null)).toBe("#СиноПрофсоюзный #Душанбе #недвижимость #RoyalHome");
  });

  it("без района → строка тегов без района, но не пустая", () => {
    const hashtags = buildReelsHashtags(null, null);
    expect(hashtags).toBe("#Душанбе #недвижимость #RoyalHome");
    expect(hashtags).not.toContain("undefined");
  });

  it("тип участок → #участок, дом → #дом, неизвестный тип — без тега типа", () => {
    expect(buildReelsHashtags("Сино", "LAND")).toContain("#участок");
    expect(buildReelsHashtags("Сино", "HOUSE")).toContain("#дом");
    expect(buildReelsHashtags("Сино", "COMMERCIAL")).not.toMatch(/#(квартира|дом|участок)/);
  });

  it("reelsCaptionValuesFromProperty считает hashtags сама, по district/type объекта", () => {
    const values = reelsCaptionValuesFromProperty({
      type: "LAND",
      rooms: null,
      areaSqm: 600,
      floor: null,
      totalFloors: null,
      price: 396000,
      currency: "TJS",
      condition: "GOOD",
      districtName: "Сино",
      phone: null,
    });
    expect(values.hashtags).toBe("#Сино #Душанбе #недвижимость #RoyalHome #участок");
  });

  it("{{hashtags}} — последняя строка КАЖДОГО из 7 дефолтных шаблонов", () => {
    const templates = parseReelsCaptionTemplates(null);
    expect(templates).toHaveLength(7);
    for (const t of templates) {
      expect(t.trim().endsWith("{{hashtags}}")).toBe(true);
    }
  });

  it("подпись из шаблона по умолчанию содержит хештеги района и типа", () => {
    const values = reelsCaptionValuesFromProperty({
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 60,
      floor: 3,
      totalFloors: 9,
      price: 400000,
      currency: "TJS",
      condition: "GOOD",
      districtName: "Сино",
      phone: "+992900000000",
    });
    const caption = generateReelsCaptionFromTemplates(values, null, "seed-1");
    expect(caption).toContain("#Сино");
    expect(caption).toContain("#Душанбе");
    expect(caption).toContain("#квартира");
  });
});
