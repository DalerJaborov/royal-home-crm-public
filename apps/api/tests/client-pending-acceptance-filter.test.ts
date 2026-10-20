import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Срез «Ждут принятия» на GET /clients?pendingAcceptance=1 (docs/TASKS.md,
 * «дашборд агента против ТЗ» 07.09.2026).
 *
 * ДО ЭТОГО ДНЯ фильтр жил только на клиенте: веб просил страницу (20 или 100
 * карточек обычной сортировки) и сам отбрасывал принятые. Переназначенный
 * старый лид с дедлайном в минутах мог оказаться позади уже принятых карточек
 * в этой странице и просто не попасть в ответ — с точки зрения агента заявка
 * пропадала, хотя `acceptedAt` у неё по-прежнему был пуст.
 *
 * Проверяется: (1) фильтр отдаёт только `acceptedAt IS NULL` среди карточек
 * теста, принятая карточка в выдачу не попадает; (2) сортировка — по
 * `assignedAt`, самая старая заявка первой, даже когда она объективно "старее"
 * недавно принятых карточек, которые в обычной сортировке (createdAt desc)
 * встали бы перед ней.
 */

const runId = Date.now();
const password = "testpass123";

let directorId = "";
let agentId = "";
let oldPendingId = "";
let newPendingId = "";
let acceptedId = "";
let escalatedId = "";
let token = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const director = await prisma.agent.create({
    data: { fullName: `Ожид Дир ${runId}`, phone: `+992955${String(runId).slice(-7)}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  const agent = await prisma.agent.create({
    data: { fullName: `Ожид Агент ${runId}`, phone: `+992956${String(runId).slice(-7)}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;

  // Назначен раньше всех и до сих пор не принят — обязан быть первым в списке.
  const oldPending = await prisma.client.create({
    data: {
      fullName: `Ожид Старый ${runId}`,
      phone: `+992957${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: agent.id,
      assignedAt: new Date("2026-01-01T08:00:00Z"),
      acceptedAt: null,
      // createdAt новее — в обычной сортировке (createdAt desc) эта карточка
      // встала бы ПОСЛЕ недавно созданной и уже принятой, а не первой.
      createdAt: new Date("2026-09-10T08:00:00Z"),
    },
  });
  oldPendingId = oldPending.id;

  // Назначен позже, тоже не принят — второй в списке.
  const newPending = await prisma.client.create({
    data: {
      fullName: `Ожид Новый ${runId}`,
      phone: `+992958${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: agent.id,
      assignedAt: new Date("2026-09-01T08:00:00Z"),
      acceptedAt: null,
    },
  });
  newPendingId = newPending.id;

  // Уже принят — в срезе «Ждут принятия» его быть не должно, хотя он новее всех.
  const accepted = await prisma.client.create({
    data: {
      fullName: `Ожид Принят ${runId}`,
      phone: `+992959${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: agent.id,
      assignedAt: new Date("2026-09-09T08:00:00Z"),
      acceptedAt: new Date("2026-09-09T08:05:00Z"),
      createdAt: new Date("2026-09-09T08:00:00Z"),
    },
  });
  acceptedId = accepted.id;

  /**
   * РЕГРЕССИЯ 14.09.2026 (скриншот владельца, карточка «Ака», «Никто не
   * принял»): `reassignStaleLeads` при эскалации ставит `escalatedAt`, но
   * оставляет `acceptedAt: null` и того же `assignedAgentId` — это запись «кто
   * держал лид», не приглашение агенту решать. До правки такая карточка
   * оставалась в срезе «Ждут принятия» у прежнего агента навсегда, а
   * IncomingLeadWindow показывал её как свежий полноэкранный оффер с уже
   * нулевым таймером.
   */
  const escalated = await prisma.client.create({
    data: {
      fullName: `Ожид Эскалирован ${runId}`,
      phone: `+992960${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: agent.id,
      assignedAt: new Date("2026-08-01T08:00:00Z"),
      acceptedAt: null,
      escalatedAt: new Date("2026-09-01T09:00:00Z"),
    },
  });
  escalatedId = escalated.id;

  const login = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
  expect(login.status).toBe(200);
  token = login.body.accessToken as string;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: [oldPendingId, newPendingId, acceptedId, escalatedId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
  await prisma.$disconnect();
});

describe("GET /clients?pendingAcceptance=1", () => {
  it("отдаёт только непринятых, принятая карточка отсутствует", async () => {
    const res = await request(app)
      .get(`/api/v1/clients?pendingAcceptance=1&q=${encodeURIComponent(`Ожид ${runId}`)}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const ids = (res.body.items as { id: string }[]).map((c) => c.id);
    expect(ids).toContain(oldPendingId);
    expect(ids).toContain(newPendingId);
    expect(ids).not.toContain(acceptedId);
    expect(ids).not.toContain(escalatedId);
  });

  it("сортирует по assignedAt — самая старая заявка первой, а не по дате создания", async () => {
    const res = await request(app)
      .get(`/api/v1/clients?pendingAcceptance=1&q=${encodeURIComponent(`Ожид ${runId}`)}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const ids = (res.body.items as { id: string }[]).map((c) => c.id);
    expect(ids.indexOf(oldPendingId)).toBeLessThan(ids.indexOf(newPendingId));
  });

  it("без параметра фильтр не применяется — принятая карточка тоже видна", async () => {
    const res = await request(app)
      .get(`/api/v1/clients?q=${encodeURIComponent(`Ожид ${runId}`)}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const ids = (res.body.items as { id: string }[]).map((c) => c.id);
    expect(ids).toContain(acceptedId);
  });
});

/**
 * Честность `total`, когда ждущих больше предела одной страницы (11.09.2026).
 *
 * Серверный фильтр сам по себе честный (см. describe выше), но виджеты на
 * главной агента (`PendingLeadsRows`, `MobileAgentHome` → `PendingSection`)
 * запрашивают `pageSize=20` — предел одного запроса ВИДЖЕТА, а не подсчёта.
 * Раньше «ещё N» на этих виджетах считалось от `items.length`, который этим
 * же пределом и обрезан, — при 25 ждущих виджет молча показывал «ещё 18»
 * вместо «ещё 23» (2 в строках + 20 в ответе = 22 «видимых», 3 пропадали
 * без следа). Здесь проверяется контракт, на который опирается починка:
 * `total` в ответе обязан быть полным счётом, даже когда `items` обрезаны
 * `pageSize`.
 */
describe("GET /clients?pendingAcceptance=1 — total честен за пределами pageSize", () => {
  const bulkRunId = Date.now() + 1;
  let bulkDirectorId = "";
  let bulkAgentId = "";
  let bulkClientIds: string[] = [];
  let bulkToken = "";
  const PENDING_COUNT = 25;

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    const director = await prisma.agent.create({
      data: {
        fullName: `Пачка Дир ${bulkRunId}`,
        phone: `+992951${String(bulkRunId).slice(-7)}`,
        role: "DIRECTOR",
        passwordHash,
      },
    });
    bulkDirectorId = director.id;
    const agent = await prisma.agent.create({
      data: {
        fullName: `Пачка Агент ${bulkRunId}`,
        phone: `+992952${String(bulkRunId).slice(-7)}`,
        role: "AGENT",
        passwordHash,
      },
    });
    bulkAgentId = agent.id;

    const clients = await Promise.all(
      Array.from({ length: PENDING_COUNT }, (_, i) =>
        prisma.client.create({
          data: {
            fullName: `Пачка Клиент ${bulkRunId} ${i}`,
            phone: `+99295${String(3000000 + bulkRunId + i).slice(-8)}`,
            source: "PHONE_CALL",
            assignedAgentId: agent.id,
            assignedAt: new Date(Date.now() - (PENDING_COUNT - i) * 60_000),
            acceptedAt: null,
          },
        })
      )
    );
    bulkClientIds = clients.map((c) => c.id);

    const login = await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password });
    expect(login.status).toBe(200);
    bulkToken = login.body.accessToken as string;
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { id: { in: bulkClientIds } } });
    await prisma.agent.deleteMany({ where: { id: { in: [bulkDirectorId, bulkAgentId] } } });
    await prisma.$disconnect();
  });

  it("отдаёт `total`=25 при 25 ждущих, даже когда страница (pageSize по умолчанию) короче", async () => {
    const res = await request(app)
      .get(`/api/v1/clients?pendingAcceptance=1&q=${encodeURIComponent(`Пачка Клиент ${bulkRunId}`)}`)
      .set("Authorization", `Bearer ${bulkToken}`);
    expect(res.status).toBe(200);

    expect(res.body.total).toBe(PENDING_COUNT);
    // Страница честно обрезана пределом — это ожидаемая пагинация, не баг;
    // баг был в том, что клиент считал «ещё N» от длины этой страницы, а не
    // от total. Здесь фиксируется контракт, на котором держится починка
    // AgentHome.tsx/MobileAgentHome.tsx: total не может быть меньше items.length.
    expect((res.body.items as unknown[]).length).toBeLessThanOrEqual(res.body.total);
    expect((res.body.items as unknown[]).length).toBeGreaterThan(0);
  });

  it("с явным pageSize=100 отдаёт все 25 карточек разом", async () => {
    const res = await request(app)
      .get(
        `/api/v1/clients?pendingAcceptance=1&pageSize=100&q=${encodeURIComponent(`Пачка Клиент ${bulkRunId}`)}`
      )
      .set("Authorization", `Bearer ${bulkToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(PENDING_COUNT);
    expect((res.body.items as { id: string }[]).length).toBe(PENDING_COUNT);
  });
});

/**
 * Число на кнопке «Ждут принятия» и список по ней — одно определение
 * (24.09.2026, разбор раздачи, пункт 25). Число считало эскалированные и
 * показывало больше, чем строк в списке.
 */
describe("«Ждут принятия»: число совпадает со списком", () => {
  it("summary.awaitingAgent.count равен total среза, эскалированный не считается", async () => {
    const [summary, list] = await Promise.all([
      request(app).get("/api/v1/clients/summary").set("Authorization", `Bearer ${token}`),
      request(app).get("/api/v1/clients?pendingAcceptance=1&pageSize=1").set("Authorization", `Bearer ${token}`),
    ]);
    expect(summary.status).toBe(200);
    expect(list.status).toBe(200);
    expect(summary.body.awaitingAgent.count).toBe(list.body.total);

    await prisma.client.update({ where: { id: escalatedId }, data: { escalatedAt: null } });
    try {
      const after = await request(app).get("/api/v1/clients/summary").set("Authorization", `Bearer ${token}`);
      expect(after.body.awaitingAgent.count).toBe(summary.body.awaitingAgent.count + 1);
    } finally {
      await prisma.client.update({ where: { id: escalatedId }, data: { escalatedAt: new Date("2026-09-01T09:00:00Z") } });
    }
  });
});
