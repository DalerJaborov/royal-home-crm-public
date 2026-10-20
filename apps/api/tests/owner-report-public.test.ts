import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { OWNER_REPORT_TOPIC_KEYS, type OwnerReportResponse } from "@royal-home/shared";
import { waitFor, waitForSettled } from "./helpers/waitFor.js";

/**
 * «Отчёт владельцу объекта»: POST/GET/DELETE /properties/:id/owner-report-link (с входом)
 * и публичный GET /api/v1/public/owner-report/:token (без входа). Главное, что файл обязан
 * ловить: на публичной странице нет НИ ОДНОГО поля из закрытого списка — телефонов, имён
 * клиентов и конкурентов, адреса, документов, денег рекламы и комиссии, цен других объектов.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { dushanbeStartOfToday } = await import("../src/lib/dushanbeTime.js");
const { loadOwnerReport } = await import("../src/lib/ownerReport/load.js");
const { shareSaleStatus } = await import("../src/routes/propertyShare.js");
const {
  cachedOwnerReport,
  shouldCountOwnerReportView,
  resetOwnerReportServeState,
  ownerReportCacheSize,
  OWNER_REPORT_CACHE_MAX_ENTRIES,
  OWNER_REPORT_CACHE_TTL_MS,
  OWNER_REPORT_VIEW_COUNT_INTERVAL_MS,
} = await import("../src/lib/ownerReport/cache.js");

const runId = Date.now();
const password = "testpass123";
const ownerContact = `+992938${runId.toString().slice(-6)}`;
const clientPhone = `+992939${runId.toString().slice(-6)}`;
const clientName = `Секретов Клиент${runId}`;
const rivalName = `Конкурентов Агент${runId}`;
const secretAddress = `Улица Секретная ${runId}, 5`;
const secretDocuments = `секретные документы ${runId}`;
const otherPropertyTitle = `Чужой объект ${runId}`;
const otherPropertyPrice = 7_777_777;
// Тексты, которым нельзя оказаться на публичной странице: возражение из разбора звонка и
// цитата/итог «голоса клиента после показа» (все с именем и телефоном внутри).
const objectionSecret = `ВОЗРАЖЕНИЕ-СЕКРЕТ-${runId}`;
const quoteSecret = `ЦИТАТА-ПОСЛЕ-ПОКАЗА-${runId}`;
const postSummarySecret = `ИТОГ-ПОСЛЕ-ПОКАЗА-${runId}`;
const failedClientName = `Недозвонов Клиент${runId}`;
const AD_SPEND = 8421.37;
const PUBLIC = "/api/v1/public/owner-report";

let districtId = "";
let agentId = "";
let agentToken = "";
let otherAgentToken = "";
let propertyId = "";
let propertyShortId = 0;
let otherPropertyId = "";
let clientId = "";
let failedClientId = "";
let adId = "";
const agentIds: string[] = [];
const propertyIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

const link = (id: string) => `/api/v1/properties/${id}/owner-report-link`;
const post = (id: string, token = agentToken) => request(app).post(link(id)).set("Authorization", `Bearer ${token}`);
const tokenOf = (url: string) => url.split("/o/")[1];

/** Похоже на телефон: семь цифр подряд после выбрасывания пробелов, дат и runId фикстуры. */
function looksLikePhone(s: string): boolean {
  const stripped = s
    .replaceAll(String(runId), "")
    .replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?/g, "")
    .replace(/[\s()+-]/g, "");
  return /\d{7,}/.test(stripped);
}

