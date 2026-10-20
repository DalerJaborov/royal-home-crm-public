import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Инбокс «Сообщения»: список диалогов.
 *
 * Тест написан ДО переписывания выборки и фиксирует поведение, которое нельзя
 * потерять: последняя реплика, счётчик, «непрочитано», поиск по тексту переписки,
 * склейка двух таблиц (бот-платформа + Telegram) в один отсортированный список
 * и честный total для пагинации.
 *
 * Отдельно проверяется главное ради чего всё затевалось: список не должен тянуть
 * из базы всю переписку целиком — только последнюю реплику и длину.
 */

const runId = Date.now();

/**
 * Имена диалогов — С НОМЕРОМ ПРОГОНА, а не постоянные.
 *
 * Тест отбирает свои записи из общего списка ПО ИМЕНИ, а убирал за собой только по
 * идентификаторам. Любой прерванный прогон (Ctrl+C, упавшая база, вытесненная
 * сессия) оставлял в базе диалог с тем же именем НАВСЕГДА, и следующий прогон
 * находил в списке две «Отвечено» вместо одной. Падение выглядело как поломка
 * инбокса, хотя ломался стенд: 14.08.2026 на это ушёл лишний час.
 */
const HEAVY = `Тяжёлый диалог ${runId}`;
const ANSWERED = `Отвечено ${runId}`;
const EMPTY = `Пустой ${runId}`;
const LONG = `Длинная реплика ${runId}`;
const BROKEN = `Повреждённый ${runId}`;
const password = "testpass123";
const phone = `+99290${String(runId).slice(-7)}`;

let token: string;
const createdBotIds: string[] = [];
const createdTgIds: string[] = [];
let directorId: string;

/** Диалог из N реплик: чётные — от клиента, нечётные — ответ бота. */
function messages(count: number, tail: string) {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (let i = 0; i < count - 1; i++) {
    out.push({ role: i % 2 === 0 ? "user" : "assistant", content: `реплика ${i}` });
  }
  out.push({ role: "user", content: tail });
  return out;
}

beforeAll(async () => {
  const director = await prisma.agent.create({
    data: {
      fullName: "Инбокс Тестов",
      phone,
      passwordHash: await bcrypt.hash(password, 10),
      role: "DIRECTOR",
      isActive: true,
    },
  });
  directorId = director.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken;

  // Тяжёлый диалог: 400 реплик. Именно на таких список и раздувался.
  const heavy = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `sub-heavy-${runId}`,
      name: HEAVY,
      messages: messages(400, `последнее слово ${runId}`),
      lastMessageAt: new Date("2026-07-20T10:00:00Z"),
    },
  });
  createdBotIds.push(heavy.id);

  // Прочитанный диалог: последняя реплика от бота — «непрочитано» быть не должно.
  const answered = await prisma.botConversation.create({
    data: {
      channel: "WHATSAPP",
      subscriberId: `sub-answered-${runId}`,
      name: ANSWERED,
      messages: [
        { role: "user", content: "здравствуйте" },
        { role: "assistant", content: `ответ бота ${runId}` },
      ],
      lastMessageAt: new Date("2026-07-19T10:00:00Z"),
      readAt: new Date("2026-07-19T11:00:00Z"),
    },
  });
  createdBotIds.push(answered.id);

  // Пустой диалог: реплик нет вообще — не должен ронять список.
  const empty = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `sub-empty-${runId}`,
      name: EMPTY,
      messages: [],
      lastMessageAt: new Date("2026-07-18T10:00:00Z"),
    },
  });
  createdBotIds.push(empty.id);

  // Telegram — вторая таблица того же инбокса, самый свежий диалог.
  const tg = await prisma.telegramConversation.create({
    data: {
      chatId: `chat-${runId}`,
      username: `user${runId}`,
      messages: messages(30, `телеграм хвост ${runId}`),
      lastMessageAt: new Date("2026-07-21T10:00:00Z"),
    },
  });
  createdTgIds.push(tg.id);
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: { in: createdBotIds } } });
  await prisma.telegramConversation.deleteMany({ where: { id: { in: createdTgIds } } });
  await prisma.session.deleteMany({ where: { agentId: directorId } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
});

