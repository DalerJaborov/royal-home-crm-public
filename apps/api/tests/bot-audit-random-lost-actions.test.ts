import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { loadConversationsToJudge } from "../src/ai/botAudit.js";

/**
 * Две правки от 30.08.2026, обе — по жалобам владельца.
 *
 * 1. Судья диалогов брал только вчерашние переписки, поэтому диалог, чья ночь
 *    пропущена (отказ модели, выходные), не проверялся уже никогда. Теперь выборка
 *    случайная за месяц и без уже судимых. Проверять это обязательно тестом:
 *    отбор идёт СЫРЫМ SQL, который компилятор не смотрит, — опечатка в имени
 *    колонки вылезла бы только ночью на проде, молча, «нарушений не найдено».
 *
 * 2. Сотня разборов оборванных переписок висела без единой кнопки. Появились три
 *    исхода; здесь проверяем, что каждый делает ровно то, что обещает надписью, и
 *    что чужой человек их нажать не может.
 */

const runId = Date.now();
const password = "testpass123";

let adminToken: string;
let agentToken: string;
const conversationIds: string[] = [];
const lostIds: string[] = [];
const lessonIds: string[] = [];
const verdictFindingIds: string[] = [];
let judgedConversationId = "";
let findingId = "";

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/** Оборванная переписка в базе. Реплики задаются: пустая реплика — отдельный случай. */
async function createLostReview(opts: { botMessage?: string; clientMessage?: string } = {}) {
  const row = await prisma.lostConversation.create({
    data: {
      conversationId: `lost-${runId}-${lostIds.length}`,
      channel: "WHATSAPP",
      reason: "silent",
      stage: "budget",
      lastMessageAt: new Date(),
      clientMessages: 3,
      followUpsSent: 1,
      finding: "Человек спросил про цену и пропал",
      suggestion: "",
      botMessage: opts.botMessage ?? "Цену уточню у коллеги",
      clientMessage: opts.clientMessage ?? "А сколько стоит?",
    },
  });
  lostIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Судья-Админ", phone: `+992973${runId}`, role: "ADMIN", passwordHash },
  });
  const agent = await prisma.agent.create({
    data: { fullName: "Судья-Агент", phone: `+992974${runId}`, role: "AGENT", passwordHash },
  });
  adminToken = await login(admin.phone);
  agentToken = await login(agent.phone);

  // Три свежие переписки: две «чистые» и одна, по которой находка уже есть.
  for (let i = 0; i < 3; i++) {
    const conv = await prisma.botConversation.create({
      data: {
        channel: "WHATSAPP",
        subscriberId: `sub-${runId}-${i}`,
        lastMessageAt: new Date(),
        messages: [
          { role: "user", content: "Здравствуйте, есть двушка?" },
          { role: "assistant", content: "Здравствуйте! Да, посмотрим варианты." },
        ],
      },
    });
    conversationIds.push(conv.id);
  }
  judgedConversationId = conversationIds[0];
  const finding = await prisma.botAuditFinding.create({
    data: {
      conversationId: judgedConversationId,
      channel: "WHATSAPP",
      type: "repetition",
      quote: "Здравствуйте! Да, посмотрим варианты.",
      why: "Повтор",
      severity: "low",
    },
  });
  findingId = finding.id;
});