/** Все строковые ключи и значения JSON — для проверки «запрещённого нет нигде». */
function walk(value: unknown, keys: string[], strings: string[]) {
  if (typeof value === "string") strings.push(value);
  else if (Array.isArray(value)) value.forEach((v) => walk(v, keys, strings));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      keys.push(k);
      walk(v, keys, strings);
    }
  }
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-отчёт-${runId}`, city: "Душанбе" } })).id;
  const agent = await prisma.agent.create({
    data: { fullName: `Агент отчёт ${runId}`, phone: `+992941${runId}`, role: "AGENT", passwordHash },
  });
  const other = await prisma.agent.create({
    data: { fullName: `Чужой агент отчёт ${runId}`, phone: `+992942${runId}`, role: "AGENT", passwordHash },
  });
  const rival = await prisma.agent.create({
    data: { fullName: rivalName, phone: `+992943${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  agentIds.push(agent.id, other.id, rival.id);

  const property = await prisma.property.create({
    data: {
      title: `Квартира отчёт ${runId}`,
      type: "APARTMENT",
      areaSqm: 55,
      rooms: 2,
      price: 650_000,
      currency: "TJS",
      districtId,
      address: secretAddress,
      condition: "GOOD",
      status: "AVAILABLE",
      intakeAgentId: agentId,
      createdById: agentId,
      assignedAgentId: agentId,
      ownerContact,
      documents: secretDocuments,
    },
  });
  propertyId = property.id;
  propertyShortId = property.shortId;
  propertyIds.push(property.id);
  const otherProperty = await prisma.property.create({
    data: {
      title: otherPropertyTitle,
      type: "APARTMENT",
      areaSqm: 40,
      price: otherPropertyPrice,
      currency: "TJS",
      districtId,
      address: "Другая, 1",
      condition: "GOOD",
      status: "AVAILABLE",
      intakeAgentId: rival.id,
      createdById: rival.id,
      assignedAgentId: rival.id,
    },
  });
  otherPropertyId = otherProperty.id;
  propertyIds.push(otherProperty.id);

  clientId = (
    await prisma.client.create({
      data: { fullName: clientName, phone: clientPhone, source: "PHONE_CALL", assignedAgentId: agentId },
    })
  ).id;

  // Люди, интерес, показы клиентам.
  await prisma.propertyInterestEvent.createMany({
    data: [
      { propertyId, kind: "SHARE_SENT", clientId },
      { propertyId, kind: "SHARE_OPENED", clientId },
      { propertyId, kind: "COMMENT", externalAuthorId: `ext-${runId}`, externalAuthorName: clientName },
    ],
  });
  await prisma.propertyExposure.createMany({
    data: [
      { channel: "INSTAGRAM", recipientId: `r1-${runId}`, propertyId, shortId: propertyShortId, kind: "LINK" },
      { channel: "WHATSAPP", recipientId: `r2-${runId}`, propertyId, shortId: propertyShortId, kind: "PHOTO" },
    ],
  });
  // Комментарий и вопрос собственнику с телефоном и именем внутри — наружу уйдут только темы.
  await prisma.instagramComment.create({
    data: {
      commentId: `owner-report-${runId}`,
      mediaId: `media-${runId}`,
      authorId: `author-${runId}`,
      authorName: clientName,
      text: `Какая цена? Я ${clientName}, звоните ${clientPhone}`,
      replyDueAt: new Date(),
      status: "ESCALATED",
      propertyId,
    },
  });
  await prisma.ownerQuestion.create({
    data: { conversationId: `conv-${runId}`, propertyId, question: `Есть документы? Пишите на ${clientPhone}` },
  });
  // Обращение по объекту: клиент позвонил.
  await prisma.interaction.create({
    data: { clientId, agentId, type: "CALL", notes: `разговор с ${clientName}`, propertyId },
  });
  // Тот же человек пишет боту: диалог привязан к ЕГО карточке — это не второй человек.
  // Плюс диалог без карточки — отдельный человек. Итого людей по объекту: двое.
  const cardChat = await prisma.botConversation.create({
    data: { channel: "WHATSAPP", subscriberId: `sub-card-${runId}`, clientId },
  });
  const anonChat = await prisma.botConversation.create({
    data: { channel: "INSTAGRAM", subscriberId: `sub-anon-${runId}`, clientId: null },
  });
  await prisma.conversationProperty.createMany({
    data: [
      { conversationId: cardChat.id, propertyId, source: "EXPOSURE" },
      { conversationId: anonChat.id, propertyId, source: "LISTING_LINK" },
    ],
  });
  // Исходящая попытка агента «не дозвонился» к другому клиенту: на связь не вышел никто.
  failedClientId = (
    await prisma.client.create({
      data: {
        fullName: failedClientName,
        phone: `+992937${runId.toString().slice(-6)}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
      },
    })
  ).id;
  await prisma.interaction.create({
    data: { clientId: failedClientId, agentId, type: "CALL", notes: "не дозвонился", propertyId, outcome: "NO_ANSWER" },
  });
  // Разбор звонка с возражением и «голос клиента после показа» с цитатой: наружу не уходят.
  const analysedCall = await prisma.interaction.create({
    data: { clientId, agentId, type: "CALL", notes: "разбор звонка", propertyId, outcome: "NEUTRAL" },
  });
  await prisma.callAnalysis.create({
    data: {
      interactionId: analysedCall.id,
      agentId,
      propertyId,
      score: 60,
      summary: "итог звонка",
      objections: [`${objectionSecret}: дорого, ${clientName}, ${clientPhone}`],
    },
  });
  const showing = await prisma.interaction.create({
    data: { clientId, agentId, type: "SHOWING", notes: "показ", propertyId },
  });
  await prisma.postShowingCall.create({
    data: {
      showingId: showing.id,
      clientId,
      agentId,
      propertyId,
      scheduledFor: new Date(),
      status: "DONE",
      outcome: "NOT_SUITABLE",
      quote: `${quoteSecret}, звонил ${clientName} ${clientPhone}`,
      summary: `${postSummarySecret}, ${clientName}`,
      redFlags: [`красный флаг ${runId}`],
    },
  });
  // Реклама с деньгами — деньги наружу уйти не должны.
  adId = (
    await prisma.ad.create({
      data: { platform: "META", externalId: `owner-report-${runId}`, name: `Реклама отчёт ${runId}`, propertyId, lastSyncedAt: new Date() },
    })
  ).id;
  await prisma.adSpendDaily.create({
    data: { adId, date: new Date(), spend: AD_SPEND, currency: "TJS", impressions: 1000, clicks: 40, conversations: 5 },
  });
  // Сайт.
  await prisma.sitePropertyDay.create({ data: { propertyId, day: dushanbeStartOfToday(), views: 33, visitors: 20 } });

  agentToken = await login(`+992941${runId}`);
  otherAgentToken = await login(`+992942${runId}`);
});

afterAll(async () => {
  await prisma.callAnalysis.deleteMany({ where: { propertyId } });
  await prisma.postShowingCall.deleteMany({ where: { propertyId } });
  await prisma.adSpendDaily.deleteMany({ where: { adId } });
  await prisma.ad.deleteMany({ where: { id: adId } });
  await prisma.ownerQuestion.deleteMany({ where: { propertyId } });
  await prisma.instagramComment.deleteMany({ where: { propertyId } });
  await prisma.propertyExposure.deleteMany({ where: { propertyId } });
  await prisma.propertyInterestEvent.deleteMany({ where: { propertyId } });
  await prisma.interaction.deleteMany({ where: { agentId: { in: agentIds } } });
  // Свойство удаляется вместе со ссылками (Cascade) — до агентов, на которых ссылки ссылаются.
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.botConversation.deleteMany({
    where: { subscriberId: { in: [`sub-card-${runId}`, `sub-anon-${runId}`] } },
  });
  await prisma.client.deleteMany({ where: { id: { in: [clientId, failedClientId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("ссылка в карточке объекта", () => {
  it("401 без входа, 404 на несуществующий объект, 403 чужому агенту", async () => {
    expect((await request(app).post(link(propertyId)).send({})).status).toBe(401);
    expect((await post("00000000-0000-0000-0000-000000000000")).status).toBe(404);
    expect((await post(propertyId, otherAgentToken)).status).toBe(403);
    expect((await request(app).get(link(propertyId)).set("Authorization", `Bearer ${otherAgentToken}`)).status).toBe(403);
    expect((await request(app).delete(link(propertyId)).set("Authorization", `Bearer ${otherAgentToken}`)).status).toBe(403);
  });

  it("до создания ссылки нет: GET отдаёт link: null", async () => {
    const res = await request(app).get(link(propertyId)).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ link: null });
  });

  it("токен идемпотентен: повторный POST отдаёт ту же ссылку, новая — только после отзыва", async () => {
    const first = await post(propertyId);
    expect(first.status).toBe(201);
    const token = tokenOf(first.body.link.url);
    // 32 байта в base64url = 43 символа, без «=»: длиннее, чем у ссылки клиента.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.body.link.viewsCount).toBe(0);
    expect(first.body.link.lastViewedAt).toBeNull();

    const again = await post(propertyId);
    expect(again.status).toBe(200);
    expect(again.body.link.id).toBe(first.body.link.id);
    expect(tokenOf(again.body.link.url)).toBe(token);

    const got = await request(app).get(link(propertyId)).set("Authorization", `Bearer ${agentToken}`);
    expect(got.body.link.id).toBe(first.body.link.id);

    // Два одновременных «создать» после отзыва дают ОДНУ действующую ссылку.
    expect((await request(app).delete(link(propertyId)).set("Authorization", `Bearer ${agentToken}`)).status).toBe(204);
    const [a, b] = await Promise.all([post(propertyId), post(propertyId)]);
    expect([a.status, b.status].every((s) => s === 200 || s === 201)).toBe(true);
    expect(a.body.link.id).toBe(b.body.link.id);
    expect(a.body.link.id).not.toBe(first.body.link.id);
    expect(await prisma.propertyOwnerReportLink.count({ where: { propertyId, revokedAt: null } })).toBe(1);
  });

  it("повторный DELETE безопасен (204), отзывать нечего", async () => {
    await request(app).delete(link(propertyId)).set("Authorization", `Bearer ${agentToken}`);
    const res = await request(app).delete(link(propertyId)).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(204);
  });
});

describe("публичная страница GET /public/owner-report/:token", () => {
  let token = "";
  let body: OwnerReportResponse;

  beforeAll(async () => {
    const created = await post(propertyId);
    expect(created.status).toBe(201);
    token = tokenOf(created.body.link.url);
  });

  it("отдаёт отчёт без входа, с заголовками «не кэшировать» и «не индексировать»", async () => {
    const res = await request(app).get(`${PUBLIC}/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-robots-tag"]).toContain("noindex");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    body = res.body as OwnerReportResponse;

    expect(body.property.title).toBe(`Квартира отчёт ${runId}`);
    expect(body.property.rooms).toBe(2);
    expect(body.property.price).toBe(650_000);
    expect(body.property.district).toBe(`Тест-район-отчёт-${runId}`);
    expect(body.property.saleStatus).toBe("AVAILABLE");
    expect(body.agency.name).toBeTruthy();
    expect(typeof body.generatedAt).toBe("string");
  });

  it("числа за неделю и за всё время считаются по данным объекта", async () => {
    const res = await request(app).get(`${PUBLIC}/${token}`);
    const { week, all } = (res.body as OwnerReportResponse).periods;
    for (const period of [week, all]) {
      expect(period.shownToClients).toBe(2);
      // Клиент со звонком И диалогом бота — один человек; диалог без карточки — второй;
      // исходящая неудачная попытка агента к третьему не считается вовсе.
      expect(period.contacts).toBe(2);
      expect(period.siteViews).toBe(33);
      // Реклама: показы и обращения, никаких денег.
      expect(period.ads).toEqual({ impressions: 1000, inquiries: 5 });
    }
    expect((res.body as OwnerReportResponse).weekly.length).toBeGreaterThan(0);
    const lastWeek = (res.body as OwnerReportResponse).weekly.at(-1)!;
    expect(lastWeek.events).toBeGreaterThanOrEqual(3);
  });

  it("темы — только ключ, подпись и число; цитат, имён и телефонов нет", async () => {
    const res = await request(app).get(`${PUBLIC}/${token}`);
    const topics = (res.body as OwnerReportResponse).topics;
    expect(topics.map((t) => t.key)).toEqual(expect.arrayContaining(["PRICE", "DOCUMENTS"]));
    for (const t of topics) {
      expect(Object.keys(t).sort()).toEqual(["count", "key", "label"]);
      expect(OWNER_REPORT_TOPIC_KEYS).toContain(t.key);
    }
  });

  it("в ответе нет ни одного запрещённого поля и значения", async () => {
    const res = await request(app).get(`${PUBLIC}/${token}`);
    const keys: string[] = [];
    const strings: string[] = [];
    walk(res.body, keys, strings);
    const text = JSON.stringify(res.body);

    // Значения из фикстуры: телефоны, имена, адрес, документы, чужой объект.
    for (const secret of [
      ownerContact,
      clientPhone,
      clientName,
      `Секретов`,
      rivalName,
      `Конкурентов`,
      secretAddress,
      `Секретная`,
      secretDocuments,
      otherPropertyTitle,
      String(otherPropertyPrice),
      `ext-${runId}`,
      failedClientName,
      objectionSecret,
      quoteSecret,
      postSummarySecret,
      `красный флаг ${runId}`,
      agentId,
      clientId,
      failedClientId,
    ]) {
      expect(text, `в ответе утекло «${secret}»`).not.toContain(secret);
    }
    // Деньги компании: сумма расхода рекламы, расход, комиссия.
    expect(text).not.toContain("8421.37");
    expect(text).not.toContain("842137");
    expect(text).not.toMatch(/spend|expense|commission|комисс|расход|сомони/i);
    // Любой телефонный номер в любой строке. Проверка самой проверки: номер она ловит, дату — нет.
    expect(looksLikePhone("+992 90 123 45 67")).toBe(true);
    expect(looksLikePhone("2026-10-07T12:00:00.000Z")).toBe(false);
    expect(strings.filter(looksLikePhone)).toEqual([]);
    // Запрещённые ключи.
    const forbiddenKeys = [
      "phone",
      "ownerContact",
      "fullName",
      "address",
      "documents",
      "agentId",
      "clientId",
      "assignedAgent",
      "spend",
      "spendTjs",
      "commission",
      "shortId",
      "id",
    ];
    expect(keys.filter((k) => forbiddenKeys.includes(k))).toEqual([]);
  });

  it("считает открытия для агента не чаще раза в минуту: viewsCount и lastViewedAt", async () => {
    // Тесты выше открыли страницу несколько раз подряд — засчитано ровно одно открытие.
    const got = await waitFor(
      async () => {
        const row = await prisma.propertyOwnerReportLink.findUnique({ where: { token } });
        return row && row.viewsCount >= 1 ? row : null;
      },
      { label: "счётчик открытий" }
    );
    expect(got.lastViewedAt).not.toBeNull();
    for (let i = 0; i < 3; i++) expect((await request(app).get(`${PUBLIC}/${token}`)).status).toBe(200);
    const settled = await waitForSettled(async () => {
      const row = await prisma.propertyOwnerReportLink.findUnique({ where: { token } });
      return row?.viewsCount ?? 0;
    });
    expect(settled).toBe(1);
    const card = await request(app).get(link(propertyId)).set("Authorization", `Bearer ${agentToken}`);
    expect(card.body.link.viewsCount).toBe(1);
  });

  it("неверный, не нашей формы и отозванный токен дают ОДИНАКОВЫЙ 404", async () => {
    const wellFormedUnknown = "A".repeat(43);
    const revokedToken = token;
    expect((await request(app).delete(link(propertyId)).set("Authorization", `Bearer ${agentToken}`)).status).toBe(204);

    const responses = await Promise.all([
      request(app).get(`${PUBLIC}/${wellFormedUnknown}`),
      request(app).get(`${PUBLIC}/короткий`),
      request(app).get(`${PUBLIC}/${revokedToken}`),
    ]);
    for (const r of responses) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual(responses[0].body);
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.headers["x-robots-tag"]).toContain("noindex");
    }
    expect(responses[0].body).toEqual({ error: "Ссылка недействительна" });
  });

  it("удалённый объект — тот же 404 (ссылка гаснет вместе с ним)", async () => {
    const created = await post(propertyId);
    const t = tokenOf(created.body.link.url);
    expect((await request(app).get(`${PUBLIC}/${t}`)).status).toBe(200);
    await prisma.property.update({ where: { id: propertyId }, data: { deletedAt: new Date() } });
    const gone = await request(app).get(`${PUBLIC}/${t}`);
    expect(gone.status).toBe(404);
    expect(gone.body).toEqual({ error: "Ссылка недействительна" });
    await prisma.property.update({ where: { id: propertyId }, data: { deletedAt: null } });
  });
});

