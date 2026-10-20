import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { waitForCount, waitForSettled } from "./helpers/waitFor.js";
import bcrypt from "bcrypt";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { publish, streamStats, MAX_STREAMS_PER_AGENT, __resetEventBusForTests } from "../src/lib/eventBus.js";
import { publishMessageNew } from "../src/lib/livePublish.js";
import { beginShutdown, __resetShutdownStateForTests } from "../src/lib/shutdownState.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * ПОТОК ЖИВЫХ СОБЫТИЙ (12.09.2026) — аутентификация, адресация, сердцебиение,
 * предел подписок и сама шина.
 *
 * Поток проверяется НАСТОЯЩИМ сокетом, а не supertest: supertest ждёт конец
 * ответа, а у text/event-stream конца нет — тест висел бы до таймаута. Поэтому
 * поднимаем сервер на случайном порту и читаем тело по кускам.
 */

const runId = Date.now();
const password = "testpass123";

let server: http.Server;
let baseUrl: string;
let directorId: string;
let agentAId: string;
let agentBId: string;
let directorToken: string;
let agentAToken: string;
let agentBToken: string;
/** Агенты нагрузочной проверки — убираются вместе с остальными. */
let loadAgentIds: string[] = [];

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/** Открыть поток и вернуть читалку кусков вместе со способом закрыть соединение. */
async function openStream(token: string): Promise<{
  status: number;
  chunks: string[];
  waitFor: (needle: string, timeoutMs?: number) => Promise<string>;
  close: () => void;
}> {
  const ticketRes = await request(app).post("/api/v1/events/ticket").set("Authorization", `Bearer ${token}`);
  expect(ticketRes.status).toBe(200);
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/v1/events?ticket=${encodeURIComponent(ticketRes.body.ticket)}`, {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });
  const chunks: string[] = [];
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(decoder.decode(value, { stream: true }));
        }
      } catch {
        /* соединение закрыто тестом — это и есть ожидаемый конец */
      }
    })();
  }
  const waitFor = async (needle: string, timeoutMs = 6_000): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const text = chunks.join("");
      if (text.includes(needle)) return text;
      if (Date.now() > deadline) throw new Error(`не дождались "${needle}" в потоке: ${JSON.stringify(text)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { status: res.status, chunks, waitFor, close: () => controller.abort() };
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const director = await prisma.agent.create({
    data: { fullName: "Поток Директор", phone: `+992951${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  const agentA = await prisma.agent.create({
    data: { fullName: "Поток Агент А", phone: `+992952${runId}`, role: "AGENT", passwordHash },
  });
  agentAId = agentA.id;
  const agentB = await prisma.agent.create({
    data: { fullName: "Поток Агент Б", phone: `+992953${runId}`, role: "AGENT", passwordHash },
  });
  agentBId = agentB.id;

  directorToken = await login(director.phone);
  agentAToken = await login(agentA.phone);
  agentBToken = await login(agentB.phone);

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  __resetEventBusForTests();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.liveEventOutbox.deleteMany({ where: { type: { startsWith: "test." } } });
  await deleteAgentsWithTraces([directorId, agentAId, agentBId, ...loadAgentIds]);
});

afterEach(() => {
  __resetEventBusForTests();
});

describe("шина живых событий", () => {
  it("доставляет адресату по agentIds и не доставляет чужому", async () => {
    const mine: string[] = [];
    const foreign: string[] = [];
    const { subscribe } = await import("../src/lib/eventBus.js");
    const offA = subscribe({ agentId: agentAId, role: "AGENT", deliver: (e) => mine.push(e.type) });
    const offB = subscribe({ agentId: agentBId, role: "AGENT", deliver: (e) => foreign.push(e.type) });

    await publish({ type: "lead.pending", payload: { clientId: "c-1" }, agentIds: [agentAId] });

    offA();
    offB();
    expect(mine).toEqual(["lead.pending"]);
    expect(foreign).toEqual([]);
  });

  it("доставляет по роли и всем сразу, когда адресация пустая", async () => {
    const byRole: string[] = [];
    const plainAgent: string[] = [];
    const { subscribe } = await import("../src/lib/eventBus.js");
    const off1 = subscribe({ agentId: directorId, role: "DIRECTOR", deliver: (e) => byRole.push(e.type) });
    const off2 = subscribe({ agentId: agentAId, role: "AGENT", deliver: (e) => plainAgent.push(e.type) });

    await publish({ type: "deal.updated", payload: { dealId: "d-1" }, roles: ["DIRECTOR"] });
    await publish({ type: "pult.snapshot", payload: {} }); // широковещательное

    off1();
    off2();
    expect(byRole).toEqual(["deal.updated", "pult.snapshot"]);
    expect(plainAgent).toEqual(["pult.snapshot"]);
  });

  it("отвергает нагрузку с посторонними полями — тексты и телефоны в поток не попадают", async () => {
    const got: unknown[] = [];
    const { subscribe } = await import("../src/lib/eventBus.js");
    const off = subscribe({ agentId: agentAId, role: "AGENT", deliver: (e) => got.push(e) });

    await publish({
      type: "message.new",
      // @ts-expect-error — намеренно: проверяем, что закрытая схема это отвергнет
      payload: { conversationId: "k-1", text: "здравствуйте, мой номер +992900000000" },
      agentIds: [agentAId],
    });

    off();
    expect(got).toEqual([]);
  });

  it("кладёт событие в общую таблицу — так его видит второй процесс", async () => {
    const before = await prisma.liveEventOutbox.count();
    await publish({ type: "notification.new", payload: { notificationId: "n-1" }, agentIds: [agentAId] });
    const after = await prisma.liveEventOutbox.count();
    expect(after).toBe(before + 1);

    const row = await prisma.liveEventOutbox.findFirst({ orderBy: { seq: "desc" } });
    expect(row?.type).toBe("notification.new");
    expect(row?.agentIds).toEqual([agentAId]);
    // origin — метка процесса: по ней обход не задваивает собственные строки.
    expect(typeof row?.origin).toBe("string");
  });
});

/** Сколько строк ErrorLog содержат нашу метку. ErrorLog общий на весь прогон,
 *  поэтому считать можно только своё — иначе тест ловит чужие ошибки. */
async function countErrors(marker: string): Promise<number> {
  return prisma.errorLog.count({ where: { message: { contains: marker } } });
}

describe("публикация во время остановки (п.2 tooling-reliability-17-09)", () => {
  afterEach(() => {
    __resetShutdownStateForTests();
    vi.restoreAllMocks();
  });

  it("отказ пула при остановке — гонка, а не баг: строка в ErrorLog не появляется", async () => {
    // СВОЯ строка, а не общий счётчик таблицы (20.09.2026). Прежде тест считал
    // `errorLog.count()` целиком, а ErrorLog — таблица общая: любой другой файл
    // набора, записавший ошибку в эти же миллисекунды, сдвигал счётчик, и тест
    // падал «expected 70 to be 69» на совершенно исправном коде. Метка в тексте
    // ошибки делает проверку независимой от соседей по прогону.
    const marker = `pool-shutdown-${runId}`;
    // ОБА замера через waitForSettled: ждать в проверке «ничего не записали»
    // нечего, а `void logSystemError` предыдущего теста приземляется позже.
    const before = await waitForSettled(() => countErrors(marker));
    const spy = vi
      .spyOn(prisma.liveEventOutbox, "create")
      // Ровно текст прода 16.09 20:19, воспроизводим гонку без реального
      // закрытия общего клиента Prisma (он один на весь файл тестов).
      .mockRejectedValueOnce(new Error(`Cannot use a pool after calling end on the pool (${marker})`));

    beginShutdown();
    await publish({ type: "client.updated", payload: { clientId: `c-shutdown-${runId}` }, agentIds: [agentAId] });

    const after = await waitForSettled(() => countErrors(marker));
    expect(after).toBe(before);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("то же самое до остановки — настоящий отказ обязан попасть в ErrorLog", async () => {
    // Считаем СВОЮ строку по метке — см. предыдущий тест.
    const marker = `real-fail-${runId}`;
    const before = await countErrors(marker);
    const spy = vi
      .spyOn(prisma.liveEventOutbox, "create")
      // Текст с runId — иначе повторный прогон в пределах DEDUP_WINDOW_MS (10 мин,
      // systemError.ts) молча склеится с предыдущим прогоном тем же сообщением, и
      // строка не появится вовсе не из-за нашего кода, а из-за честной дедупликации.
      .mockRejectedValueOnce(new Error(`connection terminated unexpectedly (${marker})`));

    await publish({ type: "client.updated", payload: { clientId: `c-real-fail-${runId}` }, agentIds: [agentAId] });

    // logSystemError зовётся `void` (fire-and-forget) из catch публикации — сама
    // publish() не ждёт его запись, поэтому короткий опрос вместо мгновенной
    // проверки счётчика сразу после await publish(...).
    const after = await waitForCount(() => countErrors(marker), before + 1, {
      label: `строка журнала по метке ${marker}`,
    });
    expect(after).toBe(before + 1);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("роут GET /api/v1/events", () => {
  it("без авторизации не пускает", async () => {
    const res = await request(app).get("/api/v1/events");
    expect(res.status).toBe(401);
  });

  it("не пускает по чужому/выдуманному билету", async () => {
    const res = await request(app).get("/api/v1/events?ticket=этого-билета-не-существует");
    expect(res.status).toBe(401);
  });

  it("билет одноразовый: второй раз тем же не войти", async () => {
    const ticketRes = await request(app).post("/api/v1/events/ticket").set("Authorization", `Bearer ${agentAToken}`);
    expect(ticketRes.status).toBe(200);
    const url = `${baseUrl}/api/v1/events?ticket=${encodeURIComponent(ticketRes.body.ticket)}`;

    const controller = new AbortController();
    const first = await fetch(url, { signal: controller.signal });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();

    const second = await fetch(url);
    expect(second.status).toBe(401);
    await second.body?.cancel();
  });

  it("доставляет адресованное событие в открытый поток", async () => {
    const stream = await openStream(agentAToken);
    expect(stream.status).toBe(200);
    await stream.waitFor("поток открыт");

    await publish({ type: "lead.pending", payload: { clientId: `c-${runId}` }, agentIds: [agentAId] });

    const text = await stream.waitFor("event: lead.pending");
    expect(text).toContain(`c-${runId}`);
    stream.close();
  });

  it("не доставляет чужое событие", async () => {
    const stream = await openStream(agentAToken);
    await stream.waitFor("поток открыт");

    await publish({ type: "lead.pending", payload: { clientId: "чужой" }, agentIds: [agentBId] });
    await new Promise((r) => setTimeout(r, 300));

    expect(stream.chunks.join("")).not.toContain("lead.pending");
    stream.close();
  });

  it("держит предел одновременных подписок на сотрудника", async () => {
    const opened: Array<{ close: () => void }> = [];
    for (let i = 0; i < MAX_STREAMS_PER_AGENT; i += 1) {
      const s = await openStream(agentBToken);
      expect(s.status).toBe(200);
      await s.waitFor("поток открыт");
      opened.push(s);
    }
    expect(streamStats(agentBId).forAgent).toBe(MAX_STREAMS_PER_AGENT);

    const ticketRes = await request(app).post("/api/v1/events/ticket").set("Authorization", `Bearer ${agentBToken}`);
    const extra = await fetch(`${baseUrl}/api/v1/events?ticket=${encodeURIComponent(ticketRes.body.ticket)}`);
    expect(extra.status).toBe(429);
    await extra.body?.cancel();

    for (const s of opened) s.close();
    // Закрытие сокета обязано снимать подписку — иначе предел упирался бы в
    // мёртвые соединения и человек не смог бы открыть CRM заново.
    const deadline = Date.now() + 5_000;
    while (streamStats(agentBId).forAgent > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(streamStats(agentBId).forAgent).toBe(0);
  });

  it("держит 20 одновременных подписок и доставляет всем", async () => {
    // Нагрузочная проверка из задания: 20 живых сокетов не должны ни уронить
    // процесс, ни потерять адресованное событие.
    const passwordHash = await bcrypt.hash(password, 10);
    const crowd = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        prisma.agent.create({
          data: { fullName: `Поток Толпа ${i}`, phone: `+99296${runId}${i}`, role: "AGENT", passwordHash },
        })
      )
    );
    loadAgentIds = crowd.map((a) => a.id);
    const streams: Array<{ waitFor: (n: string, t?: number) => Promise<string>; close: () => void }> = [];
    try {
      for (const agent of crowd) {
        const token = await login(agent.phone);
        const s = await openStream(token);
        expect(s.status).toBe(200);
        streams.push(s);
      }
      expect(streamStats().total).toBe(20);

      await publish({ type: "pult.snapshot", payload: {} }); // широковещательное — всем
      await Promise.all(streams.map((s) => s.waitFor("event: pult.snapshot", 10_000)));
    } finally {
      for (const s of streams) s.close();
    }
  }, 60_000);

  it("шлёт сердцебиение комментарием, а не событием", async () => {
    // Тик сердцебиения — 25 секунд, ждать его в тесте незачем: проверяем, что
    // первая же строка потока — комментарий SSE (начинается с двоеточия), то
    // есть формат «пинга» тот самый, который прокси считает живым трафиком и
    // который клиентский EventSource обязан пропустить мимо обработчиков.
    const stream = await openStream(directorToken);
    const text = await stream.waitFor("поток открыт");
    expect(text.startsWith(":")).toBe(true);
    expect(text).not.toContain("event:");
    stream.close();
  });
});

/**
 * ТОЧЕЧНАЯ НАДБАВКА messages.view В АДРЕСАЦИИ (находка ночной проверки
 * 24.09.2026, №245/К2-3).
 *
 * До починки: сотруднику с ролью AGENT и точечно выданным правом
 * messages.view (без clients.viewAll, то есть НЕ по пресету роли) события
 * чужого чата не адресовались вовсе — ни ролью (AGENT не входит в
 * OVERSEER_ROLES), ни agentId (клиент закреплён не за ним). Экран получал
 * новое сообщение только опросом, до 5 минут. Проверяем на настоящем потоке
 * (билет → SSE), а не на голом eventBus — иначе можно упустить, что права
 * читаются на подключении, а не на пресете роли.
 */
describe("живые события: точечная надбавка messages.view (находка 24.09.2026, №245/К2-3)", () => {
  let overrideAgentId: string;
  let plainAgentId: string;
  let overrideToken: string;
  let plainToken: string;
  let foreignClientId: string;
  let conversationId: string;

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    // Точечная надбавка: пресет AGENT права messages.view не даёт (только
    // messages.viewOwn) — здесь оно выдано персонально через granted.
    const overrideAgent = await prisma.agent.create({
      data: {
        fullName: `Поток Надбавка ${runId}`,
        phone: `+992954${runId}`,
        role: "AGENT",
        passwordHash,
        permissions: { granted: ["messages.view"], revoked: [] },
      },
    });
    overrideAgentId = overrideAgent.id;
    const plainAgent = await prisma.agent.create({
      data: { fullName: `Поток Без надбавки ${runId}`, phone: `+992955${runId}`, role: "AGENT", passwordHash },
    });
    plainAgentId = plainAgent.id;
    overrideToken = await login(overrideAgent.phone);
    plainToken = await login(plainAgent.phone);

    // Клиент закреплён за ТРЕТЬИМ, посторонним агентом — ни один из двух
    // проверяемых не должен получать событие через agentIds.
    const foreignClient = await prisma.client.create({
      data: {
        fullName: `Чужой клиент потока ${runId}`,
        phone: `+992956${runId}`,
        source: "TELEGRAM",
        acceptedAt: new Date(),
        assignedAgentId: agentBId, // agentB из внешнего beforeAll — не участвует в этой проверке
      },
    });
    foreignClientId = foreignClient.id;
    const conversation = await prisma.botConversation.create({
      data: { channel: "TELEGRAM", subscriberId: `messages-view-mark-${runId}`, clientId: foreignClient.id },
    });
    conversationId = conversation.id;
  });

  afterAll(async () => {
    await prisma.botConversation.deleteMany({ where: { id: conversationId } });
    await prisma.client.deleteMany({ where: { id: foreignClientId } });
    await prisma.liveEventOutbox.deleteMany({ where: { type: "message.new", payload: { path: ["conversationId"], equals: conversationId } } });
    await deleteAgentsWithTraces([overrideAgentId, plainAgentId]);
  });

  it("AGENT с точечной надбавкой messages.view получает message.new чужого клиента", async () => {
    const stream = await openStream(overrideToken);
    await stream.waitFor("поток открыт");

    await publishMessageNew("bot", conversationId, "IN");

    const text = await stream.waitFor("event: message.new");
    expect(text).toContain(conversationId);
    stream.close();
  });

  it("AGENT без надбавки (пресет как есть) message.new чужого клиента не получает", async () => {
    const stream = await openStream(plainToken);
    await stream.waitFor("поток открыт");

    await publishMessageNew("bot", conversationId, "IN");
    await new Promise((r) => setTimeout(r, 300));

    expect(stream.chunks.join("")).not.toContain("message.new");
    stream.close();
  });
});

describe("живой поток рвётся при отключении и смене роли (находка №148, 24.09.2026)", () => {
  let victimId: string;
  let victimToken: string;

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    const victim = await prisma.agent.create({
      data: { fullName: "Поток Уволенный", phone: `+992954${runId}`, role: "AGENT", passwordHash },
    });
    victimId = victim.id;
    victimToken = await login(victim.phone);
    const stepUp = await request(app)
      .post("/api/v1/auth/step-up")
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ password });
    expect(stepUp.status).toBe(200);
  });

  afterAll(async () => {
    await deleteAgentsWithTraces([victimId]);
  });

  it("отключение сотрудника закрывает его открытые потоки", async () => {
    const stream = await openStream(victimToken);
    await stream.waitFor("поток открыт");
    expect(streamStats(victimId).forAgent).toBe(1);

    const res = await request(app)
      .patch(`/api/v1/agents/${victimId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ isActive: false });
    expect(res.status).toBe(200);

    expect(streamStats(victimId).forAgent).toBe(0);
    stream.close();
  });

  it("смена роли закрывает потоки — вкладка переподключится уже с новой ролью", async () => {
    await prisma.agent.update({ where: { id: victimId }, data: { isActive: true } });
    const stream = await openStream(victimToken);
    await stream.waitFor("поток открыт");
    expect(streamStats(victimId).forAgent).toBe(1);

    const res = await request(app)
      .patch(`/api/v1/agents/${victimId}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ role: "MARKETING" });
    expect(res.status).toBe(200);

    expect(streamStats(victimId).forAgent).toBe(0);
    stream.close();
  });
});
