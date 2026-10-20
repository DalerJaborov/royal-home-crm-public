import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { WA_FIRST_CONTACT_BUTTON, WA_FIRST_CONTACT_TEMPLATES, renderWaFirstContactText, toWhatsAppRecipient } from "@royal-home/shared";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { parseIncoming, parseStatusUpdates } from "../src/messengers/meta.js";
import {
  __setWaTemplateTransportForTests,
  buildTemplateCreateBody,
  buildTemplateSendBody,
  describeMetaError,
  noteFirstContactDelivery,
  noteFirstContactReply,
  rememberBusinessAccountFromWebhook,
  reviewsFromMetaRows,
  type MetaTemplateRow,
  type WaTemplateTransport,
} from "../src/lib/whatsappFirstContact.js";
import { waitFor } from "./helpers/waitFor.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * «Написать первым в WhatsApp» (24.09.2026). Meta подменена транспортом — общая
 * строка Settings не трогается (тесты сервера идут в два процесса на одной базе).
 */

const runId = Date.now();
const tail = String(runId).slice(-7);
const password = "testpass123";
/** Девять цифр таджикского номера — в той же записи, что у живых клиентов. */
const clientPhone = `+992 95${tail}`;
const recipient = `99295${tail}`;
const noWaPhone = `+992 94${tail}`;
const noWaRecipient = `99294${tail}`;

let ownAgentId: string;
let otherAgentId: string;
let ownToken: string;
let otherToken: string;
let clientId: string;
let noWaClientId: string;
let districtId: string;
let propertyId: string;
let propertyShortId: number;
let whatsapp: CustomerMessengerFixture;

// ─── Подменённая Meta ───────────────────────────────────────────────────────

let templateRows: MetaTemplateRow[] = [];
let connected = true;
let sendError: Error | null = null;
const sent: { to: string; name: string; params: string[] }[] = [];
/** Что сделать ВНУТРИ отправки, пока она ещё не вернулась. */
let duringSend: (() => Promise<void>) | null = null;
const created: string[] = [];
let nextMessageId = 0;

const fakeMeta: WaTemplateTransport = {
  async config() {
    return connected ? { phoneId: whatsapp.externalId, token: whatsapp.token, businessAccountId: "WABA" } : null;
  },
  async send(_config, to, name, params) {
    expect(_config).toMatchObject({ phoneId: whatsapp.externalId, token: whatsapp.token });
    // Заглянуть в базу РОВНО В МОМЕНТ отправки — так проверяется, что строка-замок
    // заведена до неё, а не после (см. «замок до отправки» ниже).
    if (duringSend) await duringSend();
    if (sendError) throw sendError;
    sent.push({ to, name, params });
    return { messageId: `wamid.test-${runId}-${++nextMessageId}` };
  },
  async list() {
    return templateRows;
  },
  async create(_config, key) {
    created.push(key);
    templateRows.push({ name: WA_FIRST_CONTACT_TEMPLATES[key].name, language: "ru", status: "PENDING", category: "UTILITY" });
  },
};

function approveAll() {
  templateRows = Object.values(WA_FIRST_CONTACT_TEMPLATES).map((t) => ({ name: t.name, language: "ru", status: "APPROVED", category: "UTILITY" }));
  __setWaTemplateTransportForTests(fakeMeta); // сброс кэша статусов
}

async function status(token: string, id: string) {
  return request(app).get(`/api/v1/clients/${id}/whatsapp-first`).set("Authorization", `Bearer ${token}`);
}

async function send(token: string, id: string, body: object = {}) {
  return request(app).post(`/api/v1/clients/${id}/whatsapp-first`).set("Authorization", `Bearer ${token}`).send(body);
}