describe("спутник объекта", () => {
  it("ссылка гаснет вместе с объектом: revokePropertyShareLinks отзывает и ссылки отчёта", async () => {
    const { revokePropertyShareLinks } = await import("../src/lib/propertyShareLink.js");
    const created = await post(propertyId);
    expect([200, 201]).toContain(created.status);
    await revokePropertyShareLinks([propertyId]);
    expect(await prisma.propertyOwnerReportLink.count({ where: { propertyId, revokedAt: null } })).toBe(0);
    // После «восстановления» нужна новая ссылка — старая не оживает.
    const fresh = await post(propertyId);
    expect(fresh.status).toBe(201);
    expect(fresh.body.link.id).not.toBe(created.body.link.id);
  });
});

describe("число контактов по объекту", () => {
  const allContacts = async () => (await loadOwnerReport(propertyId, shareSaleStatus))!.periods.all.contacts;

  it("клиент и с диалогом бота, и со звонком — один человек; диалог без карточки — второй", async () => {
    // Фикстура: клиент (звонок + диалог на его карточке) и диалог без карточки.
    expect(await allContacts()).toBe(2);
    expect((await loadOwnerReport(propertyId, shareSaleStatus))!.periods.week.contacts).toBe(2);
  });

  it("исходящая неудачная попытка агента не увеличивает число, входящий пропущенный — увеличивает", async () => {
    const base = await allContacts();
    const extra = await prisma.client.create({
      data: { fullName: `Третий Клиент${runId}`, phone: `+992936${runId.toString().slice(-6)}`, source: "PHONE_CALL", assignedAgentId: agentId },
    });
    try {
      await prisma.interaction.create({
        data: { clientId: extra.id, agentId, type: "CALL", notes: "не дозвонился", propertyId, outcome: "NO_ANSWER" },
      });
      expect(await allContacts()).toBe(base);
      // Входящий пропущенный: пишет система, исхода нет (lib/telephony/incomingCalls.ts) — человек звонил сам.
      await prisma.interaction.create({
        data: {
          clientId: extra.id,
          actorKind: "SYSTEM",
          subjectAgentId: agentId,
          type: "CALL",
          notes: "Входящий звонок клиента: до оператора не дозвонился",
          propertyId,
        },
      });
      expect(await allContacts()).toBe(base + 1);
    } finally {
      await prisma.interaction.deleteMany({ where: { clientId: extra.id } });
      await prisma.client.delete({ where: { id: extra.id } });
    }
  });
});