/**
 * Свои диалоги ищутся ПО НОМЕРУ ПРОГОНА (`?q=<runId>`), а не берутся с первой
 * страницы общего списка. Страница — 20 строк, отсортированных по времени
 * последней реплики, а диалоги этого файла датированы июлем 2026: на общей
 * базе, где соседние тесты и прерванные прогоны оставили сотни диалогов
 * посвежее, они на первую страницу не попадают вовсе. Так 25.09.2026 файл
 * краснел и на чистом `main`, и на любой ветке, хотя инбокс был исправен.
 * Номер прогона входит в имя каждого своего диалога (см. HEAVY/ANSWERED/EMPTY/
 * LONG/BROKEN, у телеграмного — в username), поэтому поиск по нему отдаёт ровно
 * свои записи. Сами проверки (последняя реплика, счётчик, «непрочитано»,
 * склейка и порядок) от фильтра не зависят: он целиком в SQL, как и сортировка.
 */
const MINE = `?q=${encodeURIComponent(String(runId))}`;

function list(query = MINE) {
  return request(app).get(`/api/v1/conversations${query}`).set("Authorization", `Bearer ${token}`);
}

describe("инбокс: список диалогов", () => {
  it("отдаёт последнюю реплику и счётчик, не возвращая переписку целиком", async () => {
    const res = await list();
    expect(res.status).toBe(200);

    const heavy = res.body.items.find((i: { name: string }) => i.name === HEAVY);
    expect(heavy).toBeTruthy();
    expect(heavy.messagesCount).toBe(400);
    expect(heavy.lastMessage).toEqual({ role: "user", content: `последнее слово ${runId}` });

    // Тела переписки в ответе быть не должно ни под каким ключом: иначе смысл
    // облегчения выборки теряется на сериализации.
    expect(heavy.messages).toBeUndefined();
    expect(JSON.stringify(heavy)).not.toContain("реплика 0");
  });

  it("длинную реплику обрезает до 160 символов", async () => {
    const long = "я".repeat(500);
    const conv = await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        subscriberId: `sub-long-${runId}`,
        name: LONG,
        messages: [{ role: "user", content: long }],
        lastMessageAt: new Date("2026-07-17T10:00:00Z"),
      },
    });
    createdBotIds.push(conv.id);

    const res = await list();
    const item = res.body.items.find((i: { name: string }) => i.name === LONG);
    expect(item.lastMessage.content).toHaveLength(160);
  });

  it("считает непрочитанным только диалог, где последним написал клиент", async () => {
    const res = await list();
    const heavy = res.body.items.find((i: { name: string }) => i.name === HEAVY);
    const answered = res.body.items.find((i: { name: string }) => i.name === ANSWERED);
    expect(heavy.unread).toBe(true);
    expect(answered.unread).toBe(false);
  });

  it("не спотыкается о диалог без единой реплики", async () => {
    const res = await list();
    const empty = res.body.items.find((i: { name: string }) => i.name === EMPTY);
    expect(empty).toBeTruthy();
    expect(empty.messagesCount).toBe(0);
    expect(empty.lastMessage).toBeNull();
    expect(empty.unread).toBe(false);
  });

  it("склеивает обе таблицы и сортирует по времени последнего сообщения", async () => {
    const res = await list();
    const mine = res.body.items.filter((i: { name: string }) =>
      [HEAVY, ANSWERED, EMPTY, `@user${runId}`].includes(i.name)
    );
    expect(mine.map((i: { name: string }) => i.name)).toEqual([
      `@user${runId}`,
      HEAVY,
      ANSWERED,
      EMPTY,
    ]);
    const tg = mine.find((i: { name: string }) => i.name === `@user${runId}`);
    expect(tg.channel).toBe("TELEGRAM");
    expect(tg.id.startsWith("tg_")).toBe(true);
    expect(tg.messagesCount).toBe(30);
  });

  it("ищет по тексту переписки, а не только по имени", async () => {
    const byTail = await list(`?q=${encodeURIComponent(`последнее слово ${runId}`)}`);
    expect(byTail.body.items.map((i: { name: string }) => i.name)).toEqual([HEAVY]);

    // Слово встречается в середине переписки, а не в последней реплике —
    // поиск обязан находить и такие.
    const inside = await list(`?q=${encodeURIComponent("реплика 7")}`);
    const names = inside.body.items.map((i: { name: string }) => i.name);
    expect(names).toContain(HEAVY);

    const byName = await list(`?q=${encodeURIComponent(ANSWERED)}`);
    expect(byName.body.items.map((i: { name: string }) => i.name)).toEqual([ANSWERED]);
  });

  it("фильтрует по каналу и отдаёт список каналов из данных", async () => {
    const res = await list(`?channel=TELEGRAM&q=${encodeURIComponent(String(runId))}`);
    expect(res.body.items.every((i: { channel: string }) => i.channel === "TELEGRAM")).toBe(true);
    expect(res.body.channels).toContain("TELEGRAM");
    expect(res.body.channels).toContain("INSTAGRAM");

    const wa = await list(`?channel=WHATSAPP&q=${encodeURIComponent(String(runId))}`);
    expect(wa.body.items.map((i: { name: string }) => i.name)).toContain(ANSWERED);
    expect(wa.body.items.map((i: { name: string }) => i.name)).not.toContain(HEAVY);
  });

  it("total считает все совпадения, а не только текущую страницу", async () => {
    // По runId совпадают ПЯТЬ диалогов этого прогона: тяжёлый, отвечённый, пустой,
    // «длинная реплика» (созданный тестом выше по файлу) и телеграмный. Номер прогона
    // теперь входит в ИМЯ каждого из них — см. HEAVY/ANSWERED/EMPTY/LONG в начале
    // файла и причину, по которой имена перестали быть постоянными.
    //
    // Двадцать пять диалогов соседнего теста про страницы сюда не попадают: он идёт
    // НИЖЕ по файлу, а vitest выполняет тесты в порядке объявления.
    const res = await list(`?q=${encodeURIComponent(String(runId))}`);
    expect(res.body.total).toBe(res.body.items.length);
    expect(res.body.total).toBe(5);
    expect(res.body.pageSize).toBe(20);
  });

  it("листает страницы: вторая отдаёт следующие диалоги, а не повтор первой", async () => {
    // 25 диалогов одной пометкой — больше страницы (20), чтобы проверить границу.
    const tag = `стр-${runId}`;
    for (let i = 0; i < 25; i++) {
      const c = await prisma.botConversation.create({
        data: {
          channel: "INSTAGRAM",
          subscriberId: `sub-page-${runId}-${i}`,
          name: `Страничный ${i}`,
          messages: [{ role: "user", content: tag }],
          // Убывающее время: порядок предсказуем и не зависит от порядка вставки.
          lastMessageAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 25 - i)),
        },
      });
      createdBotIds.push(c.id);
    }

    const first = await list(`?q=${encodeURIComponent(tag)}`);
    expect(first.body.total).toBe(25);
    expect(first.body.items).toHaveLength(20);
    expect(first.body.items[0].name).toBe("Страничный 0");

    const second = await list(`?q=${encodeURIComponent(tag)}&page=2`);
    expect(second.body.total).toBe(25);
    expect(second.body.items).toHaveLength(5);
    expect(second.body.items[0].name).toBe("Страничный 20");

    // Страницы не пересекаются — самая частая ошибка при склейке двух источников.
    const firstIds = new Set(first.body.items.map((i: { id: string }) => i.id));
    expect(second.body.items.some((i: { id: string }) => firstIds.has(i.id))).toBe(false);
  });

  /**
   * Инбокс собирает страницу объединённого списка, поднимая `page * PAGE_SIZE`
   * строк из КАЖДОЙ таблицы — а колонки там с переписками. Без потолка у номера
   * страницы один адрес в строке браузера («?page=1000000») просил у базы
   * миллионы таких строк (аудит 09.08.2026).
   */
  it("бессмысленно большой номер страницы отвергается, а не выгребает всю базу", async () => {
    const res = await list("?page=1000000");
    expect(res.status).toBe(400);
  });

  it("не падает, если в колонке переписки лежит не массив", async () => {
    // Такое значение может остаться от старого формата или сбойной записи —
    // одна повреждённая строка не должна ронять весь инбокс.
    const broken = await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        subscriberId: `sub-broken-${runId}`,
        name: BROKEN,
        messages: { oops: true },
        lastMessageAt: new Date("2026-07-16T10:00:00Z"),
      },
    });
    createdBotIds.push(broken.id);

    const res = await list();
    expect(res.status).toBe(200);
    const item = res.body.items.find((i: { name: string }) => i.name === BROKEN);
    expect(item.messagesCount).toBe(0);
    expect(item.lastMessage).toBeNull();
  });
});
