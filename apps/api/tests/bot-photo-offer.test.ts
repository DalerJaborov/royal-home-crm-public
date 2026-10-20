import { describe, expect, it } from "vitest";
import {
  alreadyShownPromptNote,
  photoOfferPromptRule,
  photoOfferSchemaField,
  parsePhotoOffer,
  stripDuplicatedCardLink,
} from "../src/ai/photoOffer.js";

/**
 * Обещание фотографий в канале, где их не отправить.
 *
 * Правило показа было одно на все каналы и безусловно велело писать «ана расмҳояш».
 * Отправлять снимки умеют только каналы Meta — в Telegram и в остальных каналах бот
 * сообщал клиенту, что отправил фотографии, и не отправлял ничего. Молча: с точки
 * зрения кода показа там просто не существует, и в журнал попадать было нечему.
 */
describe("канал не умеет отправлять фото", () => {
  const rule = photoOfferPromptRule(false);

  it("прямо запрещает писать «вот фото»", () => {
    expect(rule).toContain("ана расмҳояш");
    expect(rule).toContain("НИКОГДА не пиши");
  });

  it("не предлагает заполнять showPropertyNumber", () => {
    expect(rule).not.toContain("showPropertyNumber");
  });

  it("поля showPropertyNumber в схеме нет вовсе", () => {
    // Оставить поле «на всякий случай» — значит дать модели способ пообещать то,
    // чего код не сделает.
    expect(photoOfferSchemaField(false)).toEqual({});
  });

  it("вместо снимков велит дать ссылку", () => {
    expect(rule).toContain("ССЫЛКУ");
  });
});

describe("канал умеет отправлять фото", () => {
  const rule = photoOfferPromptRule(true);

  it("объясняет, как показать объект", () => {
    expect(rule).toContain("showPropertyNumber");
    expect(photoOfferSchemaField(true)).toHaveProperty("showPropertyNumber");
  });

  it("запрет на повтор ссылки касается только показанного объекта", () => {
    // Соседнее правило основного промта требует давать ссылку на объект сразу.
    // Безусловное «не повторяй ссылку» рядом с ним вело к тому, что бот перестал
    // бы давать ссылки вовсе.
    expect(rule).toContain("на ЭТОТ ЖЕ объект");
    expect(rule).toContain("ссылки на ДРУГИЕ объекты давай как обычно");
  });
});

describe("рубильник ссылок выключен, а показ включён (CHANNEL-NEW-32)", () => {
  it("правило показа не обещает ссылку и не требует её", () => {
    const rule = photoOfferPromptRule(true, 3, false);
    expect(rule).toContain("showPropertyNumber");
    expect(rule).not.toContain("и ссылка");
    expect(rule).toContain("никакие ссылки не давай");
  });

  it("с включёнными ссылками правило прежнее", () => {
    expect(photoOfferPromptRule(true, 3, true)).toContain("и ссылка");
  });
});

describe("объекты, показанные этому человеку раньше", () => {
  it("перечисляются номерами", () => {
    const note = alreadyShownPromptNote([12, 40]);
    expect(note).toContain("№12");
    expect(note).toContain("№40");
    expect(note).toContain("Второй раз");
  });

  it("пустой список не добавляет в промт ничего", () => {
    expect(alreadyShownPromptNote([])).toBe("");
  });
});

describe("номер объекта из ответа модели", () => {
  it("принимается только целым положительным числом", () => {
    expect(parsePhotoOffer(40)).toBe(40);
    expect(parsePhotoOffer("40")).toBeNull();
    expect(parsePhotoOffer(0)).toBeNull();
    expect(parsePhotoOffer(-1)).toBeNull();
    expect(parsePhotoOffer(1.5)).toBeNull();
    expect(parsePhotoOffer(undefined)).toBeNull();
  });
});

/**
 * Живой баг 23.08.2026 (чат на сайте): карточка объекта уже ушла отдельным
 * сообщением с кнопкой на royalhome.tj/listing/by-crm/..., а модель всё равно
 * продублировала ту же ссылку в своём тексте — вопреки прямому запрету в
 * photoOfferPromptRule («ссылку не повторяй»). Промт — просьба, а не гарантия;
 * это второй, кодовый рубеж поверх словесного запрета.
 */
describe("stripDuplicatedCardLink — второй рубеж поверх словесного запрета", () => {
  const siteUrl = "https://royalhome.tj/listing/by-crm/6bddcb20-7834-4d6b-b035-dffad3c32b0e";

  it("вырезает ссылку на уже показанный объект вместе с двоеточием перед ней", () => {
    const text = `У нас есть 2-комнатная квартира возле ЦУМа на Шохтемур, 72 квадрата за 1 060 000 сомони: ${siteUrl}`;
    const cleaned = stripDuplicatedCardLink(text, siteUrl);
    expect(cleaned).not.toContain(siteUrl);
    expect(cleaned).toContain("1 060 000 сомони");
  });

  it("текст без этой ссылки не трогает вовсе", () => {
    const text = "Сколько комнат вам нужно?";
    expect(stripDuplicatedCardLink(text, siteUrl)).toBe(text);
  });

  it("ссылку на ДРУГОЙ объект не трогает", () => {
    const other = "https://royalhome.tj/listing/by-crm/другой-id";
    const text = `Ещё есть вариант: ${other}`;
    expect(stripDuplicatedCardLink(text, siteUrl)).toBe(text);
  });

  it("не ломается на спецсимволах ссылки (query-параметры, дефисы)", () => {
    const trickyUrl = "https://royalhome.tj/listing/by-crm/id?ref=chat&x=1";
    const text = `Вот: ${trickyUrl} — подходит?`;
    const cleaned = stripDuplicatedCardLink(text, trickyUrl);
    expect(cleaned).not.toContain(trickyUrl);
    expect(cleaned).toContain("подходит?");
  });
});

/**
 * ФОТО НЕЛЬЗЯ И ССЫЛКИ ВЫКЛЮЧЕНЫ — правило не должно велеть дать ссылку.
 *
 * До 22.09.2026 `photoOfferPromptRule` ничего не знал про рубильник ссылок и при
 * выключенных ссылках в канале без фотографий велел «дай ССЫЛКУ на объект», а
 * соседнее правило в том же промте запрещало ссылки и обещания прислать их позже.
 * Адресов в блоке объектов при этом нет вовсе — модели оставалось их выдумать.
 */
describe("канал без фотографий и выключенные ссылки", () => {
  it("при выключенных ссылках правило не требует ссылку", () => {
    const rule = photoOfferPromptRule(false, 6, false);
    expect(rule).not.toContain("дай ССЫЛКУ");
    expect(rule).toContain("Ссылку тоже НЕ давай");
    // Обещать фотографии по-прежнему запрещено.
    expect(rule).toContain("ана расмҳояш");
  });

  it("при включённых ссылках правило прежнее", () => {
    const rule = photoOfferPromptRule(false, 6, true);
    expect(rule).toContain("дай ССЫЛКУ");
    // Умолчание — как было до правки: ссылки разрешены.
    expect(photoOfferPromptRule(false, 6)).toBe(rule);
  });
});
