import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * ССЫЛКА НА САЙТ СИЛЬНЕЕ ЧИСЛА В ТЕКСТЕ (19.10.2026). Кнопка WhatsApp на сайте
 * шлёт «Интересует объект №45: https://royalhome.tj/listing/45», где 45 — id
 * объявления на САЙТЕ, а не номер карточки CRM. Раньше это уводило заявку к
 * хозяину чужой карточки №45. Правило — lib/propertyMentionFromText.ts.
 */

const { prisma } = await import("../src/db.js");
const { readPropertyMention, mentionedCardNumber } = await import("../src/lib/propertyMentionFromText.js");
const { resolveMentionedPropertyId } = await import("../src/lib/botPropertyMention.js");

describe("readPropertyMention — чистое правило, без базы", () => {
  it("число из ссылки /listing/<n> и такое же «№n» в тексте — это id сайта, номера карточки нет", () => {
    const m = readPropertyMention("Здравствуйте! Интересует объект №45: https://royalhome.tj/listing/45");
    expect(m.siteListingId).toBe(45);
    expect(m.number).toBeNull();
    expect(mentionedCardNumber("Интересует объект №45: https://royalhome.tj/listing/45")).toBeNull();
  });

  it("ссылка /listing/by-crm/<id> отдаёт id карточки CRM", () => {
    const m = readPropertyMention("объект 7 https://royalhome.tj/listing/by-crm/abc-123");
    expect(m.crmId).toBe("abc-123");
    expect(m.siteListingId).toBeNull();
    expect(m.number).toBe("7");
  });

  it("номер без ссылки — как раньше", () => {
    const m = readPropertyMention("интересует объект №112");
    expect(m).toEqual({ crmId: null, siteListingId: null, number: "112" });
  });

  it("номер, отличный от id в ссылке, остаётся номером карточки", () => {
    const m = readPropertyMention("объект №112 https://royalhome.tj/listing/45");
    expect(m.siteListingId).toBe(45);
    expect(m.number).toBe("112");
  });

  it("ссылка в отдельном поле (вложение) тоже снимает путаницу", () => {
    expect(mentionedCardNumber("интересует №45", "https://royalhome.tj/listing/45")).toBeNull();
  });

  it("чужой сайт не считается нашей ссылкой", () => {
    const m = readPropertyMention("объект №45 https://example.com/listing/45");
    expect(m.siteListingId).toBeNull();
    expect(m.number).toBe("45");
  });
});

describe("resolveMentionedPropertyId — ссылка решает, какой объект", () => {
  const runId = Date.now().toString(36);
  let districtId: string;
  let cardProp: { id: string; shortId: number };
  let siteProp: { id: string; shortId: number; siteListingId: number };
  let crmLinkProp: { id: string; shortId: number };
  const created: string[] = [];

  const baseData = {
    type: "APARTMENT" as const,
    areaSqm: 60,
    rooms: 2,
    price: 500_000,
    currency: "TJS" as const,
    address: "Тестовая, 5",
    condition: "GOOD" as const,
    status: "AVAILABLE" as const,
  };

  beforeAll(async () => {
    districtId = (await prisma.district.create({ data: { name: `Тест-ссылка-сайта-${runId}` } })).id;
    cardProp = await prisma.property.create({
      data: { ...baseData, title: `Карточка по номеру ${runId}`, districtId },
      select: { id: true, shortId: true },
    });
    created.push(cardProp.id);
    // id объявления на сайте нарочно совпадает с номером ЧУЖОЙ карточки.
    siteProp = (await prisma.property.create({
      data: { ...baseData, title: `Объект сайта ${runId}`, districtId, siteListingId: cardProp.shortId },
      select: { id: true, shortId: true, siteListingId: true },
    })) as typeof siteProp;
    created.push(siteProp.id);
    crmLinkProp = await prisma.property.create({
      data: { ...baseData, title: `Объект по ссылке CRM ${runId}`, districtId },
      select: { id: true, shortId: true },
    });
    created.push(crmLinkProp.id);
  });

  afterAll(async () => {
    await prisma.property.deleteMany({ where: { id: { in: created } } });
    await prisma.district.deleteMany({ where: { id: districtId } });
  });

  it("«объект №N» + /listing/N: выигрывает объект сайта, а не карточка №N", async () => {
    const n = cardProp.shortId;
    const id = await resolveMentionedPropertyId(`Здравствуйте! Интересует объект №${n}: https://royalhome.tj/listing/${n}`);
    expect(id).toBe(siteProp.id);
    expect(id).not.toBe(cardProp.id);
  });

  it("/listing/N без объекта сайта с таким id: номер N не подставляет чужую карточку", async () => {
    const n = crmLinkProp.shortId;
    expect(await prisma.property.findFirst({ where: { siteListingId: n } })).toBeNull();
    // Карточка №n существует (crmLinkProp), но «n» здесь — id сайта: молча её подставлять нельзя.
    expect(await resolveMentionedPropertyId(`Интересует объект №${n}: https://royalhome.tj/listing/${n}`)).toBeNull();
  });

  it("/listing/by-crm/<id> решает объект, даже если рядом назван другой номер", async () => {
    const id = await resolveMentionedPropertyId(
      `объект №${cardProp.shortId} https://royalhome.tj/listing/by-crm/${crmLinkProp.id}`
    );
    expect(id).toBe(crmLinkProp.id);
  });

  it("номер без ссылки по-прежнему находит карточку", async () => {
    expect(await resolveMentionedPropertyId(`Интересует объект №${cardProp.shortId}`)).toBe(cardProp.id);
  });

  it("ссылка на сайт точнее отличающегося числа в тексте", async () => {
    const id = await resolveMentionedPropertyId(
      `объект №${crmLinkProp.shortId} https://royalhome.tj/listing/${cardProp.shortId}`
    );
    expect(id).toBe(siteProp.id);
  });
});
