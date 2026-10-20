import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Шаг 5, «Чаты»: срезы «Ждут человека / Бот на паузе / Мои» и предупреждения
 * сверху инбокса.
 *
 * GET /conversations теперь отдаёт `counts` (apps/api/src/routes/conversations.ts,
 * loadSegmentCounts) и `alerts` (loadInboxAlerts), а каждая строка списка —
 * `awaitingHumanSince` (из lastMessageAt, если последняя реплика от клиента) и
 * `pausedSince` (из новой колонки BotConversation.botPausedAt, только пока пауза
 * действует). Раньше вместо этого в вёрстке стояла честная заглушка «Нет данных».
 */

const runId = Date.now();
const password = "testpass123";
const phone = `+99291${String(runId).slice(-7)}`;

let directorId: string;
let clientId: string;
let token: string;
const createdBotIds: string[] = [];

const WAITING = `Ждёт человека ${runId}`;
const PAUSED_FRESH = `Пауза свежая ${runId}`;
const PAUSED_OLD = `Пауза старая ${runId}`;
const MINE = `Мой клиент ${runId}`;
const ANSWERED = `Отвечено уже ${runId}`;

beforeAll(async () => {
  const director = await prisma.agent.create({
    data: {
      fullName: "Директор срезов",
      phone,
      passwordHash: await bcrypt.hash(password, 10),
      role: "DIRECTOR",
      isActive: true,
    },
  });
  directorId = director.id;

  // Клиент закреплён за ТЕМ ЖЕ директором — так срез «Мои» проверяется без
  // второй учётной записи: assignedAgentId ссылается на Agent любой роли.
  const client = await prisma.client.create({
    data: {
      fullName: "Клиент срезов",
      phone: `+99293${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: directorId,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;

  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;

  // Ждёт человека: последняя реплика — от клиента, ответа нет.
  const waiting = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `sub-wait-${runId}`,
      name: WAITING,
      messages: [{ role: "user", content: `ответьте мне ${runId}` }],
      lastMessageAt: new Date(Date.now() - 5 * 60_000),
    },
  });
  createdBotIds.push(waiting.id);

  // Пауза, поставленная недавно.
  const pausedFresh = await prisma.botConversation.create({
    data: {
      channel: "WHATSAPP",
      subscriberId: `sub-pf-${runId}`,
      name: PAUSED_FRESH,
      messages: [
        { role: "user", content: `вопрос ${runId}` },
        { role: "assistant", content: "ок", by: { kind: "manual" } },
      ],
      lastMessageAt: new Date(Date.now() - 60_000),
      pausedUntil: new Date(Date.now() + 60 * 60_000),
      botPausedAt: new Date(Date.now() - 10 * 60_000),
    },
  });
  createdBotIds.push(pausedFresh.id);

  // Пауза, поставленная больше суток назад — попадает в «на паузе больше суток».
  const pausedOld = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `sub-po-${runId}`,
      name: PAUSED_OLD,
      messages: [
        { role: "user", content: `вопрос ${runId}` },
        { role: "assistant", content: "ок", by: { kind: "manual" } },
      ],
      lastMessageAt: new Date(Date.now() - 26 * 60 * 60_000),
      pausedUntil: new Date(Date.now() + 60 * 60_000),
      botPausedAt: new Date(Date.now() - 26 * 60 * 60_000),
    },
  });
  createdBotIds.push(pausedOld.id);

  // Диалог клиента, закреплённого за директором — попадает в срез «Мои».
  const mine = await prisma.botConversation.create({
    data: {
      channel: "WHATSAPP",
      subscriberId: `sub-mine-${runId}`,
      name: MINE,
      clientId: client.id,
      messages: [
        { role: "user", content: `вопрос ${runId}` },
        { role: "assistant", content: "ок", by: { kind: "manual" } },
      ],
      lastMessageAt: new Date(Date.now() - 2 * 60_000),
    },
  });
  createdBotIds.push(mine.id);

  // Отвечено — последняя реплика от бота, не ждёт человека и не на паузе.
  const answered = await prisma.botConversation.create({
    data: {
      channel: "WHATSAPP",
      subscriberId: `sub-ans-${runId}`,
      name: ANSWERED,
      messages: [
        { role: "user", content: `вопрос ${runId}` },
        { role: "assistant", content: "ок" },
      ],
      lastMessageAt: new Date(Date.now() - 3 * 60_000),
    },
  });
  createdBotIds.push(answered.id);
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: { in: createdBotIds } } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.session.deleteMany({ where: { agentId: directorId } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
});

function list(query = "") {
  return request(app).get(`/api/v1/conversations${query}`).set("Authorization", `Bearer ${token}`);
}

describe("инбокс: срезы и предупреждения (шаг 5, 10.09.2026)", () => {
  it("awaitingHumanSince стоит только у диалога, где последним писал клиент", async () => {
    const res = await list(`?q=${encodeURIComponent(String(runId))}`);
    expect(res.status).toBe(200);
    const items: { name: string; awaitingHumanSince: string | null }[] = res.body.items;
    expect(items.find((i) => i.name === WAITING)?.awaitingHumanSince).not.toBeNull();
    expect(items.find((i) => i.name === ANSWERED)?.awaitingHumanSince).toBeNull();
    expect(items.find((i) => i.name === PAUSED_FRESH)?.awaitingHumanSince).toBeNull();
  });

  it("pausedSince стоит только пока пауза действует", async () => {
    const res = await list(`?q=${encodeURIComponent(String(runId))}`);
    const items: { name: string; pausedSince: string | null }[] = res.body.items;
    expect(items.find((i) => i.name === PAUSED_FRESH)?.pausedSince).not.toBeNull();
    expect(items.find((i) => i.name === PAUSED_OLD)?.pausedSince).not.toBeNull();
    expect(items.find((i) => i.name === WAITING)?.pausedSince).toBeNull();
  });

  it("срез needsHuman отдаёт только диалог, ждущий ответа", async () => {
    const res = await list(`?q=${encodeURIComponent(String(runId))}&needsHuman=1`);
    const names: string[] = res.body.items.map((i: { name: string }) => i.name);
    expect(names).toContain(WAITING);
    expect(names).not.toContain(ANSWERED);
    expect(names).not.toContain(PAUSED_FRESH);
  });

  it("срез paused отдаёт оба диалога на паузе, независимо от давности", async () => {
    const res = await list(`?q=${encodeURIComponent(String(runId))}&paused=1`);
    const names: string[] = res.body.items.map((i: { name: string }) => i.name);
    expect(names).toEqual(expect.arrayContaining([PAUSED_FRESH, PAUSED_OLD]));
    expect(names).not.toContain(WAITING);
  });

  it("срез mine отдаёт только диалог клиента, закреплённого за собой", async () => {
    const res = await list(`?q=${encodeURIComponent(String(runId))}&mine=1`);
    // Список подписывает диалог именем закреплённого клиента, а не именем
    // подписчика (так было и до срезов): единственная строка — «Клиент срезов».
    const names: string[] = res.body.items.map((i: { name: string }) => i.name);
    expect(names).toEqual(["Клиент срезов"]);
  });

  it("counts считает каждый срез независимо от активного фильтра выборки", async () => {
    // ?paused=1 сужает items, но counts — это то же, что видели бы кнопки среза:
    // сколько диалогов попадёт в КАЖДЫЙ срез при этих же channel/accountId/q.
    const res = await list(`?q=${encodeURIComponent(String(runId))}&paused=1`);
    expect(res.body.counts.all).toBe(5);
    expect(res.body.counts.needsHuman).toBe(1);
    expect(res.body.counts.paused).toBe(2);
    expect(res.body.counts.mine).toBe(1);
  });

  it("alerts приходит в ответе структурой, годной для тихих строк над списком", async () => {
    // Без строгого сравнения значений: alerts считается по ВСЕМ диалогам в области
    // видимости (не сужен текущим q), и в общей тестовой базе кроме этого прогона
    // может быть более старое ожидание/пауза — сравнивать точные значения нельзя,
    // не рискуя ложным падением на чужих данных.
    const res = await list("?page=1");
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveProperty("longestWaitingHuman");
    expect(res.body.alerts).toHaveProperty("pausedOverDay");
    expect(typeof res.body.alerts.pausedOverDay.count).toBe("number");
    expect(Array.isArray(res.body.alerts.pausedOverDay.names)).toBe(true);
    // Наша старая пауза (>суток) точно должна попасть хотя бы в счёт.
    expect(res.body.alerts.pausedOverDay.count).toBeGreaterThanOrEqual(1);
  });
});
