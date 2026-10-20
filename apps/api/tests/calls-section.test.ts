import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * Раздел «Звонки»: разговоры агентства.
 *
 * Проверяются два правила и то, ради чего раздел существует. Руководитель видит не
 * счётчик звонков, а что происходило внутри разговора, и может отобрать проблемные.
 * Агент с 15.08.2026 заходит сюда за СВОИМИ разговорами — и выборка сужается на
 * сервере, а не фильтром в интерфейсе: `?agentId=<чужой>` руками уходит тем же
 * запросом. Всё, что рассказывает о работе других людей (сводка, ночной разбор,
 * журнал входящих), ему по-прежнему закрыто.
 */

const runId = Date.now();
let agentId = "";
let adminId = "";
let clientId = "";
let goodCallId = "";
let badCallId = "";
let agentToken = "";
let adminToken = "";

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент раздела ${runId}`, phone: `+99271${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  const admin = await prisma.agent.create({
    data: { fullName: `Админ раздела ${runId}`, phone: `+99272${String(runId).slice(-7)}`, role: "ADMIN", passwordHash: "x" },
  });
  agentId = agent.id;
  adminId = admin.id;
  agentToken = signAccessToken({ sub: agent.id, role: "AGENT" });
  adminToken = signAccessToken({ sub: admin.id, role: "ADMIN" });

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент раздела ${runId}`,
      phone: `+99273${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;

  const good = await prisma.interaction.create({
    data: {
      clientId,
      agentId,
      type: "CALL",
      notes: "Звонок через CRM, разговор 3:20",
      transcript: "Клиент: ищу двушку в Сино. Агент: покажу в четверг.",
      recordingUrl: `2026/08/07/out-1-${runId}.mp3`,
      recordingDurationSec: 200,
    },
  });
  goodCallId = good.id;
  await prisma.callAnalysis.create({
    data: {
      interactionId: good.id,
      agentId,
      score: 82,
      greeted: true,
      foundNeed: true,
      presentedValue: true,
      handledObjection: true,
      agreedNextStep: true,
      objections: ["дорого"],
      agreements: ["показ в четверг в 15:00"],
      summary: "Клиент ищет двушку в Сино, договорились о показе.",
      coaching: null,
    },
  });

  const bad = await prisma.interaction.create({
    data: {
      clientId,
      agentId,
      type: "CALL",
      notes: "Звонок через CRM, разговор 0:50",
      transcript: "Клиент: я подумаю. Агент: хорошо.",
      recordingUrl: `2026/08/07/out-2-${runId}.mp3`,
      recordingDurationSec: 50,
    },
  });
  badCallId = bad.id;
  await prisma.callAnalysis.create({
    data: {
      interactionId: bad.id,
      agentId,
      score: 30,
      greeted: true,
      foundNeed: false,
      presentedValue: false,
      handledObjection: false,
      agreedNextStep: false,
      objections: ["дорого", "подумаю"],
      agreements: [],
      summary: "Клиент ушёл думать, следующий шаг не назначен.",
      coaching: "Договаривайтесь о конкретном следующем шаге до конца разговора.",
    },
  });
});

afterAll(async () => {
  await prisma.incomingCall.deleteMany({ where: { channelId: { startsWith: `sec-${runId}` } } });
  await prisma.callAnalysis.deleteMany({ where: { agentId } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, adminId] } } });
  await prisma.$disconnect();
});

