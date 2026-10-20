import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { WEBSITE_CHANNEL } from "../src/messengers/channels.js";

/**
 * ПОВТОРНАЯ ДОСТАВКА ИЗ ЧАТА НА САЙТЕ (22.09.2026).
 *
 * У всех остальных каналов есть устойчивый id события, и общий замок
 * `lib/webhookDedupe.ts` работает по нему. У чата на сайте такого id нет, и
 * проверки не было никакой: ретрай сайта после обрыва связи клал реплику
 * посетителя в переписку второй раз и запускал второй независимый ход бота —
 * посетитель видел два ответа.
 *
 * Бот здесь выключен нарочно: проверяется сам замок доставки, а не ход модели —
 * при выключенном боте сообщение всё равно ложится в переписку (агент отвечает
 * сам), и дубль виден по числу строк, без похода к модели.
 */

const runId = Date.now();
const API_KEY = `test-dup-key-${runId}`;
const SESSION_ID = `dupsess${runId}abcdefgh`;

let savedBot = { botEnabled: false, botWebsiteChatEnabled: false };

beforeAll(async () => {
  process.env.WEBSITE_LEAD_API_KEY = API_KEY;
  savedBot = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botEnabled: true, botWebsiteChatEnabled: true },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { botWebsiteChatEnabled: false },
  });
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: savedBot });
  await prisma.botConversation.deleteMany({ where: { channel: WEBSITE_CHANNEL, subscriberId: SESSION_ID } });
  // Замки доставки НЕ чистятся по всему каналу (28.09.2026): соседний файл,
  // идущий в другом процессе на той же базе, терял свой замок посреди теста и
  // писал реплику второй раз («expected 2 to be 1»). Ключи этого файла уникальны
  // (в sessionId есть runId), старые строки убирает плановая чистка (index.ts).
  await prisma.$disconnect();
});

async function send(text: string, messageId?: string) {
  return request(app)
    .post("/api/v1/webhooks/website-chat")
    .set("X-Api-Key", API_KEY)
    .send({ sessionId: SESSION_ID, text, ...(messageId ? { messageId } : {}) });
}

async function messageCount(): Promise<number> {
  const conv = await prisma.botConversation.findFirst({
    where: { channel: WEBSITE_CHANNEL, subscriberId: SESSION_ID },
    select: { messages: true },
  });
  if (!conv) return 0;
  const messages = conv.messages as unknown[];
  return Array.isArray(messages) ? messages.length : 0;
}

describe("Чат на сайте: повторная доставка не задваивает реплику посетителя", () => {
  it("тот же текст из той же сессии вторым вызовом не пишется второй раз", async () => {
    const first = await send("Здравствуйте, сколько стоит двушка в Сомони");
    expect(first.status).toBe(200);
    const after1 = await messageCount();
    expect(after1).toBeGreaterThan(0);

    // Ретрай сайта: тот же самый вызов ушёл второй раз.
    const second = await send("Здравствуйте, сколько стоит двушка в Сомони");
    expect(second.status).toBe(200);
    expect(await messageCount()).toBe(after1);
  });

  it("другой текст той же сессии проходит как настоящая реплика", async () => {
    const before = await messageCount();
    const res = await send("А в Фирдавси есть что-то до 60 тысяч?");
    expect(res.status).toBe(200);
    expect(await messageCount()).toBe(before + 1);
  });

  it("свой идентификатор сайта различает два одинаковых сообщения", async () => {
    // Человек честно повторил то же слово — но сайт прислал разные id, и это
    // точнее совпадения текста: обе реплики должны дойти.
    const before = await messageCount();
    await send("да", `m-${runId}-1`);
    const afterFirst = await messageCount();
    expect(afterFirst).toBe(before + 1);

    await send("да", `m-${runId}-2`);
    expect(await messageCount()).toBe(afterFirst + 1);

    // А тот же id второй раз — это повтор доставки.
    await send("да", `m-${runId}-2`);
    expect(await messageCount()).toBe(afterFirst + 1);
  });

  /**
   * Ночная проверка 01.10.2026, №133: окно дублей считалось «бакетом» по времени
   * (целая часть от Date.now() / 15 с), и повтор, пришедший на границе двух
   * бакетов (14,9-я секунда и 300 мс спустя), получал другой ключ и проходил
   * как новая реплика — посетитель видел два ответа. Теперь окно — от начала
   * первой доставки, без границ.
   */
  describe("граница окна дублей", () => {
    afterEach(() => vi.useRealTimers());

    it("доставка на 14,9-й секунде и повтор через 300 мс — одна реплика", async () => {
      const WINDOW = 15_000;
      const base = Math.ceil(Date.now() / WINDOW) * WINDOW + 10 * WINDOW; // кратно окну, в будущем
      const text = `Повтор на границе окна ${runId}`;
      vi.useFakeTimers({ toFake: ["Date"], now: new Date(base + 14_900) });
      const first = await send(text);
      expect(first.status).toBe(200);
      const after1 = await messageCount();

      vi.setSystemTime(new Date(base + 15_200)); // уже следующий бакет по Date.now() / 15 с
      const second = await send(text);
      expect(second.status).toBe(200);
      expect(await messageCount()).toBe(after1);
    });

    it("то же слово позже окна — новая реплика, а не вечный дубль", async () => {
      const text = `Позже окна ${runId}`;
      vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
      await send(text);
      const after1 = await messageCount();
      vi.setSystemTime(new Date(Date.now() + 20_000));
      await send(text);
      expect(await messageCount()).toBe(after1 + 1);
    });
  });
});