describe("окно недели: реклама по календарным суткам Душанбе", () => {
  it("за неделю ровно 7 календарных суток: восьмые сутки в «неделю» не попадают, в «всё время» — да", async () => {
    const { dushanbeDateString } = await import("../src/lib/dushanbeTime.js");
    const dayKey = (back: number) => {
      const midnight = new Date(`${dushanbeDateString()}T00:00:00.000Z`).getTime();
      return new Date(midnight - back * 24 * 3600_000);
    };
    const property = await prisma.property.create({
      data: {
        title: `Окно рекламы ${runId}`,
        type: "APARTMENT",
        areaSqm: 30,
        price: 100_000,
        currency: "TJS",
        districtId,
        address: "Окно, 1",
        condition: "GOOD",
        status: "AVAILABLE",
        intakeAgentId: agentId,
        createdById: agentId,
        assignedAgentId: agentId,
      },
    });
    const ad = await prisma.ad.create({
      data: { platform: "META", externalId: `owner-report-window-${runId}`, name: `Реклама окно ${runId}`, propertyId: property.id, lastSyncedAt: new Date() },
    });
    try {
      await prisma.adSpendDaily.createMany({
        data: [
          { adId: ad.id, date: dayKey(7), spend: 1, currency: "TJS", impressions: 100, clicks: 1, conversations: 0 },
          { adId: ad.id, date: dayKey(6), spend: 1, currency: "TJS", impressions: 10, clicks: 1, conversations: 0 },
          { adId: ad.id, date: dayKey(0), spend: 1, currency: "TJS", impressions: 1, clicks: 1, conversations: 0 },
        ],
      });
      const report = (await loadOwnerReport(property.id, shareSaleStatus))!;
      expect(report.periods.week.ads?.impressions).toBe(11);
      expect(report.periods.all.ads?.impressions).toBe(111);
    } finally {
      await prisma.adSpendDaily.deleteMany({ where: { adId: ad.id } });
      await prisma.ad.delete({ where: { id: ad.id } });
      await prisma.property.delete({ where: { id: property.id } });
    }
  });
});

