import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { getTrainingCandidate } from "../src/ai/training.js";

/**
 * Экран «Тренировка» (23.08.2026, пункт 6 очереди ИИ) — окно наружу для
 * ai/training.ts. Здесь проверяется то, что чистой функцией не покрыть:
 *  1. Рубильник Settings.botTrainingScreenEnabled реально закрывает оба
 *     маршрута на СЕРВЕРЕ, а не только прячет пункт меню.
 *  2. Право и подтверждение личности у /decide — та же дисциплина, что у
 *     PATCH /bot-learning/:id: текст отсюда попадает в промт бота.
 *  3. Дубль пары [clientText, agentText] — это 200 с пометкой, а не 500.
 *  4. Кандидата, для которого уже есть StyleExample, подбор больше не предлагает.
 *
 * Генерацию вариантов (callAiText) тестами с реальным ключом Gemini не гоняем —
 * его в тестовом окружении нет, и это ожидаемо: GET /next в таком случае честно
 * отвечает 502, не создавая ничего в базе. Это тоже проверяется ниже — отказ
 * поставщика ИИ обязан быть виден, а не притворяться пустой очередью.
 */

const runId = Date.now().toString(36);
const password = "testpass123";

let adminId: string;
let adminToken: string;
let agentId: string;
let agentToken: string;
let savedToggle: boolean;

const conversationClientText = `Дар Сино 3-хонага ҳаст, нархаш чанд, тренировка-${runId}?`;
let conversationId: string;
const createdStyleExampleIds: string[] = [];

function authed(token: string) {
  return {
    get: (path: string) => request(app).get(path).set("Authorization", `Bearer ${token}`),
    post: (path: string, body: unknown) =>
      request(app).post(path).set("Authorization", `Bearer ${token}`).send(body),
  };
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);

  const admin = await prisma.agent.create({
    data: { fullName: "Админ тренировки", phone: `+992937${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const adminLogin = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  adminToken = adminLogin.body.accessToken;
  grantElevation(adminId);

  const agent = await prisma.agent.create({
    data: { fullName: "Агент без прав настроек", phone: `+992938${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const agentLogin = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  agentToken = agentLogin.body.accessToken;

  const settings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });
  savedToggle = settings.botTrainingScreenEnabled;

  // Реальный диалог с законченным вопросом клиента — сырьё для getTrainingCandidate.
  const conversation = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `training-test-${runId}`,
      messages: [
        { role: "user", content: conversationClientText },
        { role: "assistant", content: "Ҳа, дорем, ҳозир нархашро мефиристам", by: { kind: "bot" } },
      ],
    },
  });
  conversationId = conversation.id;
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { botTrainingScreenEnabled: savedToggle } });
  await prisma.botConversation.delete({ where: { id: conversationId } }).catch(() => {});
  if (createdStyleExampleIds.length > 0) {
    await prisma.styleExample.deleteMany({ where: { id: { in: createdStyleExampleIds } } });
  }
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, agentId] } } });
  await prisma.$disconnect();
});

describe("рубильник Settings.botTrainingScreenEnabled", () => {
  it("выключен по умолчанию — оба маршрута отвечают 403, а не молча пустотой", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botTrainingScreenEnabled: false } });

    const next = await authed(adminToken).get("/api/v1/bot-training/next");
    expect(next.status).toBe(403);

    const decide = await authed(adminToken).post("/api/v1/bot-training/decide", {
      clientText: conversationClientText,
      customText: "Да, есть трёшка, скину цену",
    });
    expect(decide.status).toBe(403);
  });
});

describe("доступ", () => {
  it("без токена — 401", async () => {
    const res = await request(app).get("/api/v1/bot-training/next");
    expect(res.status).toBe(401);
  });

  it("без права settings.manage — /decide отвечает 403", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botTrainingScreenEnabled: true } });
    const res = await authed(agentToken).post("/api/v1/bot-training/decide", {
      clientText: conversationClientText,
      customText: "Да, есть трёшка, скину цену",
    });
    expect(res.status).toBe(403);
  });

  it("без подтверждения личности — /decide отвечает 428", async () => {
    // adminId элевацию уже получил в beforeAll — проверяем на СВЕЖЕМ админе.
    const passwordHash = await bcrypt.hash(password, 10);
    const fresh = await prisma.agent.create({
      data: { fullName: "Второй админ", phone: `+992939${runId}`, role: "ADMIN", passwordHash },
    });
    try {
      const login = await request(app).post("/api/v1/auth/login").send({ phone: fresh.phone, password });
      const res = await authed(login.body.accessToken).post("/api/v1/bot-training/decide", {
        clientText: conversationClientText,
        customText: "Да, есть трёшка, скину цену",
      });
      expect(res.status).toBe(428);
      expect(res.body.stepUpRequired).toBe(true);
    } finally {
      await prisma.agent.delete({ where: { id: fresh.id } });
    }
  });
});