beforeAll(async () => {
  whatsapp = await createCustomerMessengerFixture("WHATSAPP");
  __setWaTemplateTransportForTests(fakeMeta);
  const passwordHash = await bcrypt.hash(password, 10);
  const own = await prisma.agent.create({
    data: { fullName: "Сурайё Тестова", phone: `+992927${runId}`, role: "AGENT", passwordHash },
  });
  const other = await prisma.agent.create({
    data: { fullName: "Чужой Агент", phone: `+992926${runId}`, role: "AGENT", passwordHash },
  });
  ownAgentId = own.id;
  otherAgentId = other.id;

  // Номера короткие и могли остаться от прошлого прогона — убрать своё до создания.
  await prisma.client.deleteMany({ where: { phone: { in: [clientPhone, noWaPhone] } } });
  clientId = (
    await prisma.client.create({
      data: { fullName: `Фаррух ${runId}`, phone: clientPhone, source: "PHONE_CALL", assignedAgentId: ownAgentId, acceptedAt: new Date() },
    })
  ).id;
  noWaClientId = (
    await prisma.client.create({
      data: { fullName: `Без WhatsApp ${runId}`, phone: noWaPhone, source: "PHONE_CALL", assignedAgentId: ownAgentId, acceptedAt: new Date() },
    })
  ).id;

  districtId = (await prisma.district.create({ data: { name: `Первое сообщение ${runId}` } })).id;
  const property = await prisma.property.create({
    data: {
      title: `Первое сообщение ${runId}`,
      type: "APARTMENT",
      areaSqm: 60,
      price: 400000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 3",
      condition: "GOOD",
    } as never,
  });
  propertyId = property.id;
  propertyShortId = property.shortId;

  for (const [phone, set] of [
    [own.phone, (t: string) => (ownToken = t)],
    [other.phone, (t: string) => (otherToken = t)],
  ] as const) {
    const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
    expect(res.status).toBe(200);
    set(res.body.accessToken);
  }
});

afterEach(() => {
  sendError = null;
  connected = true;
  duringSend = null;
});

afterAll(async () => {
  __setWaTemplateTransportForTests(null);
  const clientIds = [clientId, noWaClientId];
  await prisma.whatsAppFirstContact.deleteMany({ where: { clientId: { in: clientIds } } });
  await whatsapp?.dispose();
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.notification.deleteMany({ where: { agentId: { in: [ownAgentId, otherAgentId] } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: [ownAgentId, otherAgentId] } } });
  await prisma.$disconnect();
});

// ─── Чистые части ───────────────────────────────────────────────────────────

describe("тексты и запросы к Meta", () => {
  it("предпросмотр совпадает с тем, что уйдёт: подстановки на месте, фигурных скобок нет", () => {
    const text = renderWaFirstContactText("property", ["Сурайё", "475"]);
    expect(text).toContain("Это Сурайё, агентство недвижимости Royal Home");
    expect(text).toContain("по объекту №475");
    expect(text).not.toMatch(/\{\{/);
  });

  it("у каждой переменной есть пример, и переменная не стоит первой или последней — правила Meta", () => {
    for (const t of Object.values(WA_FIRST_CONTACT_TEMPLATES)) {
      const vars = t.body.match(/\{\{\d+\}\}/g) ?? [];
      expect(vars.length).toBe(t.examples.length);
      expect(t.body.trim().startsWith("{{")).toBe(false);
      expect(t.body.trim().endsWith("}}")).toBe(false);
      expect(t.body).not.toMatch(/\}\}\s*\{\{/);
      expect(t.name).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it("запрос на одобрение: текст, примеры и кнопка «Да, присылайте»", () => {
    const body = buildTemplateCreateBody("property");
    expect(body.language).toBe("ru");
    expect(body.components[0]).toMatchObject({ type: "BODY", example: { body_text: [["Сурайё", "475"]] } });
    expect(body.components[1]).toMatchObject({ type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: WA_FIRST_CONTACT_BUTTON }] });
  });

  it("отправка: одобренный текст по имени, подстановки по порядку", () => {
    const body = buildTemplateSendBody("992951234567", "royalhome_first_contact_object", ["Сурайё", "475"]);
    expect(body).toMatchObject({
      messaging_product: "whatsapp",
      to: "992951234567",
      type: "template",
      template: {
        name: "royalhome_first_contact_object",
        language: { code: "ru" },
        components: [{ type: "body", parameters: [{ type: "text", text: "Сурайё" }, { type: "text", text: "475" }] }],
      },
    });
  });

  it("номер для WhatsApp: три таджикские записи и иностранный с кодом страны", () => {
    expect(toWhatsAppRecipient("+992 95 123 45 67")).toBe("992951234567");
    expect(toWhatsAppRecipient("0951234567")).toBe("992951234567");
    expect(toWhatsAppRecipient("951234567")).toBe("992951234567");
    expect(toWhatsAppRecipient("+7 916 123-45-67")).toBe("79161234567");
    expect(toWhatsAppRecipient("12345")).toBeNull();
    expect(toWhatsAppRecipient(null)).toBeNull();
  });

  it("статусы Meta переводятся в наши: одобрен, на проверке, отклонён с причиной, нет", () => {
    const reviews = reviewsFromMetaRows([
      { name: "royalhome_first_contact", language: "ru", status: "APPROVED" },
      { name: "royalhome_first_contact_object", language: "ru", status: "REJECTED", rejected_reason: "INVALID_FORMAT" },
      { name: "royalhome_first_contact", language: "en", status: "PENDING" },
    ]);
    expect(reviews.find((r) => r.key === "general")?.state).toBe("approved");
    expect(reviews.find((r) => r.key === "property")).toMatchObject({ state: "rejected", reason: "INVALID_FORMAT" });
    expect(reviewsFromMetaRows([]).every((r) => r.state === "missing")).toBe(true);
  });

  it("ошибки Meta — словами для агента", () => {
    expect(describeMetaError(new Error('Graph API HTTP 400: {"error":{"code":131026}}'))).toMatch(/нет WhatsApp/);
    expect(describeMetaError("", 131042)).toMatch(/карту/);
    expect(describeMetaError(new Error('Graph API HTTP 400: {"error":{"message":"Something odd","code":999}}'))).toBe("Something odd");
  });

  it("нажатие кнопки под текстом приходит словами, а не пустым вложением", () => {
    const [msg] = parseIncoming({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA",
          changes: [
            {
              value: {
                metadata: { phone_number_id: "PHONE" },
                messages: [{ id: "wamid.btn", from: recipient, type: "button", button: { text: "Да, присылайте", payload: "Да, присылайте" } }],
              },
            },
          ],
        },
      ],
    });
    expect(msg.text).toBe("Да, присылайте");
    expect(msg.attachmentType).toBeUndefined();
  });

  it("код ошибки доставки доезжает до разбора статуса", () => {
    const [s] = parseStatusUpdates({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: { statuses: [{ id: "wamid.x", status: "failed", recipient_id: recipient, errors: [{ code: 131026, title: "Message undeliverable" }] }] } }] }],
    });
    expect(s).toMatchObject({ status: "failed", errorCode: 131026 });
  });
});