describe("кэш готового отчёта и счётчик открытий", () => {
  const stub = (n: number) => ({ generatedAt: `t${n}` }) as unknown as OwnerReportResponse;

  it("одновременные запросы одного объекта собирают отчёт ОДИН раз, следующие — из кэша", async () => {
    resetOwnerReportServeState();
    let builds = 0;
    const build = async () => {
      builds += 1;
      await new Promise((r) => setTimeout(r, 30));
      return stub(builds);
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => cachedOwnerReport("p1", build)));
    expect(builds).toBe(1);
    expect(new Set(results).size).toBe(1);
    await cachedOwnerReport("p1", build);
    expect(builds).toBe(1);
    // Другой объект считается отдельно.
    await cachedOwnerReport("p2", build);
    expect(builds).toBe(2);
  });

  it("после срока жизни собирается заново; null (объекта нет) и ошибка не кэшируются", async () => {
    resetOwnerReportServeState();
    let builds = 0;
    const build = async () => stub(++builds);
    const t0 = Date.now();
    await cachedOwnerReport("p3", build, t0);
    await cachedOwnerReport("p3", build, t0 + OWNER_REPORT_CACHE_TTL_MS - 1);
    expect(builds).toBe(1);
    await cachedOwnerReport("p3", build, t0 + OWNER_REPORT_CACHE_TTL_MS + 1);
    expect(builds).toBe(2);

    let nullCalls = 0;
    const missing = async () => {
      nullCalls += 1;
      return null;
    };
    expect(await cachedOwnerReport("gone", missing)).toBeNull();
    expect(await cachedOwnerReport("gone", missing)).toBeNull();
    expect(nullCalls).toBe(2);

    let failCalls = 0;
    const failing = async (): Promise<OwnerReportResponse | null> => {
      failCalls += 1;
      throw new Error("база недоступна");
    };
    await expect(cachedOwnerReport("bad", failing)).rejects.toThrow("база недоступна");
    await expect(cachedOwnerReport("bad", failing)).rejects.toThrow("база недоступна");
    expect(failCalls).toBe(2);
  });

  it("память ограничена: больше потолка записей не копится", async () => {
    resetOwnerReportServeState();
    for (let i = 0; i < OWNER_REPORT_CACHE_MAX_ENTRIES + 50; i++) {
      await cachedOwnerReport(`bulk-${i}`, async () => stub(i));
    }
    expect(ownerReportCacheSize()).toBe(OWNER_REPORT_CACHE_MAX_ENTRIES);
  });

  it("открытие засчитывается не чаще раза в минуту на ссылку", () => {
    resetOwnerReportServeState();
    const t0 = Date.now();
    expect(shouldCountOwnerReportView("l1", t0)).toBe(true);
    expect(shouldCountOwnerReportView("l1", t0 + 1_000)).toBe(false);
    expect(shouldCountOwnerReportView("l2", t0 + 1_000)).toBe(true);
    expect(shouldCountOwnerReportView("l1", t0 + OWNER_REPORT_VIEW_COUNT_INTERVAL_MS)).toBe(true);
  });

  it("через HTTP: пять одновременных открытий — одна сборка (два чтения сайта: неделя и всё время)", async () => {
    resetOwnerReportServeState();
    const created = await post(propertyId);
    const t = tokenOf(created.body.link.url);
    const spy = vi.spyOn(prisma.sitePropertyDay, "aggregate");
    try {
      const responses = await Promise.all(Array.from({ length: 5 }, () => request(app).get(`${PUBLIC}/${t}`)));
      expect(responses.every((r) => r.status === 200)).toBe(true);
      const callsAfterBurst = spy.mock.calls.length;
      expect(callsAfterBurst).toBe(2);
      expect((await request(app).get(`${PUBLIC}/${t}`)).status).toBe(200);
      expect(spy.mock.calls.length).toBe(callsAfterBurst);
    } finally {
      spy.mockRestore();
    }
  });

  it("отозванная ссылка гаснет сразу, хотя отчёт ещё в кэше", async () => {
    const created = await post(propertyId);
    const t = tokenOf(created.body.link.url);
    expect((await request(app).get(`${PUBLIC}/${t}`)).status).toBe(200);
    expect((await request(app).delete(link(propertyId)).set("Authorization", `Bearer ${agentToken}`)).status).toBe(204);
    expect((await request(app).get(`${PUBLIC}/${t}`)).status).toBe(404);
  });
});

