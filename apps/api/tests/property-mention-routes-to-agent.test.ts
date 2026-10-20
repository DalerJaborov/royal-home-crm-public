import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";

/**
 * КЛИЕНТ НАЗВАЛ НОМЕР ОБЪЕКТА В ЧАТЕ — ЛИД УХОДИТ ХОЗЯИНУ (решение владельца
 * 23.09.2026, пункт 8 списка после публикаций: «объект №112», без кода
 * агента). Распознавание номера (ai/propertyMentionGuard.ts) и сама лесенка
 * «объект назван явно» (services/leads/assignment.ts) проверены отдельно —
 * здесь стережём именно СТЫК: слово клиента в чате доходит до
 * LeadDraft.requestedPropertyId и оттуда до заявки, тем же путём, что уже
 * работает для ссылки с сайта и подсказки из звонка.
 *
 * Модель подменена: тест про решение кода, а не про качество ответа.
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const { prisma } = await import("../src/db.js");
const { processMessengerTurn } = await import("../src/messengers/conversation.js");

const runId = Date.now().toString(36);
const subscriberId = `propmention-${runId}`;

let ownerId: string;
let propertyId: string;
let propertyShortId: number;
// Объект, рождённый на сайте: его siteListingId нарочно равен номеру карточки выше.
let siteOwnerId: string;
let siteOwnedPropertyId: string;
const linkSubscriberId = `propmention-link-${runId}`;
const orphanLinkSubscriberId = `propmention-orphan-${runId}`;
let districtId: string;
let whatsapp: CustomerMessengerFixture;
/**
 * Рабочие часы фиксируются наравне с задержкой ответа бота. Вне окна
 * (Settings.workHoursStart/End, по умолчанию 09:30–18:00 по Душанбе) заявка
 * намеренно уходит в общую очередь без агента — `deferAssignment` в
 * messengers/conversation.ts, — и лесенка «объект назван явно» не зовётся вовсе.
 * Без этой фиксации тест зелёный днём и красный после 18:00 по Душанбе
 * (13:00 UTC): именно так он и упал 23.09.2026, притом что код исправен.
 */
let settingsBefore: {
  botReplyDelaySec: number;
  botReplyMaxWaitSec: number;
  workHoursStart: string;
  workHoursEnd: string;
} | null = null;