// ─── Кнопка в карточке ──────────────────────────────────────────────────────

describe("кнопка «Написать в WhatsApp»", () => {
  it("чужому клиенту — нельзя", async () => {
    expect((await status(otherToken, clientId)).status).toBe(403);
    expect((await send(otherToken, clientId)).status).toBe(403);
  });

  it("WhatsApp не подключён — честно так и сказано", async () => {
    connected = false;
    __setWaTemplateTransportForTests(fakeMeta);
    const res = await status(ownToken, clientId);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("not_connected");
  });

  it("пока Meta не одобрила текст — кнопка говорит об этом, отправки нет", async () => {
    templateRows = [];
    __setWaTemplateTransportForTests(fakeMeta);
    expect((await status(ownToken, clientId)).body.state).toBe("texts_missing");

    templateRows = [{ name: "royalhome_first_contact", language: "ru", status: "PENDING" }];
    __setWaTemplateTransportForTests(fakeMeta);
    expect((await status(ownToken, clientId)).body.state).toBe("texts_pending");

    const res = await send(ownToken, clientId);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/на проверке у Meta/);
    expect(sent).toHaveLength(0);
  });

  it("нет WhatsApp у номера — не дошло, причина словами, повторить можно", async () => {
    approveAll();
    sendError = new Error('Graph API HTTP 400: {"error":{"message":"Message undeliverable","code":131026}}');
    const res = await send(ownToken, noWaClientId);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/нет WhatsApp/);
    const row = await prisma.whatsAppFirstContact.findFirst({ where: { clientId: noWaClientId } });
    expect(row).toMatchObject({ status: "FAILED", recipient: noWaRecipient });
    sendError = null;
    const again = await status(ownToken, noWaClientId);
    expect(again.body.state).toBe("ready");
    expect(again.body.last).toMatchObject({ status: "FAILED" });
  });

  it("отправка про объект: текст с номером объекта, переписка заведена, бот на паузе, повтор закрыт", async () => {
    approveAll();
    expect((await status(ownToken, clientId)).body).toMatchObject({ state: "ready", propertyTextReady: true });
    const res = await send(ownToken, clientId, { propertyShortId });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("recently_sent");
    expect(sent.at(-1)).toEqual({ to: recipient, name: "royalhome_first_contact_object", params: ["Сурайё", String(propertyShortId)] });

    const conversation = await prisma.botConversation.findUnique({
      where: { channel_subscriberId: { channel: "WHATSAPP", subscriberId: recipient } },
    });
    expect(conversation?.clientId).toBe(clientId);
    expect(conversation?.pausedUntil?.getTime()).toBeGreaterThan(Date.now());
    const messages = conversation!.messages as { role: string; content: string; mid?: string; by?: { kind: string } }[];
    expect(messages.at(-1)).toMatchObject({ role: "assistant", by: { kind: "agent" } });
    expect(messages.at(-1)?.content).toContain(`по объекту №${propertyShortId}`);
    expect(messages.at(-1)?.mid).toMatch(/^wamid\.test-/);

    const timeline = await prisma.interaction.findFirst({ where: { clientId, notes: { contains: "Первое сообщение в WhatsApp" } } });
    expect(timeline?.propertyId).toBe(propertyId);

    const count = sent.length;
    const again = await send(ownToken, clientId);
    expect(again.status).toBe(409);
    expect(sent).toHaveLength(count);
  });

  it("клиент ответил — отметка «ответил», сотруднику уведомление; повтор вебхука второго не шлёт", async () => {
    await noteFirstContactReply(recipient, "Да, присылайте");
    const row = await prisma.whatsAppFirstContact.findFirst({ where: { clientId, status: { not: "FAILED" } }, orderBy: { sentAt: "desc" } });
    expect(row).toMatchObject({ status: "REPLIED" });
    expect(row?.repliedAt).not.toBeNull();

    const tag = `wa-first-contact-${row!.id}`;
    await waitFor(() => prisma.notification.count({ where: { agentId: ownAgentId, tag } }), { label: "уведомление об ответе" });
    await noteFirstContactReply(recipient, "Да, присылайте");
    expect(await prisma.notification.count({ where: { agentId: ownAgentId, tag } })).toBe(1);
  });

  it("клиента передали после первого сообщения — уведомление об ответе нынешнему агенту (B9, 02.10)", async () => {
    const row = await prisma.whatsAppFirstContact.create({
      data: { clientId, agentId: ownAgentId, recipient, templateName: "royalhome_first_contact", status: "DELIVERED" },
    });
    await prisma.client.update({ where: { id: clientId }, data: { assignedAgentId: otherAgentId } });
    try {
      await noteFirstContactReply(recipient, "Салом");
      const tag = `wa-first-contact-${row.id}`;
      await waitFor(() => prisma.notification.count({ where: { agentId: otherAgentId, tag } }), { label: "уведомление держателю" });
      expect(await prisma.notification.count({ where: { agentId: ownAgentId, tag } })).toBe(0);
    } finally {
      await prisma.client.update({ where: { id: clientId }, data: { assignedAgentId: ownAgentId } });
    }
  });

  it("клиент писал меньше суток назад — одобренный текст не нужен, пишите в переписке", async () => {
    await prisma.botConversation.update({
      where: { channel_subscriberId: { channel: "WHATSAPP", subscriberId: recipient } },
      data: { messages: [{ role: "user", content: "Да, присылайте", at: new Date().toISOString() }] },
    });
    const res = await status(ownToken, clientId);
    expect(res.body.state).toBe("window_open");
  });

  it("«не дошло» от Meta позже отправки — строка помечена, причина словами", async () => {
    await prisma.botConversation.deleteMany({ where: { subscriberId: noWaRecipient } });
    approveAll();
    const res = await send(ownToken, noWaClientId);
    expect(res.status).toBe(200);
    const row = await prisma.whatsAppFirstContact.findFirst({ where: { clientId: noWaClientId, status: "SENT" } });
    await noteFirstContactDelivery(row!.waMessageId!, "failed", 131026, "Message undeliverable");
    const after = await prisma.whatsAppFirstContact.findUnique({ where: { id: row!.id } });
    expect(after).toMatchObject({ status: "FAILED" });
    expect(after?.failReason).toMatch(/нет WhatsApp/);
    // «Доставлено», пришедшее следом, отказ не отменяет.
    await noteFirstContactDelivery(row!.waMessageId!, "delivered");
    expect((await prisma.whatsAppFirstContact.findUnique({ where: { id: row!.id } }))?.status).toBe("FAILED");
  });
});