afterAll(async () => {
  await prisma.botAuditFinding.deleteMany({ where: { id: { in: [findingId, ...verdictFindingIds] } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.lostConversation.deleteMany({ where: { id: { in: lostIds } } });
  await prisma.botLesson.deleteMany({ where: { id: { in: lessonIds } } });
  await prisma.agent.deleteMany({ where: { phone: { in: [`+992973${runId}`, `+992974${runId}`] } } });
});

/** Находка аудита для тестов вердикта — со своей цитатой, чтобы не задевать
 *  общую `findingId` из блока выборки судьи выше. */
async function createAuditFinding(opts: { quote?: string; why?: string } = {}) {
  const row = await prisma.botAuditFinding.create({
    data: {
      conversationId: judgedConversationId || conversationIds[0],
      channel: "WHATSAPP",
      type: "tone",
      quote: opts.quote ?? "Хуб, лутфан рақами телефонатонро нависед",
      why: opts.why ?? "Использовано запрещённое слово «лутфан»",
      severity: "medium",
    },
  });
  verdictFindingIds.push(row.id);
  return row.id;
}

describe("Судья берёт случайные диалоги, а не только вчерашние", () => {
  it("сырой SQL выборки исполняется и не берёт уже судимый диалог", async () => {
    const picked = await loadConversationsToJudge(1);
    expect(Array.isArray(picked)).toBe(true);
    // Предел выборки обязателен — иначе один клик оплачивает всю таблицу.
    expect(picked.length).toBeLessThanOrEqual(50);
    expect(picked.map((p) => p.id)).not.toContain(judgedConversationId);
    // Свежие непроверенные из этого прогона обязаны найтись: окно в час, и
    // случайность выбирает ИЗ них, а не вместо них.
    const mine = picked.filter((p) => conversationIds.includes(p.id));
    expect(mine.length).toBe(2);
    // Переписка приходит целиком: без неё судить нечего.
    expect(Array.isArray(mine[0].messages)).toBe(true);
    expect(mine[0].channel).toBe("WHATSAPP");
  });
});

describe("Действия по оборванной переписке", () => {
  it("«Бот прав» убирает разбор и не заводит правил", async () => {
    const id = await createLostReview();
    const before = await prisma.botLesson.count();
    const res = await request(app)
      .post(`/api/v1/bot-learning/lost/reviews/${id}/resolve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ verdict: "bot_right" });
    expect(res.status).toBe(200);
    expect(res.body.lessonCreated).toBe(false);
    expect(await prisma.lostConversation.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.botLesson.count()).toBe(before);
  });

  it("«Бот ошибся» отправляет случай в ту же очередь обучения", async () => {
    const id = await createLostReview();
    const res = await request(app)
      .post(`/api/v1/bot-learning/lost/reviews/${id}/resolve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ verdict: "bot_error" });
    expect(res.status).toBe(200);
    expect(res.body.lessonCreated).toBe(true);
    expect(await prisma.lostConversation.findUnique({ where: { id } })).toBeNull();

    const lesson = await prisma.botLesson.findFirst({
      where: { kind: "lost_manual", conversationId: { startsWith: `lost-${runId}-` } },
      orderBy: { createdAt: "desc" },
    });
    expect(lesson).not.toBeNull();
    lessonIds.push(lesson!.id);
    // Правило пустое: его выведет ночной разбор или впишет владелец в
    // «Бот спрашивает: как отвечать?». Готовый текст здесь взять неоткуда.
    expect(lesson!.lesson).toBeNull();
    expect(lesson!.botMessage).toBe("Цену уточню у коллеги");
    expect(lesson!.humanMessage).toBe("А сколько стоит?");
  });

  it("«Бот ошибся» отказывает, когда учиться не на чем", async () => {
    const id = await createLostReview({ clientMessage: "   " });
    const res = await request(app)
      .post(`/api/v1/bot-learning/lost/reviews/${id}/resolve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ verdict: "bot_error" });
    expect(res.status).toBe(400);
    // Запись на месте: отказ не должен молча съедать разбор.
    expect(await prisma.lostConversation.findUnique({ where: { id } })).not.toBeNull();
  });

  it("«Удалить» убирает разбор", async () => {
    const id = await createLostReview();
    const res = await request(app)
      .post(`/api/v1/bot-learning/lost/reviews/${id}/resolve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ verdict: "delete" });
    expect(res.status).toBe(200);
    expect(await prisma.lostConversation.findUnique({ where: { id } })).toBeNull();
  });

  it("чужой вердикт и чужой идентификатор отклоняются", async () => {
    const id = await createLostReview();
    const bad = await request(app)
      .post(`/api/v1/bot-learning/lost/reviews/${id}/resolve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ verdict: "как-нибудь" });
    expect(bad.status).toBe(400);

    const missing = await request(app)
      .post(`/api/v1/bot-learning/lost/reviews/00000000-0000-0000-0000-000000000000/resolve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ verdict: "bot_right" });
    expect(missing.status).toBe(404);
  });

  it("агенту без права настроек кнопки недоступны", async () => {
    const id = await createLostReview();
    const res = await request(app)
      .post(`/api/v1/bot-learning/lost/reviews/${id}/resolve`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ verdict: "bot_right" });
    expect(res.status).toBe(403);
    expect(await prisma.lostConversation.findUnique({ where: { id } })).not.toBeNull();
  });
});