beforeAll(async () => {
  whatsapp = await createCustomerMessengerFixture("WHATSAPP");
  const s = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true, workHoursStart: true, workHoursEnd: true },
  });
  settingsBefore = s;
  await prisma.settings.update({
    where: { id: "singleton" },
    // Круглые сутки — это "00:00"–"24:00", а НЕ "00:00"–"23:59": минута 23:59 у
    // второго остаётся закрытой, и тест падает одну минуту в сутки
    // (isWithinDushanbeWindow → false, заявка уходит в общую очередь без агента).
    // "00:00"–"00:00" тоже нельзя: у isWithinDushanbeWindow пустое окно значит
    // «никогда». Разбор — docs/journal/2026-09-24-krugolosutochnoe-okno-24-00.md.
    data: { botReplyDelaySec: 1, botReplyMaxWaitSec: 3, workHoursStart: "00:00", workHoursEnd: "24:00" },
  });
  districtId = (await prisma.district.create({ data: { name: `Тест-объект-номер-${runId}` } })).id;
  ownerId = (
    await prisma.agent.create({
      data: { fullName: `Хозяин объекта ${runId}`, phone: `+992905${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  const property = await prisma.property.create({
    data: {
      title: `Объект по номеру ${runId}`,
      type: "APARTMENT",
      areaSqm: 60,
      rooms: 2,
      price: 500_000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 5",
      condition: "GOOD",
      status: "AVAILABLE",
      assignedAgentId: ownerId,
    },
  });
  propertyId = property.id;
  propertyShortId = property.shortId;
  siteOwnerId = (
    await prisma.agent.create({
      data: { fullName: `Хозяин объекта сайта ${runId}`, phone: `+992906${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  siteOwnedPropertyId = (
    await prisma.property.create({
      data: {
        title: `Объект сайта ${runId}`, type: "APARTMENT", areaSqm: 55, rooms: 2, price: 450_000, currency: "TJS",
        districtId, address: "Сайтовая, 7", condition: "GOOD", status: "AVAILABLE",
        assignedAgentId: siteOwnerId, siteListingId: propertyShortId,
      },
    })
  ).id;
});

afterAll(async () => {
  await drainBackgroundTasks(2000);
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  const convs = await prisma.botConversation.findMany({ where: { subscriberId: { in: [subscriberId, linkSubscriberId, orphanLinkSubscriberId] } }, select: { id: true, clientId: true } });
  for (const conv of convs) {
    if (conv.clientId) {
      await prisma.interaction.deleteMany({ where: { clientId: conv.clientId } });
      await prisma.client.deleteMany({ where: { id: conv.clientId } });
    }
  }
  await whatsapp.dispose();
  await prisma.property.deleteMany({ where: { id: { in: [propertyId, siteOwnedPropertyId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [ownerId, siteOwnerId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("клиент называет номер объекта в переписке — заявка уходит хозяину", () => {
  it("«объект №<N>», потом телефон — Client.assignedAgentId это хозяин объекта", async () => {
    callAi.mockClear();
    callAi.mockResolvedValue({
      reply: ["Да, объект ещё доступен. Как к вам обращаться и по какому телефону связаться?"],
      intent: "buy",
      confident: true,
      ready: false,
      topic: "other",
      openQuestion: "",
      clientAnsweredOpenQuestion: false,
    });
    await processMessengerTurn({
      ...whatsapp.turnInput(subscriberId),
      text: `Здравствуйте, интересует объект №${propertyShortId}`,
    });

    callAi.mockClear();
    callAi.mockResolvedValue({
      // Closing acknowledgement has its own text-only endpoint; the full
      // submit_reply boundary also accepts this string compatibility form.
      reply: "Спасибо, наш агент свяжется с вами.",
      intent: "buy",
      confident: true,
      ready: false,
      topic: "other",
      openQuestion: "",
      clientAnsweredOpenQuestion: false,
    });
    await processMessengerTurn({ ...whatsapp.turnInput(subscriberId), text: "Фаридун, 910001044" });

    const conv = await prisma.botConversation.findFirst({ where: { subscriberId }, select: { clientId: true } });
    expect(conv?.clientId).not.toBeNull();
    const client = await prisma.client.findUniqueOrThrow({ where: { id: conv!.clientId! } });
    // Именно ПРАВИЛО «объект назван явно», а не случайное совпадение с обычной
    // очередью: assignReason различает эти два случая (services/leads/intake.ts).
    expect(client.assignReason).toBe("own_property_explicit");
    expect(client.assignedAgentId).toBe(ownerId);
  });

  /**
   * КНОПКА WHATSAPP НА САЙТЕ (19.10.2026): «Интересует объект №N: https://royalhome.tj/listing/N»,
   * где N — id объявления на САЙТЕ. Раньше N читалось как номер карточки CRM и лид
   * уходил хозяину чужого объекта №N.
   */
  // У каждого сценария свой телефон: иначе заявка склеится с клиентом предыдущего (дубль по номеру).
  async function leadAgentAfterSiteButton(sub: string, text: string, phone: string) {
    for (const [t, reply] of [[text, ["Да, объект доступен. Как к вам обращаться и по какому телефону связаться?"]], [`Фаридун, ${phone}`, "Спасибо, наш агент свяжется с вами."]] as const) {
      callAi.mockClear();
      callAi.mockResolvedValue({
        reply, intent: "buy", confident: true, ready: false, topic: "other",
        openQuestion: "", clientAnsweredOpenQuestion: false,
      });
      await processMessengerTurn({ ...whatsapp.turnInput(sub), text: t });
    }
    const conv = await prisma.botConversation.findFirst({ where: { subscriberId: sub }, select: { clientId: true } });
    expect(conv?.clientId).not.toBeNull();
    return prisma.client.findUniqueOrThrow({ where: { id: conv!.clientId! } });
  }

  it("ссылка сайта /listing/N выигрывает у «объект №N»: лид уходит хозяину объекта сайта, а не карточки №N", async () => {
    const client = await leadAgentAfterSiteButton(
      linkSubscriberId,
      `Здравствуйте! Интересует объект №${propertyShortId}: https://royalhome.tj/listing/${propertyShortId}`,
      "918203041"
    );
    expect(client.assignReason).toBe("own_property_explicit");
    expect(client.assignedAgentId).toBe(siteOwnerId);
    expect(client.assignedAgentId).not.toBe(ownerId);
  });

  it("ссылка сайта без объекта с таким id: «№N» не уводит лид хозяину чужой карточки №N", async () => {
    // Выкидываем привязку к сайту: объект с siteListingId = N в CRM больше нет.
    await prisma.property.update({ where: { id: siteOwnedPropertyId }, data: { siteListingId: null } });
    const client = await leadAgentAfterSiteButton(
      orphanLinkSubscriberId,
      `Здравствуйте! Интересует объект №${propertyShortId}: https://royalhome.tj/listing/${propertyShortId}`,
      "918203042"
    );
    // Не «объект назван явно»: общая лесенка может выбрать кого угодно, но не по номеру чужой карточки.
    expect(client.assignReason).not.toBe("own_property_explicit");
  });
});