describe("текст «про объект» ещё не одобрен", () => {
  it("с номером объекта уходит общий текст, а объект запомнен — ссылка придёт после ответа", async () => {
    templateRows = [
      { name: "royalhome_first_contact", language: "ru", status: "APPROVED" },
      { name: "royalhome_first_contact_object", language: "ru", status: "PENDING" },
    ];
    __setWaTemplateTransportForTests(fakeMeta);
    const before = await status(ownToken, noWaClientId);
    expect(before.body).toMatchObject({ state: "ready", propertyTextReady: false });
    const res = await send(ownToken, noWaClientId, { propertyShortId });
    expect(res.status).toBe(200);
    expect(sent.at(-1)).toMatchObject({ name: "royalhome_first_contact", params: ["Сурайё"] });
    const row = await prisma.whatsAppFirstContact.findFirst({ where: { clientId: noWaClientId }, orderBy: { sentAt: "desc" } });
    expect(row).toMatchObject({ status: "SENT", propertyId, templateName: "royalhome_first_contact" });
  });
});

describe("Настройки: тексты у Meta", () => {
  it("рядовой агент тексты в Meta не отправляет и кабинет не меняет", async () => {
    const submit = await request(app).post("/api/v1/whatsapp-templates/submit").set("Authorization", `Bearer ${ownToken}`);
    expect(submit.status).toBe(403);
    const account = await request(app)
      .patch("/api/v1/whatsapp-templates/account")
      .set("Authorization", `Bearer ${ownToken}`)
      .send({ businessAccountId: "123" });
    expect(account.status).toBe(403);
  });

  it("отправка на проверку: недостающий текст уходит, одобренный — нет", async () => {
    const { submitWaTemplates } = await import("../src/lib/whatsappFirstContact.js");
    templateRows = [{ name: "royalhome_first_contact", language: "ru", status: "APPROVED" }];
    created.length = 0;
    __setWaTemplateTransportForTests(fakeMeta);
    const overview = await submitWaTemplates();
    expect(created).toEqual(["property"]);
    expect(overview.templates.find((t) => t.key === "property")?.state).toBe("pending");
    expect(overview.templates.find((t) => t.key === "general")?.state).toBe("approved");
  });

  it("кабинет WhatsApp запоминается из вебхука только для нашего номера и только в пустое поле", async () => {
    const before = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaWaBusinessAccountId: true } });
    if (before?.metaWaBusinessAccountId) return; // заполнено руками — перетирать нельзя, проверять нечего
    try {
      await rememberBusinessAccountFromWebhook(
        { object: "whatsapp_business_account", entry: [{ id: `SANDBOX-${runId}`, changes: [{ value: { metadata: { phone_number_id: "OTHER" } } }] }] },
        ["PHONE"]
      );
      expect((await prisma.settings.findUnique({ where: { id: "singleton" } }))?.metaWaBusinessAccountId ?? null).toBeNull();
      await rememberBusinessAccountFromWebhook(
        { object: "whatsapp_business_account", entry: [{ id: `WABA-${runId}`, changes: [{ value: { metadata: { phone_number_id: "PHONE" } } }] }] },
        ["PHONE"]
      );
      expect((await prisma.settings.findUnique({ where: { id: "singleton" } }))?.metaWaBusinessAccountId).toBe(`WABA-${runId}`);
    } finally {
      await prisma.settings.updateMany({ where: { id: "singleton", metaWaBusinessAccountId: `WABA-${runId}` }, data: { metaWaBusinessAccountId: null } });
    }
  });
});

