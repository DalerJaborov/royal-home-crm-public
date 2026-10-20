import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { classifyErrorLog, errorLogPriorityWhere } from "../src/lib/errorLogClassify.js";

/**
 * СТРАНИЦЫ ВМЕСТО МОЛЧАЛИВОГО ОБРЕЗА (02.10.2026). Пять списков кончались на
 * пределе сервера без способа увидеть дальше: «Вакансии» (100), «Потерянные» и
 * «Отложенные» (200), журнал ошибок (50), «Изменения с сайта» (200). Здесь —
 * контракт, на который опирается «Показать ещё»: вторая страница отдаёт
 * следующие строки, `total` — настоящее число.
 *
 * База общая с соседними файлами, поэтому свои строки отделяем: у анкет —
 * поиском по runId, у агента — его собственные отложенные, у остальных — датой
 * в будущем (свои строки гарантированно наверху ленты «новые сверху»).
 */

const runId = Date.now();
const tag = String(runId);
const FUTURE = Date.UTC(2099, 0, 1);
let directorId = "";
let agentId = "";
let directorToken = "";
let agentToken = "";
let districtId = "";
let propertyId = "";
const clientIds: string[] = [];
const jobIds: string[] = [];
const errorIds: string[] = [];
const notificationIds: string[] = [];

function get(path: string, token = directorToken) {
  return request(app).get(`/api/v1${path}`).set("Authorization", `Bearer ${token}`);
}