describe("индексы ссылки на отчёт", () => {
  async function indexDef(name: string): Promise<string | null> {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ${name}`;
    return rows[0]?.indexdef ?? null;
  }

  it("частичный уникальный индекс «одна действующая ссылка на объект» есть и с условием WHERE", async () => {
    const def = await indexDef("PropertyOwnerReportLink_propertyId_active_key");
    expect(def, "индекса нет — миграция owner_report_link не применена").not.toBeNull();
    expect(def).toContain("UNIQUE");
    expect(def).toContain('("propertyId")');
    expect(def).toContain("WHERE");
    expect(def).toContain('"revokedAt" IS NULL');
  });

  it("уникальный индекс токена есть", async () => {
    const def = await indexDef("PropertyOwnerReportLink_token_key");
    expect(def).not.toBeNull();
    expect(def).toContain("UNIQUE");
    expect(def).toContain("(token)");
  });
});

describe("потолок запросов", () => {
  it("после лимита страница отвечает 429 с понятным текстом и заголовками «не кэшировать / не индексировать»", async () => {
    // Лимит — 60 запросов за 5 минут с одного адреса; предыдущие тесты уже часть потратили.
    const statuses: number[] = [];
    let limited: { status: number; body: unknown; headers: Record<string, string> } | null = null;
    for (let i = 0; i < 80 && !limited; i++) {
      const res = await request(app).get(`${PUBLIC}/${"B".repeat(43)}`);
      statuses.push(res.status);
      if (res.status === 429) limited = { status: res.status, body: res.body, headers: res.headers };
    }
    expect(limited, `ни одного 429 за ${statuses.length} запросов`).not.toBeNull();
    expect(limited!.headers["cache-control"]).toBe("no-store");
    expect(limited!.headers["x-robots-tag"]).toContain("noindex");
    expect(limited!.body).toEqual({ error: "Слишком много запросов, попробуйте позже" });
    // До лимита — обычные 404 «ссылка недействительна».
    expect(statuses.slice(0, -1).every((s) => s === 404)).toBe(true);
  });
});