describe("Вердикт по находке аудита бота (bot_right / bot_error)", () => {
  it("bot_right закрывает находку без урока", async () => {
    const id = await createAuditFinding();
    const before = await prisma.botLesson.count();
    const res = await request(app)
      .post(`/api/v1/bot-audit/${id}/resolve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ verdict: "bot_right" });
    expect(res.status).toBe(204);
    const row = await prisma.botAuditFinding.findUnique({ where: { id } });
    expect(row?.resolvedAt).not.toBeNull();
    expect(await prisma.botLesson.count()).toBe(before);
  });

  it("bot_error заводит выключенный урок с текстом судьи и маскирует номер клиента в цитате", async () => {
    // Живой класс находок — бот повторил номер клиента внутри же нарушения.
    // Урок не должен унести открытый номер в промт будущих разговоров.
    const id = await createAuditFinding({
      quote: "Ваш номер 900001029 мы уже записали, лутфан подождите",
      why: "Повторно спросил то, что клиент уже сказал",
    });
    const res = await request(app)
      .post(`/api/v1/bot-audit/${id}/resolve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ verdict: "bot_error" });
    expect(res.status).toBe(204);

    const row = await prisma.botAuditFinding.findUnique({ where: { id } });
    expect(row?.resolvedAt).not.toBeNull();
    expect(row?.resolvedById).not.toBeNull();

    const lesson = await prisma.botLesson.findFirst({
      where: { kind: "audit_finding", conversationId: judgedConversationId || conversationIds[0] },
      orderBy: { createdAt: "desc" },
    });
    expect(lesson).not.toBeNull();
    lessonIds.push(lesson!.id);
    // Готовый вывод судьи — не сырой случай, разбирать заново нечего.
    expect(lesson!.lesson).toBe("Повторно спросил то, что клиент уже сказал");
    // Выключено: ждёт «Правило верное — включить» в «Чему бот научился», как и
    // предложения из недельной сводки «Ушедшие молча клиенты».
    expect(lesson!.active).toBe(false);
    // Номер клиента из цитаты бота не должен уехать в промт будущих разговоров.
    expect(lesson!.botMessage).not.toContain("900001029");
    expect(lesson!.botMessage).toContain("****");
  });

  it("без вердикта — старое поведение: находка закрывается, урока нет", async () => {
    const id = await createAuditFinding();
    const before = await prisma.botLesson.count();
    const res = await request(app)
      .post(`/api/v1/bot-audit/${id}/resolve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(204);
    expect((await prisma.botAuditFinding.findUnique({ where: { id } }))?.resolvedAt).not.toBeNull();
    expect(await prisma.botLesson.count()).toBe(before);
  });

  it("чужой вердикт отклоняется, отсутствующая находка — 404", async () => {
    const id = await createAuditFinding();
    const bad = await request(app)
      .post(`/api/v1/bot-audit/${id}/resolve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ verdict: "как-нибудь" });
    expect(bad.status).toBe(400);

    const missing = await request(app)
      .post(`/api/v1/bot-audit/00000000-0000-0000-0000-000000000000/resolve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ verdict: "bot_right" });
    expect(missing.status).toBe(404);
  });

  it("агенту без права auditLog.view — 403", async () => {
    const id = await createAuditFinding();
    const res = await request(app)
      .post(`/api/v1/bot-audit/${id}/resolve`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ verdict: "bot_right" });
    expect(res.status).toBe(403);
    expect((await prisma.botAuditFinding.findUnique({ where: { id } }))?.resolvedAt).toBeNull();
  });
});

describe("Счётчики находок судьи", () => {
  it("список отдаёт честные итоги, а не длину обрезанной страницы", async () => {
    const res = await request(app).get("/api/v1/bot-audit").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.unresolvedTotal).toBe("number");
    expect(typeof res.body.resolvedTotal).toBe("number");
    expect(res.body.unresolvedTotal).toBeGreaterThanOrEqual(1);
  });
});
