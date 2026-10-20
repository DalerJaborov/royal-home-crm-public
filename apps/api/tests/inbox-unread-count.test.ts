import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * НЕПРОЧИТАННЫЕ ЧИСЛОМ (владелец 12.09.2026: «покажи числом, а не точкой»).
 *
 * До этого дня API отдавал только булево `unread`, и список рисовал точку —
 * «что-то есть», без ответа «одно сообщение или пятнадцать». Теперь рядом идёт
 * `unreadCount`: хвост подряд идущих реплик клиента после последнего ответа
 * бота или агента (routes/conversations.ts, loadUnreadCounts).
 *
 * Почему именно хвост, а не «сообщения новее readAt»: у реплик в jsonb поле
 * `at` необязательно, у старых диалогов его нет вовсе, и счёт по нему давал бы
 * ноль на половине базы. Хвост есть всегда и совпадает с тем, что видит
 * человек, открывая чат.
 */

const runId = Date.now();
const password = "testpass123";
const phone = `+99281${String(runId).slice(-7)}`;

let directorId = "";
let token = "";
const botIds: string[] = [];
let tgId = "";

const THREE = `Написал трижды ${runId}`;
const ONE = `Написал однажды ${runId}`;
const ANSWERED = `Бот ответил ${runId}`;
const READ = `Прочитано ${runId}`;

function msg(role: "user" | "assistant", content: string) {
  return { role, content };
}

beforeAll(async () => {
  const director = await prisma.agent.create({
    data: {
      fullName: "Директор непрочитанного",
      phone,
      passwordHash: await bcrypt.hash(password, 10),
      role: "DIRECTOR",
      isActive: true,
    },
  });
  directorId = director.id;
  token = (await request(app).post("/api/v1/auth/login").send({ phone, password })).body.accessToken as string;

  const now = new Date();
  const make = async (name: string, messages: unknown[], readAt: Date | null) => {
    const c = await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        subscriberId: `${runId}-${name}`,
        name,
        messages: messages as never,
        lastMessageAt: now,
        readAt,
      },
    });
    botIds.push(c.id);
    return c.id;
  };

  // Три реплики клиента подряд после ответа бота — ждём 3.
  await make(
    THREE,
    [msg("user", "привет"), msg("assistant", "здравствуйте"), msg("user", "а"), msg("user", "б"), msg("user", "в")],
    null
  );
  // Одна реплика клиента после ответа — ждём 1.
  await make(ONE, [msg("user", "привет"), msg("assistant", "здравствуйте"), msg("user", "ещё вопрос")], null);
  // Последним ответил бот — непрочитанного нет вовсе.
  await make(ANSWERED, [msg("user", "привет"), msg("assistant", "здравствуйте")], null);
  // Клиент написал дважды, но диалог ОТКРЫВАЛИ после этого — ноль, хотя хвост есть.
  await make(READ, [msg("assistant", "здравствуйте"), msg("user", "раз"), msg("user", "два")], new Date(now.getTime() + 60_000));

  // Telegram-диалог: вторая таблица того же списка, считаться должен так же.
  const tg = await prisma.telegramConversation.create({
    data: {
      chatId: `tg-${runId}`,
      username: `unreadtg${runId}`,
      messages: [msg("assistant", "здравствуйте"), msg("user", "раз"), msg("user", "два")] as never,
      lastMessageAt: now,
    },
  });
  tgId = tg.id;
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: { in: botIds } } });
  if (tgId) await prisma.telegramConversation.deleteMany({ where: { id: tgId } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
});

async function list() {
  const res = await request(app).get("/api/v1/conversations?pageSize=100").set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.items as { id: string; name: string | null; unread: boolean; unreadCount: number }[];
}

describe("Инбокс: непрочитанные приходят числом", () => {
  it("хвост подряд идущих реплик клиента считается, ответ бота обрывает счёт", async () => {
    const items = await list();
    const three = items.find((i) => i.name === THREE);
    const one = items.find((i) => i.name === ONE);
    const answered = items.find((i) => i.name === ANSWERED);

    expect(three?.unread).toBe(true);
    expect(three?.unreadCount).toBe(3);

    expect(one?.unread).toBe(true);
    expect(one?.unreadCount).toBe(1);

    // Последним ответил бот — ждать нечего ни признаком, ни числом.
    expect(answered?.unread).toBe(false);
    expect(answered?.unreadCount).toBe(0);
  });

  it("открытый диалог обнуляет счётчик, хотя хвост реплик в переписке остаётся", async () => {
    const items = await list();
    const read = items.find((i) => i.name === READ);
    expect(read?.unread).toBe(false);
    expect(read?.unreadCount).toBe(0);
  });

  it("Telegram считается так же, как Meta: одна выборка на обе таблицы", async () => {
    const items = await list();
    const tg = items.find((i) => i.id.endsWith(tgId));
    expect(tg).toBeDefined();
    expect(tg?.unreadCount).toBe(2);
  });

  it("открытие диалога сбрасывает счётчик до нуля", async () => {
    const target = (await list()).find((i) => i.name === THREE)!;
    const opened = await request(app)
      .get(`/api/v1/conversations/${target.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(opened.status).toBe(200);

    const after = (await list()).find((i) => i.name === THREE);
    expect(after?.unread).toBe(false);
    expect(after?.unreadCount).toBe(0);
  });
});