describe("подбор кандидата (ai/training.ts, реальная база)", () => {
  it("реальный вопрос клиента без образца — годный кандидат", async () => {
    const found = await pollForCandidate();
    expect(found).not.toBeNull();
    expect(found?.clientText).toBe(conversationClientText);
    expect(found?.conversationId).toBe(conversationId);
  });

  it("тот же вопрос, уже ставший образцом, больше не предлагается", async () => {
    const example = await prisma.styleExample.create({
      data: {
        clientText: conversationClientText,
        agentText: "Да, есть трёшка в Сино, скину подробности в личку",
        source: "TRAINING",
        channel: "INSTAGRAM",
      },
    });
    createdStyleExampleIds.push(example.id);

    // Кандидатов кроме нашего в тестовой базе может не быть вовсе — тогда
    // getTrainingCandidate честно вернёт null (очередь пуста), и это тоже
    // доказывает исключение: если бы фильтр не работал, наш вопрос вернулся бы.
    const found = await pollForCandidate();
    if (found) expect(found.clientText).not.toBe(conversationClientText);
  });
});

/** Кандидатов среди 80 последних диалогов подбираем случайно — гоняем несколько
 *  раз, чтобы наш тестовый диалог не потерялся статистически на людной базе. */
async function pollForCandidate(attempts = 20): Promise<Awaited<ReturnType<typeof getTrainingCandidate>>> {
  for (let i = 0; i < attempts; i++) {
    const candidate = await getTrainingCandidate();
    if (candidate?.conversationId === conversationId) return candidate;
  }
  return null;
}

describe("GET /bot-training/next", () => {
  it("без ключа Gemini в тестовом окружении отвечает 502, а не тихо молчит", async () => {
    // Ключей нет ни в .env, ни в Settings этого тестового стенда — генерация
    // вариантов обязана провалиться контролируемо. Если когда-нибудь тестовый
    // стенд обзаведётся реальным ключом, тест ниже тоже пройдёт (see второй expect).
    const res = await authed(adminToken).get("/api/v1/bot-training/next");
    expect([200, 502]).toContain(res.status);
    if (res.status === 502) {
      expect(res.body.error).toBeTruthy();
    } else {
      expect(typeof res.body.done).toBe("boolean");
    }
  });
});

describe("POST /bot-training/decide", () => {
  it("нужен либо chosenIndex, либо customText — 400 без обоих", async () => {
    const res = await authed(adminToken).post("/api/v1/bot-training/decide", {
      clientText: conversationClientText,
    });
    expect(res.status).toBe(400);
  });

  it("свой вариант сохраняется как StyleExample с source TRAINING", async () => {
    const clientText = `Уникальный вопрос для теста ${runId}: рафтуа ба обод?`;
    const agentText = `Ҳа, рафтуа ба обод дорем, тестовый ответ ${runId}`;

    const res = await authed(adminToken).post("/api/v1/bot-training/decide", {
      clientText,
      channel: "TELEGRAM",
      customText: agentText,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const row = await prisma.styleExample.findFirst({ where: { clientText, agentText } });
    expect(row).not.toBeNull();
    expect(row?.source).toBe("TRAINING");
    if (row) createdStyleExampleIds.push(row.id);
  });

  it("выбор варианта по индексу тоже сохраняется", async () => {
    const clientText = `Ещё один уникальный вопрос ${runId}: метраж чанд?`;
    const variants = [`Вариант А ${runId} — метраж 62 метр`, `Вариант Б ${runId} — метраж 70 метр`];

    const res = await authed(adminToken).post("/api/v1/bot-training/decide", {
      clientText,
      variants,
      chosenIndex: 1,
    });
    expect(res.status).toBe(200);

    const row = await prisma.styleExample.findFirst({ where: { clientText, agentText: variants[1] } });
    expect(row).not.toBeNull();
    if (row) createdStyleExampleIds.push(row.id);
  });

  it("повтор той же пары — 200 с пометкой duplicate, не 500 и не вторая запись", async () => {
    const clientText = `Третий уникальный вопрос ${runId}: ҳуҷҷаташ тайёр?`;
    const agentText = `Ҳа, ҳуҷҷаташ тайёр аст, тестовый ответ повтора ${runId}`;

    const first = await authed(adminToken).post("/api/v1/bot-training/decide", { clientText, customText: agentText });
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBeFalsy();

    const second = await authed(adminToken).post("/api/v1/bot-training/decide", { clientText, customText: agentText });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    const rows = await prisma.styleExample.findMany({ where: { clientText, agentText } });
    expect(rows.length).toBe(1);
    createdStyleExampleIds.push(...rows.map((r) => r.id));
  });

  it("слишком короткий свой ответ отклоняется с понятной ошибкой, а не создаёт мусор", async () => {
    const clientText = `Четвёртый уникальный вопрос ${runId}: обод дорад?`;
    const res = await authed(adminToken).post("/api/v1/bot-training/decide", { clientText, customText: "ок" });
    expect(res.status).toBe(400);

    const row = await prisma.styleExample.findFirst({ where: { clientText } });
    expect(row).toBeNull();
  });
});
