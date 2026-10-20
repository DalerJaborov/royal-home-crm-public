import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { prisma } = await import("../src/db.js");
const { showPropertyToClient, canShowPropertyCard, recentlyShownShortIds } = await import(
  "../src/messengers/propertyShowcase.js"
);

/**
 * Карточка объекта в чате на сайте (владелец 23.08.2026: «красивая карточка с
 * фото и ценой... чтобы не выходя из чата клиент мог узнать»). У сайта нет
 * транспорта для настоящих фотографий (см. websiteChat.ts) — вместо них
 * showPropertyToClient должен вернуть готовые данные для отрисовки карточки,
 * а не пытаться отправить что-либо в несуществующий канал.
 */

const runId = Date.now();
const RECIPIENT = `website-session-${runId}`;

let districtId: string;
let intakeAgentId: string;
let propertyId: string;
let propertyShortId: number;

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-карточка-${runId}` } })).id;
  intakeAgentId = (
    await prisma.agent.create({
      data: { fullName: "Агент карточки", phone: `+992917${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;

  const property = await prisma.property.create({
    data: {
      title: `Объект карточки ${runId}`,
      type: "APARTMENT",
      areaSqm: 72,
      rooms: 2,
      price: 55_000,
      currency: "USD",
      districtId,
      address: "Проверочная, 5",
      condition: "GOOD",
      status: "AVAILABLE",
      publishedOnSite: true,
      intakeAgentId,
      // Есть и Instagram-пост — чтобы убедиться, что канал сайта его игнорирует
      // (в отличие от Meta, где пост обычно перебивает карточку CRM).
      instagramUrl: `https://instagram.com/p/card-test-${runId}`,
    },
  });
  propertyId = property.id;
  propertyShortId = property.shortId;
});

afterAll(async () => {
  await prisma.propertyExposure.deleteMany({ where: { recipientId: RECIPIENT } });
  await prisma.shownProperty.deleteMany({ where: { recipientId: RECIPIENT } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: intakeAgentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("канал WEBSITE умеет карточку объекта", () => {
  it("canShowPropertyCard — да у WEBSITE, да у Meta-каналов, нет у Telegram", () => {
    expect(canShowPropertyCard("WEBSITE")).toBe(true);
    expect(canShowPropertyCard("INSTAGRAM")).toBe(true);
    expect(canShowPropertyCard("WHATSAPP")).toBe(true);
    expect(canShowPropertyCard("TELEGRAM")).toBe(false);
  });

  it("showPropertyToClient на WEBSITE возвращает готовую карточку, а не ссылку/вложения", async () => {
    const result = await showPropertyToClient("WEBSITE", RECIPIENT, propertyShortId);
    expect(result.attachments).toEqual([]);
    expect(result.link).toBeNull();
    expect(result.websiteCard).toBeTruthy();

    const card = result.websiteCard!;
    expect(card.shortId).toBe(propertyShortId);
    expect(card.title).toBe("2-комн");
    // toLocaleString("ru-RU") разделяет тысячи неразрывным пробелом (U+00A0) —
    // сравниваем по цифрам и валюте, а не байт-в-байт с обычным пробелом.
    expect(card.price.replace(/\s/g, " ")).toBe("55 000 $");
    expect(card.rooms).toBe(2);
    expect(card.areaSqm).toBe(72);
    expect(card.district).toBe(`Тест-карточка-${runId}`);
    expect(card.address).toBe("Проверочная, 5");
    // Сайт всегда получает ссылку на карточку CRM, даже если Instagram-пост есть —
    // это уже проверено отдельно в property-link-website-channel.test.ts для
    // propertyLink(), здесь важно, что и сама карточка не тянет Instagram внутрь.
    expect(card.siteUrl).toContain(propertyId);
    expect(card.siteUrl).not.toContain("instagram.com");
  });

  it("журнал показов и недельный дедуп работают для сайта так же, как для Meta", async () => {
    // Первый показ уже случился в предыдущем тесте — запись должна быть.
    const exposures = await prisma.propertyExposure.findMany({ where: { recipientId: RECIPIENT } });
    expect(exposures).toHaveLength(1);
    expect(exposures[0].shortId).toBe(propertyShortId);

    const shownIds = await recentlyShownShortIds("WEBSITE", RECIPIENT);
    expect(shownIds).toContain(propertyShortId);

    // Повторный показ в течение недели — карточки нет, дедуп не даёт показать
    // тот же объект второй раз подряд.
    const second = await showPropertyToClient("WEBSITE", RECIPIENT, propertyShortId);
    expect(second.websiteCard ?? null).toBeNull();
  });
});