describe("Раздел «Звонки»", () => {
  it("недозвон через CRM (клиент не ответил) виден в журнале и в ленте — не пропадает без записи", async () => {
    /**
     * 18.09.2026, жалоба владельца: агент звонил клиенту, там не ответили —
     * и звонок пропадал из «Мои звонки» целиком, потому что фильтр требовал
     * запись или расшифровку, а у недозвона их не бывает никогда
     * (finishCall не пишет их для NO_ANSWER — lib/telephony/callTracker.ts).
     */
    const noAnswer = await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        type: "CALL",
        notes: "Звонок через CRM, клиент не ответил",
        callAttempt: "NO_ANSWER",
      },
    });

    try {
      const list = await request(app).get("/api/v1/calls").set("Authorization", `Bearer ${agentToken}`);
      expect(list.status).toBe(200);
      const row = list.body.items.find((c: { id: string }) => c.id === noAnswer.id);
      expect(row).toBeDefined();
      expect(row.callAttempt).toBe("NO_ANSWER");
      expect(row.hasRecording).toBe(false);

      const feed = await request(app).get("/api/v1/calls/feed").set("Authorization", `Bearer ${agentToken}`);
      expect(feed.status).toBe(200);
      const feedRow = feed.body.items.find((c: { id: string }) => c.id === noAnswer.id);
      expect(feedRow).toBeDefined();
      expect(feedRow.kind).toBe("OUT");
      expect(feedRow.callAttempt).toBe("NO_ANSWER");
    } finally {
      await prisma.interaction.deleteMany({ where: { id: noAnswer.id } });
    }
  });

  it("агент видит свои разговоры, но не работу команды", async () => {
    const list = await request(app).get("/api/v1/calls").set("Authorization", `Bearer ${agentToken}`);
    expect(list.status).toBe(200);
    expect(list.body.ownOnly).toBe(true);
    const ids = list.body.items.map((c: { id: string }) => c.id);
    expect(ids).toContain(goodCallId);

    // Сводка, ночной разбор и журнал входящих — про всю команду, их сузить нечем.
    for (const path of ["/api/v1/calls/summary", "/api/v1/calls/insights", "/api/v1/calls/incoming"]) {
      const res = await request(app).get(path).set("Authorization", `Bearer ${agentToken}`);
      expect(res.status, path).toBe(403);
    }
  });

  it("агент не может подсмотреть чужие разговоры, подставив agentId в запрос", async () => {
    const foreign = await prisma.agent.create({
      data: {
        fullName: `Чужой раздела ${runId}`,
        phone: `+99274${String(runId).slice(-7)}`,
        role: "AGENT",
        passwordHash: "x",
      },
    });
    const foreignCall = await prisma.interaction.create({
      data: {
        clientId,
        agentId: foreign.id,
        type: "CALL",
        notes: "Разговор коллеги",
        transcript: "Клиент: продаю участок в Гипроземе, звоните после обеда.",
        recordingUrl: `2026/08/07/out-3-${runId}.mp3`,
      },
    });

    try {
      const res = await request(app)
        .get(`/api/v1/calls?agentId=${foreign.id}`)
        .set("Authorization", `Bearer ${agentToken}`);

      expect(res.status).toBe(200);
      const ids = res.body.items.map((c: { id: string }) => c.id);
      expect(ids).not.toContain(foreignCall.id);
      // Подставленный чужой id не сузил выборку до пустоты и не открыл чужое —
      // он просто не учитывается: сотрудник видит ровно свои разговоры.
      expect(ids).toContain(goodCallId);
    } finally {
      await prisma.interaction.deleteMany({ where: { id: foreignCall.id } });
      await prisma.agent.deleteMany({ where: { id: foreign.id } });
    }
  });

  it("администратор видит разговоры с разбором и расшифровкой", async () => {
    const res = await request(app).get("/api/v1/calls").set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const call = res.body.items.find((c: { id: string }) => c.id === goodCallId);
    expect(call).toBeDefined();
    expect(call.analysis.score).toBe(82);
    expect(call.analysis.agreements).toContain("показ в четверг в 15:00");
    expect(call.transcript).toContain("Сино");
    // Путь файла наружу не отдаём: он ничего не даёт браузеру (АТС во внутренней
    // сети), слушают через отдельный маршрут.
    expect(call.hasRecording).toBe(true);
    expect(call.recordingUrl).toBeUndefined();
  });

  it("фильтр «требуют внимания» отбирает разговоры без договорённости", async () => {
    const res = await request(app).get("/api/v1/calls?problems=1").set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.items.map((c: { id: string }) => c.id);
    expect(ids).toContain(badCallId);
    expect(ids).not.toContain(goodCallId);
  });

  it("журнал входящих отделяет неразобранные разговоры от пропущенных", async () => {
    /**
     * Два счётчика, а не один: это разные потери. Пропущенный звонок — обращение,
     * до которого не дошли; неразобранный — состоявшийся разговор, всё содержание
     * которого осталось в голове у оператора. Смешать их значит спрятать вторую
     * потерю за первой, а именно ради второй и заводилось окно оператора.
     */
    await prisma.incomingCall.createMany({
      data: [
        // Поговорили, тип обращения не указан — ждёт разбора.
        {
          channelId: `sec-${runId}-a`,
          phone: `+99273${String(runId).slice(-7)}`,
          clientId,
          answered: true,
          talkSeconds: 61,
          endedAt: new Date(),
        },
        // Поговорили и разобрали — в неразобранные не идёт.
        {
          channelId: `sec-${runId}-b`,
          phone: `+99273${String(runId).slice(-7)}`,
          clientId,
          answered: true,
          talkSeconds: 44,
          endedAt: new Date(),
          qualifiedAt: new Date(),
          qualifiedById: adminId,
        },
        // До оператора не дошёл — разбирать нечего.
        { channelId: `sec-${runId}-c`, phone: "+992777000222", answered: false, endedAt: new Date() },
      ],
    });

    const all = await request(app).get("/api/v1/calls/incoming").set("Authorization", `Bearer ${adminToken}`);
    expect(all.status).toBe(200);
    expect(all.body.unqualified).toBeGreaterThanOrEqual(1);

    const only = await request(app)
      .get("/api/v1/calls/incoming?unqualified=1")
      .set("Authorization", `Bearer ${adminToken}`);
    const ids = only.body.items.map((c: { id: string }) => c.id);
    const rows = await prisma.incomingCall.findMany({
      where: { channelId: { startsWith: `sec-${runId}` } },
      select: { id: true, channelId: true },
    });
    const byChannel = (suffix: string) => rows.find((r) => r.channelId.endsWith(suffix))!.id;

    expect(ids).toContain(byChannel("-a"));
    expect(ids).not.toContain(byChannel("-b"));
    expect(ids).not.toContain(byChannel("-c"));
    // Счётчик пропущенных не должен обнуляться включённым фильтром — иначе
    // переключатель врёт про положение дел.
    expect(only.body.missed).toBeGreaterThanOrEqual(1);
  });

  it("фильтр по оператору отбирает звонки, которые снял именно он", async () => {
    /**
     * `answeredBy` — внутренний номер на станции, а не связь с сотрудником: в момент
     * звонка CRM не знает, кто снимет трубку. Поэтому фильтр идёт по номеру, а имя
     * в списке подставляется по Agent.sipExtension — сопоставление живёт в одном
     * месте, а не в двух.
     */
    await prisma.incomingCall.createMany({
      data: [
        {
          channelId: `sec-${runId}-op1`,
          phone: `+99273${String(runId).slice(-7)}`,
          clientId,
          answered: true,
          answeredBy: "1001",
          endedAt: new Date(),
        },
        {
          channelId: `sec-${runId}-op2`,
          phone: `+99273${String(runId).slice(-7)}`,
          clientId,
          answered: true,
          answeredBy: "1002",
          endedAt: new Date(),
        },
      ],
    });

    const res = await request(app)
      .get("/api/v1/calls/incoming?operator=1001")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const channels = await prisma.incomingCall.findMany({
      where: { id: { in: res.body.items.map((c: { id: string }) => c.id) } },
      select: { channelId: true, answeredBy: true },
    });
    expect(channels.every((c) => c.answeredBy === "1001")).toBe(true);
    expect(channels.some((c) => c.channelId.endsWith("-op1"))).toBe(true);

    // Общие счётчики фильтр не сужает — иначе они врали бы про положение дел.
    expect(res.body.periodTotal).toBeGreaterThanOrEqual(2);
  });

  it("фильтры списка проверяются на границе: мусор в agentId или дате — 400, а не тихо пустой список (№155)", async () => {
    const badAgent = await request(app).get("/api/v1/calls?agentId=not-a-uuid").set("Authorization", `Bearer ${adminToken}`);
    expect(badAgent.status).toBe(400);
    const badDate = await request(app).get("/api/v1/calls?from=вчера").set("Authorization", `Bearer ${adminToken}`);
    expect(badDate.status).toBe(400);
    const ok = await request(app)
      .get(`/api/v1/calls?agentId=${agentId}&from=2026-01-01&problems=1`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(ok.status).toBe(200);
  });

  it("период сужает выборку, а не только подпись", async () => {
    await prisma.incomingCall.create({
      data: {
        channelId: `sec-${runId}-old`,
        phone: `+99273${String(runId).slice(-7)}`,
        clientId,
        answered: true,
        // Полтора месяца назад: в неделю не попадает, в квартал попадает.
        startedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
        endedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
      },
    });

    const week = await request(app).get("/api/v1/calls/incoming?days=7").set("Authorization", `Bearer ${adminToken}`);
    const quarter = await request(app).get("/api/v1/calls/incoming?days=90").set("Authorization", `Bearer ${adminToken}`);
    expect(quarter.body.periodTotal).toBeGreaterThan(week.body.periodTotal);
  });

  it("сводка считает средний счёт, шаги и частые возражения", async () => {
    const res = await request(app).get("/api/v1/calls/summary?days=30").set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    expect(res.body.averageScore).toBeGreaterThan(0);
    // «Дорого» прозвучало в обоих разговорах, «подумаю» в одном — значит «дорого»
    // стоит ВЫШЕ. Сравниваем два своих возражения между собой, а не с первым местом
    // в списке: сводка считает по ВСЕЙ базе за 30 суток (`callAnalysis` без сужения
    // по тесту), и чужой тест, создавший своё возражение почаще, сдвинул бы обе наши
    // строки вниз, не сломав при этом ни одного правила. Сегодня это зелено по
    // случайности — соседи (`insight-digest-collect`, `call-transcripts-privacy`)
    // пишут ровно то же слово «дорого».
    const objectionTexts = (res.body.objections as { text: string }[]).map((o) => o.text.toLowerCase());
    const dearAt = objectionTexts.findIndex((t) => t.includes("дорого"));
    const thinkAt = objectionTexts.findIndex((t) => t.includes("подумаю"));
    expect(dearAt).toBeGreaterThanOrEqual(0);
    expect(thinkAt).toBeGreaterThan(dearAt);
    const agentRow = res.body.agents.find((a: { agentId: string }) => a.agentId === agentId);
    expect(agentRow.calls).toBeGreaterThanOrEqual(2);
  });

  it("качество ЧУЖОГО разговора не приписывается агенту: входящие идут отдельной строкой", async () => {
    /**
     * У Interaction автор обязателен, а оператора входящих в карточке клиента нет,
     * поэтому входящий звонок пишется от имени оператора — или, если станция его не
     * назвала, от имени ОТВЕТСТВЕННОГО АГЕНТА. Разбор наследовал того же автора, и
     * агенту в сводке считался счёт за разговор, которого он не вёл и на котором мог
     * вообще не быть на работе.
     */
    const before = await request(app)
      .get("/api/v1/calls/summary?days=30")
      .set("Authorization", `Bearer ${adminToken}`);
    const beforeRow = before.body.agents.find((a: { agentId: string }) => a.agentId === agentId);

    const incoming = await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        type: "CALL",
        notes: "Входящий звонок клиента: поговорил с оператором",
        transcript: "Клиент: звоню по объявлению. Оператор: сейчас передам агенту.",
      },
    });
    await prisma.incomingCall.create({
      data: {
        channelId: `sec-${runId}-analysis`,
        phone: `+99273${String(runId).slice(-7)}`,
        clientId,
        answered: true,
        interactionId: incoming.id,
      },
    });
    await prisma.callAnalysis.create({
      data: {
        interactionId: incoming.id,
        agentId,
        score: 5,
        objections: [],
        agreements: [],
        summary: "Оператор принял звонок и обещал передать агенту.",
      },
    });

    const after = await request(app)
      .get("/api/v1/calls/summary?days=30")
      .set("Authorization", `Bearer ${adminToken}`);
    const afterRow = after.body.agents.find((a: { agentId: string }) => a.agentId === agentId);

    // Колонка агента не сдвинулась ни на один разговор.
    expect(afterRow.calls).toBe(beforeRow.calls);
    expect(afterRow.averageScore).toBe(beforeRow.averageScore);
    // Но разговор не спрятан: это настоящий разговор компании, просто ничей.
    expect(after.body.total).toBe(before.body.total + 1);
    expect(after.body.incoming.total).toBeGreaterThanOrEqual(1);
  });
});