/**
 * ЗАМОК ДО ОТПРАВКИ (25.09.2026, разбор класса «запись сначала, маркер потом»).
 *
 * Было: шаблон уходил клиенту, а строка «отправлено» писалась только после трёх
 * ожиданий подряд. Падение любого из них — и строки нет, а гейт смотрит именно
 * её: второе платное сообщение уходило тому же человеку. Тесты ниже проверяют
 * обе стороны замка — что он стоит ДО отправки и что отказ его снимает.
 */
describe("замок первого сообщения", () => {
  const lockTail = `${tail}1`;
  const lockPhone = `+992 93${lockTail}`;
  const lockRecipient = `99293${lockTail}`;
  let lockClientId: string;

  async function clearOwnLockConversation() {
    const rows = await prisma.botConversation.findMany({ where: {
      endpointScopeId: whatsapp.transport.endpointScopeId, subscriberId: lockRecipient,
    }, select: { id: true } });
    await prisma.botConversation.deleteMany({ where: { id: { in: rows.map(row => row.id) } } });
    // Deletion deliberately tombstones canonical state. This fixture reset
    // removes only its own no-action anchor; runtime must never reopen it silently.
    await prisma.customerInquiry.deleteMany({ where: { endpointScopeId: whatsapp.transport.endpointScopeId,
      peerId: lockRecipient, actions: { none: {} } } });
  }

  beforeAll(async () => {
    await prisma.client.deleteMany({ where: { phone: lockPhone } });
    lockClientId = (
      await prisma.client.create({
        data: { fullName: `Замок ${runId}`, phone: lockPhone, source: "PHONE_CALL", assignedAgentId: ownAgentId, acceptedAt: new Date() },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.whatsAppFirstContact.deleteMany({ where: { clientId: lockClientId } });
    await clearOwnLockConversation();
    await prisma.interaction.deleteMany({ where: { clientId: lockClientId } });
    await prisma.client.deleteMany({ where: { id: lockClientId } });
  });

  it("строка заведена ДО отправки, и в этот момент кнопка уже закрыта", async () => {
    approveAll();
    let seenDuringSend: { status: string; waMessageId: string | null } | null = null;
    let stateDuringSend: string | null = null;
    duringSend = async () => {
      const row = await prisma.whatsAppFirstContact.findFirst({ where: { clientId: lockClientId } });
      seenDuringSend = row ? { status: row.status, waMessageId: row.waMessageId } : null;
      stateDuringSend = (await status(ownToken, lockClientId)).body.state;
    };

    const res = await send(ownToken, lockClientId);
    expect(res.status).toBe(200);

    // Главное утверждение: в момент, когда Meta уже зовут, строка в базе есть —
    // значит упавшее ПОСЛЕ отправки второго сообщения не вызовет.
    expect(seenDuringSend).toMatchObject({ status: "SENT", waMessageId: null });
    expect(stateDuringSend).toBe("recently_sent");

    // Номер сообщения дописан в ТУ ЖЕ строку, второй не завелось.
    const rows = await prisma.whatsAppFirstContact.findMany({ where: { clientId: lockClientId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].waMessageId).toMatch(/^wamid\.test-/);
    expect(rows[0].conversationId).not.toBeNull();
  });

  it("отправка сорвалась — замок снят одной строкой FAILED, повтор проходит сразу", async () => {
    approveAll();
    await prisma.whatsAppFirstContact.deleteMany({ where: { clientId: lockClientId } });
    sendError = new Error('Graph API HTTP 400: {"error":{"message":"Message undeliverable","code":131026}}');

    const res = await send(ownToken, lockClientId);
    expect(res.status).toBe(502);
    sendError = null;

    // Одна строка, а не замок плюс отдельная запись об отказе.
    const rows = await prisma.whatsAppFirstContact.findMany({ where: { clientId: lockClientId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "FAILED", waMessageId: null });
    expect((await status(ownToken, lockClientId)).body.state).toBe("ready");
  });

  it("процесс умер между замком и отправкой — через пять минут замок протух, раньше держит", async () => {
    approveAll();
    await prisma.whatsAppFirstContact.deleteMany({ where: { clientId: lockClientId } });
    // Строка-замок без номера сообщения: ровно то, что осталось бы от убитого процесса.
    const stale = await prisma.whatsAppFirstContact.create({
      data: { clientId: lockClientId, agentId: ownAgentId, recipient: lockRecipient, templateName: "royalhome_first_contact" },
    });

    expect((await status(ownToken, lockClientId)).body.state).toBe("recently_sent");

    await prisma.whatsAppFirstContact.update({
      where: { id: stale.id },
      data: { sentAt: new Date(Date.now() - 6 * 60_000) },
    });
    expect((await status(ownToken, lockClientId)).body.state).toBe("ready");
  });

  it("настоящая отправка держит кнопку закрытой и через пять минут — протухание только без номера", async () => {
    approveAll();
    await prisma.whatsAppFirstContact.deleteMany({ where: { clientId: lockClientId } });
    await clearOwnLockConversation();
    expect((await send(ownToken, lockClientId)).status).toBe(200);

    const row = await prisma.whatsAppFirstContact.findFirstOrThrow({ where: { clientId: lockClientId } });
    await prisma.whatsAppFirstContact.update({
      where: { id: row.id },
      data: { sentAt: new Date(Date.now() - 6 * 60_000) },
    });
    expect((await status(ownToken, lockClientId)).body.state).toBe("recently_sent");
  });
});
