import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * ОТКРЫТЫЙ ДИАЛОГ НЕ ДОЛЖЕН САМ СЕБЯ ПЕРЕЗАПРАШИВАТЬ ПО КРУГУ (19.09.2026).
 *
 * `GET /conversations/:id` писал `readAt: new Date()` и публиковал
 * `conversation.updated` БЕЗУСЛОВНО, на каждое чтение. Событие уходит
 * держателю карточки и надзорным ролям, отправителя из рассылки не исключая, —
 * то есть приходит и тому, кто диалог только что открыл. На фронте
 * `conversation.updated` гасит ключи `["conversations"]` префиксно
 * (apps/web/src/lib/liveEvents.ts), включая ключ самого открытого диалога, и
 * активный запрос уходит на сервер заново. Круг замыкался за время склейки
 * инвалидаций (~250 мс) и крутился, пока агент читал переписку: запись в базу,
 * рассылка события и выгрузка всей истории на каждый оборот.
 *
 * Здесь проверяется то, что этот круг разрывает: отметка «прочитано» ставится
 * ТОЛЬКО когда индикатор непрочитанного и правда горит (`lastMessageAt >
 * readAt`). Без починки второе открытие снова сдвигает `readAt`, и первый же
 * тест краснеет.
 *
 * Само SSE-событие здесь не ловится намеренно: публикация идёт за тем же
 * условием, что и запись (routes/conversations.ts, needsReadReceipt), и
 * проверять её отдельно значило бы проверять одну строку дважды. Наблюдаемый
 * признак — `readAt` в базе.
 */

const runId = Date.now();
const password = "testpass123";
const phone = `+99283${String(runId).slice(-7)}`;

let directorId = "";
let token = "";
let botId = "";
let tgId = "";

beforeAll(async () => {
  const director = await prisma.agent.create({
    data: {
      fullName: "Директор круга запросов",
      phone,
      passwordHash: await bcrypt.hash(password, 10),
      role: "DIRECTOR",
      isActive: true,
    },
  });
  directorId = director.id;
  token = (await request(app).post("/api/v1/auth/login").send({ phone, password })).body.accessToken as string;

  const lastMessageAt = new Date();
  const bot = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `loop-${runId}`,
      name: `Круг запросов ${runId}`,
      messages: [{ role: "user", content: "здравствуйте" }] as never,
      lastMessageAt,
      readAt: null,
    },
  });
  botId = bot.id;

  const tg = await prisma.telegramConversation.create({
    data: {
      chatId: `tg-loop-${runId}`,
      username: `loop${runId}`,
      messages: [{ role: "user", content: "здравствуйте" }] as never,
      lastMessageAt,
      readAt: null,
    },
  });
  tgId = tg.id;
});

afterAll(async () => {
  if (botId) await prisma.botConversation.deleteMany({ where: { id: botId } });
  if (tgId) await prisma.telegramConversation.deleteMany({ where: { id: tgId } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
});

async function open(id: string) {
  const res = await request(app).get(`/api/v1/conversations/${id}`).set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
}

describe("Открытие диалога: отметка «прочитано» ставится один раз, а не на каждое чтение", () => {
  it("первое открытие ставит readAt, повторные его НЕ трогают", async () => {
    await open(botId);
    const afterFirst = await prisma.botConversation.findUnique({ where: { id: botId }, select: { readAt: true } });
    expect(afterFirst?.readAt).not.toBeNull();

    // Два повторных чтения подряд — ровно то, что делал круг инвалидаций.
    await open(botId);
    await open(botId);
    const afterRepeat = await prisma.botConversation.findUnique({ where: { id: botId }, select: { readAt: true } });
    expect(afterRepeat?.readAt?.getTime()).toBe(afterFirst?.readAt?.getTime());
  });

  it("новое сообщение клиента снова зажигает индикатор, и следующее открытие его гасит", async () => {
    const before = await prisma.botConversation.findUnique({ where: { id: botId }, select: { readAt: true } });
    // Клиент написал ПОСЛЕ прочтения — теперь отметка обязана сдвинуться.
    await prisma.botConversation.update({
      where: { id: botId },
      data: { lastMessageAt: new Date(Date.now() + 60_000) },
    });

    await open(botId);
    const after = await prisma.botConversation.findUnique({ where: { id: botId }, select: { readAt: true } });
    expect(after?.readAt!.getTime()).toBeGreaterThan(before!.readAt!.getTime());
  });

  it("Telegram ведёт себя так же — правило одно на обе таблицы", async () => {
    const tgPath = (await request(app).get("/api/v1/conversations?pageSize=100").set("Authorization", `Bearer ${token}`))
      .body.items.find((i: { id: string }) => i.id.endsWith(tgId)).id as string;

    await open(tgPath);
    const afterFirst = await prisma.telegramConversation.findUnique({ where: { id: tgId }, select: { readAt: true } });
    expect(afterFirst?.readAt).not.toBeNull();

    await open(tgPath);
    const afterRepeat = await prisma.telegramConversation.findUnique({ where: { id: tgId }, select: { readAt: true } });
    expect(afterRepeat?.readAt?.getTime()).toBe(afterFirst?.readAt?.getTime());
  });
});