beforeAll(async () => {
  const director = await prisma.agent.create({
    data: { fullName: `Директор страниц ${runId}`, phone: `+99293${tag.slice(-7)}`, role: "DIRECTOR", passwordHash: "x" },
  });
  directorId = director.id;
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });
  const agent = await prisma.agent.create({
    data: { fullName: `Агент страниц ${runId}`, phone: `+99294${tag.slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;
  agentToken = signAccessToken({ sub: agent.id, role: "AGENT" });
  districtId = (await prisma.district.create({ data: { name: `Страницы-${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект страниц ${runId}`,
        type: "APARTMENT",
        areaSqm: 40,
        price: 30000,
        currency: "USD",
        districtId,
        address: `Страницы ${runId}`,
        condition: "GOOD",
        status: "AVAILABLE",
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.siteEditNotification.deleteMany({ where: { id: { in: notificationIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.errorLog.deleteMany({ where: { id: { in: errorIds } } });
  await prisma.jobApplication.deleteMany({ where: { id: { in: jobIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.auditLog.deleteMany({ where: { agentId: { in: [directorId, agentId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
});

describe("Потерянные и Отложенные клиенты: страницы вместо потолка 200", () => {
  it("GET /clients/lost: страница 2 — следующие, без повторов", async () => {
    for (let i = 0; i < 3; i++) {
      const c = await prisma.client.create({
        data: {
          fullName: `Потерянный страниц ${runId}-${i}`,
          phone: `+99291${tag.slice(-6)}${i}`,
          source: "PHONE_CALL",
          status: "LOST",
          lostAt: new Date(FUTURE + i * 1000),
        },
      });
      clientIds.push(c.id);
    }
    const p1 = await get("/clients/lost?page=1&pageSize=2");
    const p2 = await get("/clients/lost?page=2&pageSize=2");
    expect(p1.status).toBe(200);
    expect(p1.body.page).toBe(1);
    expect(p1.body.pageSize).toBe(2);
    // Не точным равенством: соседние файлы в том же прогоне тоже заводят потерянных.
    expect(p1.body.total).toBeGreaterThanOrEqual(3);
    expect(p1.body.total).toBeGreaterThan(p1.body.items.length);
    // Свои — с датой потери в будущем, значит самые свежие: 2, 1 на первой, 0 вверху второй.
    expect(p1.body.items.map((c: { id: string }) => c.id)).toEqual([clientIds[2], clientIds[1]]);
    expect(p2.body.items[0].id).toBe(clientIds[0]);
  });

  it("GET /clients/deferred: агент листает свои, total — их число", async () => {
    const mine: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await prisma.client.create({
        data: {
          fullName: `Отложенный страниц ${runId}-${i}`,
          phone: `+99292${tag.slice(-6)}${i}`,
          source: "PHONE_CALL",
          assignedAgentId: agentId,
          workStatus: "DEFERRED",
          deferredAt: new Date(),
          deferredUntil: new Date(FUTURE + i * 1000),
        },
      });
      clientIds.push(c.id);
      mine.push(c.id);
    }
    const p1 = await get("/clients/deferred?page=1&pageSize=2", agentToken);
    const p2 = await get("/clients/deferred?page=2&pageSize=2", agentToken);
    expect(p1.body.total).toBe(3);
    expect(p2.body.total).toBe(3);
    // Ближе к возврату — выше.
    expect([...p1.body.items, ...p2.body.items].map((c: { id: string }) => c.id)).toEqual(mine);
    expect((await get("/clients/deferred?pageSize=0", agentToken)).status).toBe(400);
  });
});

describe("Журнал ошибок: отбор в выборке, а не в памяти", () => {
  const OPERATIONAL_SAMPLES = [
    `Gemini ответил на РЕЗЕРВНОЙ модели m — основная недоступна ${runId}`,
    `Ассистент ответил на РЕЗЕРВНОЙ модели m — основная m2 недоступна. ${runId}`,
    `Gemini не ответил с первого раза (chat) — помог повтор ${runId}`,
    `Gemini не ответил (chat), повтор тоже не помог ${runId}`,
    `Живой голос: расшифровка звонка ${runId}`,
    `Живой голос: исходящий тестовый звонок принят ${runId}`,
    `Gemini заблокировал промт (m): blockReason=X ${runId}`,
  ];
  const ACTIONABLE_SAMPLES = [
    `ТРЕВОГА: Gemini ответил на РЕЗЕРВНОЙ модели час подряд ${runId}`,
    `Сайт недоступен: таймаут ${runId}`,
    `Gemini не ответил ${runId}`,
  ];

  it("условие для базы делит образцы так же, как classifyErrorLog", async () => {
    const created = await Promise.all(
      [...OPERATIONAL_SAMPLES, ...ACTIONABLE_SAMPLES].map((message) =>
        prisma.errorLog.create({ data: { source: "ai", message, resolvedAt: new Date() } })
      )
    );
    errorIds.push(...created.map((r) => r.id));
    for (const m of OPERATIONAL_SAMPLES) expect(classifyErrorLog("ai", m)).toBe("operational");
    for (const m of ACTIONABLE_SAMPLES) expect(classifyErrorLog("ai", m)).toBe("actionable");
    const mine = { message: { endsWith: String(runId) } };
    const op = await prisma.errorLog.findMany({ where: { AND: [mine, errorLogPriorityWhere("operational")] } });
    const act = await prisma.errorLog.findMany({ where: { AND: [mine, errorLogPriorityWhere("actionable")] } });
    expect(op.map((r) => r.message).sort()).toEqual([...OPERATIONAL_SAMPLES].sort());
    expect(act.map((r) => r.message).sort()).toEqual([...ACTIONABLE_SAMPLES].sort());
    await prisma.errorLog.deleteMany({ where: { id: { in: errorIds } } });
    errorIds.length = 0;
  });

  it("всплеск в 210 строк шума не прячет настоящую ошибку; страницы шума не пересекаются", async () => {
    // Разобранными — чтобы не трогать счётчики «за сутки» у соседних файлов;
    // в список они попадают с includeResolved=true.
    const real = await prisma.errorLog.create({
      data: { source: "cron", message: `Крон не запустился ${runId}`, createdAt: new Date(FUTURE), resolvedAt: new Date() },
    });
    errorIds.push(real.id);
    await prisma.errorLog.createMany({
      data: Array.from({ length: 210 }, (_, i) => ({
        source: "ai",
        message: `Gemini ответил на РЕЗЕРВНОЙ модели m — шум ${runId}-${i}`,
        createdAt: new Date(FUTURE + 1000 + i),
        resolvedAt: new Date(),
      })),
    });
    const noise = await prisma.errorLog.findMany({ where: { message: { contains: `шум ${runId}-` } }, select: { id: true } });
    errorIds.push(...noise.map((r) => r.id));

    const act = await get("/errors?includeResolved=true&priority=actionable&pageSize=5");
    expect(act.status).toBe(200);
    expect(act.body.recent[0].id).toBe(real.id);
    expect(act.body.total).toBeGreaterThanOrEqual(1);

    const op1 = await get("/errors?includeResolved=true&priority=operational&page=1&pageSize=100");
    const op2 = await get("/errors?includeResolved=true&priority=operational&page=2&pageSize=100");
    expect(op1.body.total).toBeGreaterThanOrEqual(210);
    const ids1 = new Set(op1.body.recent.map((r: { id: string }) => r.id));
    expect(op2.body.recent.some((r: { id: string }) => ids1.has(r.id))).toBe(false);
    // Свои 210 — самые свежие: первая страница целиком из них, вторая начинается с них же.
    expect(op1.body.recent.every((r: { message: string }) => r.message.includes(`шум ${runId}-`))).toBe(true);
    expect(op2.body.recent[0].message).toContain(`шум ${runId}-`);
  });
});

describe("Изменения с сайта: страницы вместо 200", () => {
  it("страница 2 — следующие уведомления, total — все неразобранные", async () => {
    for (let i = 0; i < 3; i++) {
      const n = await prisma.siteEditNotification.create({
        data: { propertyId, action: "UPDATED", createdAt: new Date(FUTURE + i * 1000) },
      });
      notificationIds.push(n.id);
    }
    const p1 = await get("/site-notifications?page=1&pageSize=2");
    const p2 = await get("/site-notifications?page=2&pageSize=2");
    expect(p1.status).toBe(200);
    expect(p1.body.total).toBeGreaterThanOrEqual(3);
    expect(p1.body.total).toBeGreaterThan(p1.body.items.length);
    expect(p1.body.items.map((n: { id: string }) => n.id)).toEqual([notificationIds[2], notificationIds[1]]);
    expect(p2.body.items[0].id).toBe(notificationIds[0]);
  });
});
