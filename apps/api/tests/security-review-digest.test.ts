import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { buildSecurityReviewDigest } from "../src/lib/securityReviewDigest.js";

/**
 * Недельная сводка СБ (план 03.09.2026, §E, п. 2-3): «43 отказа за неделю, 5 со
 * сделкой на стороне, из них 3 у Фарруха — у остальных агентов 0-1».
 *
 * ОКНО ВРЕМЕНИ У КАЖДОГО ТЕСТА СВОЁ И ИСКУССТВЕННОЕ (2021 год) — база общая с
 * другими файлами и прогонами (тот же приём, что в problem-report.test.ts:
 * «только ПРИРОСТ от собственных записей»). buildSecurityReviewDigest не
 * фильтрует по клиенту или агенту — только по createdAt диапазону, поэтому
 * обычное «за последнюю неделю» подхватило бы живые CLIENT_REFUSE записи из
 * client-refuse.test.ts/explicit-refusal-detector.test.ts/property-summary-
 * branching.test.ts, гоняющихся в том же прогоне. Фиксированная дата вне
 * правдоподобного диапазона любого другого теста и СВОЙ узкий интервал на
 * каждый it() снимают вопрос совсем — в т.ч. между собственными тестами файла:
 * они не чистят AuditLog друг за другом (только в afterAll), и общее окно
 * склеило бы счётчики агентов между тестами.
 */

const runId = Date.now();
let agentAId: string;
let agentBId: string;
const clientIds: string[] = [];
const auditLogIds: string[] = [];
/** Агенты, заведённые ВНУТРИ вложенных describe (HTTP-тесты ниже) — тоже
 *  удаляются здесь, в файловом afterAll, а не в своём локальном: порядок
 *  hook'ов у vitest обратный (вложенный afterAll срабатывает РАНЬШЕ
 *  родительского), и удаление агента раньше клиента, который на него
 *  ссылается через assignedAgentId (FK), падало бы нарушением ограничения. */
const extraAgentIds: string[] = [];

async function makeClient(kind: "BUYER" | "SELLER", agentId: string, suffix: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `СБ-сводка тест ${suffix} ${runId}`,
      phone: `+99292${suffix.length}${runId}${suffix}`,
      source: "PHONE_CALL",
      kind,
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

async function seedRefusal(opts: {
  clientId: string;
  agentId: string | null;
  agentName: string;
  assignedAgentId: string;
  reason: string;
  comment?: string;
  voiceNoteUrl?: string;
  autoDetected?: boolean;
  at: Date;
}) {
  const row = await prisma.auditLog.create({
    data: {
      action: "CLIENT_REFUSE",
      entityType: "Client",
      entityId: opts.clientId,
      agentId: opts.agentId,
      agentName: opts.agentName,
      createdAt: opts.at,
      meta: {
        reason: opts.reason,
        comment: opts.comment ?? null,
        competitorName: null,
        voiceNoteUrl: opts.voiceNoteUrl ?? null,
        assignedAgentId: opts.assignedAgentId,
        autoDetected: !!opts.autoDetected,
      },
    },
  });
  auditLogIds.push(row.id);
  return row;
}

beforeAll(async () => {
  agentAId = (
    await prisma.agent.create({
      data: { fullName: `Фаррух СБ-тест ${runId}`, phone: `+992921${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  agentBId = (
    await prisma.agent.create({
      data: { fullName: `Обычный агент СБ-тест ${runId}`, phone: `+992922${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { id: { in: auditLogIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentAId, agentBId, ...extraAgentIds] } } });
  await prisma.$disconnect();
});

describe("buildSecurityReviewDigest", () => {
  it("totalRefusals считает ЛЮБУЮ причину, securityReviewCount — только SB-список", async () => {
    const win = { from: new Date(2021, 0, 1, 0, 0, 0), to: new Date(2021, 0, 1, 1, 0, 0) };
    const c1 = await makeClient("BUYER", agentBId, "t1a");
    const c2 = await makeClient("BUYER", agentBId, "t1b");
    await seedRefusal({
      clientId: c1.id, agentId: agentBId, agentName: "Обычный агент", assignedAgentId: agentBId,
      reason: "EXPENSIVE", comment: "дорого", at: new Date(win.from.getTime() + 1000),
    });
    await seedRefusal({
      clientId: c2.id, agentId: agentBId, agentName: "Обычный агент", assignedAgentId: agentBId,
      reason: "BOUGHT_SELF", comment: "Клиент написал в переписке: «уже купил»", at: new Date(win.from.getTime() + 2000),
    });

    const digest = await buildSecurityReviewDigest(win);
    expect(digest.totalRefusals).toBe(2);
    expect(digest.securityReviewCount).toBe(1);
    expect(digest.cases).toHaveLength(1);
    expect(digest.cases[0].reason).toBe("BOUGHT_SELF");
    expect(digest.cases[0].quote).toContain("уже купил");
  });

  it("CHANGED_MIND/WITHDRAWN_FROM_SALE не попадают в securityReviewCount (план §E)", async () => {
    const win = { from: new Date(2021, 0, 2, 0, 0, 0), to: new Date(2021, 0, 2, 1, 0, 0) };
    const c1 = await makeClient("BUYER", agentBId, "t2a");
    const c2 = await makeClient("SELLER", agentBId, "t2b");
    await seedRefusal({
      clientId: c1.id, agentId: agentBId, agentName: "Обычный агент", assignedAgentId: agentBId,
      reason: "CHANGED_MIND", at: new Date(win.from.getTime() + 1000),
    });
    await seedRefusal({
      clientId: c2.id, agentId: agentBId, agentName: "Обычный агент", assignedAgentId: agentBId,
      reason: "WITHDRAWN_FROM_SALE", at: new Date(win.from.getTime() + 2000),
    });

    const digest = await buildSecurityReviewDigest(win);
    expect(digest.totalRefusals).toBe(2);
    expect(digest.securityReviewCount).toBe(0);
    expect(digest.cases).toHaveLength(0);
  });

  it("случай от детектора (agentId=null) попадает в разбивку через meta.assignedAgentId", async () => {
    const win = { from: new Date(2021, 0, 3, 0, 0, 0), to: new Date(2021, 0, 3, 1, 0, 0) };
    const c = await makeClient("SELLER", agentAId, "t3");
    await seedRefusal({
      clientId: c.id, agentId: null, agentName: "Система", assignedAgentId: agentAId,
      reason: "SOLD_SELF", comment: "детектор поймал явный отказ", autoDetected: true,
      at: new Date(win.from.getTime() + 1000),
    });

    const digest = await buildSecurityReviewDigest(win);
    const row = digest.byAgent.find((a) => a.agentId === agentAId);
    expect(row?.count).toBe(1);
    const found = digest.cases.find((cs) => cs.clientId === c.id);
    expect(found?.autoDetected).toBe(true);
    expect(found?.agentId).toBe(agentAId);
  });

  it("recordingUrl — из meta.voiceNoteUrl, когда есть; null, когда нет", async () => {
    const win = { from: new Date(2021, 0, 4, 0, 0, 0), to: new Date(2021, 0, 4, 1, 0, 0) };
    const withVoice = await makeClient("BUYER", agentBId, "t4a");
    const withoutVoice = await makeClient("BUYER", agentBId, "t4b");
    await seedRefusal({
      clientId: withVoice.id, agentId: agentBId, agentName: "Обычный агент", assignedAgentId: agentBId,
      reason: "BOUGHT_SELF", voiceNoteUrl: "/me/voice-notes/abc.webm", at: new Date(win.from.getTime() + 1000),
    });
    await seedRefusal({
      clientId: withoutVoice.id, agentId: agentBId, agentName: "Обычный агент", assignedAgentId: agentBId,
      reason: "BOUGHT_SELF", at: new Date(win.from.getTime() + 2000),
    });

    const digest = await buildSecurityReviewDigest(win);
    const caseWith = digest.cases.find((cs) => cs.clientId === withVoice.id);
    const caseWithout = digest.cases.find((cs) => cs.clientId === withoutVoice.id);
    expect(caseWith?.recordingUrl).toBe("/me/voice-notes/abc.webm");
    expect(caseWithout?.recordingUrl).toBeNull();
  });

  it("аномалия: 3+ у одного агента при 0-1 у остальных", async () => {
    const win = { from: new Date(2021, 0, 5, 0, 0, 0), to: new Date(2021, 0, 5, 1, 0, 0) };
    for (let i = 0; i < 3; i++) {
      const c = await makeClient("BUYER", agentAId, `t5a${i}`);
      await seedRefusal({
        clientId: c.id, agentId: agentAId, agentName: "Фаррух", assignedAgentId: agentAId,
        reason: "BOUGHT_SELF", at: new Date(win.from.getTime() + 1000 + i * 1000),
      });
    }
    const cB = await makeClient("BUYER", agentBId, "t5b");
    await seedRefusal({
      clientId: cB.id, agentId: agentBId, agentName: "Обычный агент", assignedAgentId: agentBId,
      reason: "SOLD_VIA_OTHER_AGENCY", at: new Date(win.from.getTime() + 10000),
    });

    const digest = await buildSecurityReviewDigest(win);
    const rowA = digest.byAgent.find((a) => a.agentId === agentAId)!;
    const rowB = digest.byAgent.find((a) => a.agentId === agentBId)!;
    expect(rowA.count).toBe(3);
    expect(rowA.anomaly).toBe(true);
    expect(rowB.count).toBe(1);
    expect(rowB.anomaly).toBe(false);
  });

  it("двое агентов с 3+ случаями — ни один не помечен аномалией одиночно (не «норма команды»)", async () => {
    const win = { from: new Date(2021, 0, 6, 0, 0, 0), to: new Date(2021, 0, 6, 1, 0, 0) };
    for (let i = 0; i < 3; i++) {
      const cA = await makeClient("BUYER", agentAId, `t6a${i}`);
      await seedRefusal({
        clientId: cA.id, agentId: agentAId, agentName: "Фаррух", assignedAgentId: agentAId,
        reason: "BOUGHT_SELF", at: new Date(win.from.getTime() + 1000 + i * 1000),
      });
      const cB = await makeClient("BUYER", agentBId, `t6b${i}`);
      await seedRefusal({
        clientId: cB.id, agentId: agentBId, agentName: "Обычный агент", assignedAgentId: agentBId,
        reason: "BOUGHT_SELF", at: new Date(win.from.getTime() + 20000 + i * 1000),
      });
    }

    const digest = await buildSecurityReviewDigest(win);
    const rowA = digest.byAgent.find((a) => a.agentId === agentAId)!;
    const rowB = digest.byAgent.find((a) => a.agentId === agentBId)!;
    expect(rowA.count).toBe(3);
    expect(rowB.count).toBe(3);
    expect(rowA.anomaly).toBe(false);
    expect(rowB.anomaly).toBe(false);
  });

  it("вне диапазона дат — не учитывается", async () => {
    const win = { from: new Date(2021, 0, 7, 0, 0, 0), to: new Date(2021, 0, 7, 1, 0, 0) };
    const c = await makeClient("BUYER", agentBId, "t7");
    // На час раньше начала окна — за пределами диапазона.
    await seedRefusal({
      clientId: c.id, agentId: agentBId, agentName: "Обычный агент", assignedAgentId: agentBId,
      reason: "BOUGHT_SELF", at: new Date(win.from.getTime() - 60 * 60 * 1000),
    });

    const digest = await buildSecurityReviewDigest(win);
    expect(digest.totalRefusals).toBe(0);
    expect(digest.cases).toHaveLength(0);
  });

  it("defaultWeeklyRange без аргументов не падает и возвращает согласованный from/to", async () => {
    const digest = await buildSecurityReviewDigest();
    expect(digest.to.getTime()).toBeGreaterThan(digest.from.getTime());
    expect(digest.to.getTime() - digest.from.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

/** Investigation digest is ADMIN/DIRECTOR only; reports.view is insufficient. */
describe("GET /api/v1/reports/security-review-digest", () => {
  const password = "testpass123";
  let plainAgentToken: string;
  let managerAgentId: string;
  let managerToken: string;
  let adminToken: string;

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    const plainAgent = await prisma.agent.create({
      data: { fullName: `Рядовой агент СБ-эндпоинт ${runId}`, phone: `+992923${runId}`, role: "AGENT", passwordHash },
    });
    const manager = await prisma.agent.create({
      data: { fullName: `Руководитель СБ-эндпоинт ${runId}`, phone: `+992924${runId}`, role: "MANAGER", passwordHash },
    });
    managerAgentId = manager.id;
    const admin = await prisma.agent.create({ data: { fullName: `Администратор сводки ${runId}`, phone: `+992925${runId}`, role: "ADMIN", passwordHash } });
    extraAgentIds.push(admin.id);
    const adminRes = await request(app).post("/api/v1/auth/login").send({ phone: `+992925${runId}`, password });
    expect(adminRes.status).toBe(200);
    adminToken = adminRes.body.accessToken as string;
    // В extraAgentIds, а не в свой afterAll — см. комментарий у объявления
    // extraAgentIds выше (порядок hook'ов и FK на assignedAgentId).
    extraAgentIds.push(plainAgent.id, manager.id);

    const plainRes = await request(app).post("/api/v1/auth/login").send({ phone: `+992923${runId}`, password });
    expect(plainRes.status).toBe(200);
    plainAgentToken = plainRes.body.accessToken as string;

    const managerRes = await request(app).post("/api/v1/auth/login").send({ phone: `+992924${runId}`, password });
    expect(managerRes.status).toBe(200);
    managerToken = managerRes.body.accessToken as string;
  });

  it("рядовому агенту без reports.view — 403", async () => {
    const res = await request(app)
      .get("/api/v1/reports/security-review-digest")
      .set("Authorization", `Bearer ${plainAgentToken}`);
    expect(res.status).toBe(403);
  });

  it("менеджеру с reports.view — 403", async () => {
    const res = await request(app).get("/api/v1/reports/security-review-digest").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(403);
  });

  it("администратору — 200, данные за явно заданный период", async () => {
    const c = await makeClient("BUYER", managerAgentId, "http1");
    // Полдень UTC 10 января — заведомо внутри суток «10 января» при любом
    // разумном смещении часового пояса (Душанбе UTC+5), без риска соскользнуть
    // в соседние сутки на границе (та самая ловушка местного `new Date(y,m,d)`,
    // который читает компоненты в часовом поясе ПРОЦЕССА, а не Душанбе/UTC).
    await seedRefusal({
      clientId: c.id, agentId: managerAgentId, agentName: "Руководитель", assignedAgentId: managerAgentId,
      reason: "BOUGHT_VIA_OTHER_AGENCY", comment: "Клиент написал: «купили через агентство Sitora»",
      at: new Date(Date.UTC(2021, 0, 10, 12, 0, 0)),
    });

    const res = await request(app)
      .get("/api/v1/reports/security-review-digest")
      .query({ from: "2021-01-10", to: "2021-01-11" })
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.securityReviewCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.cases)).toBe(true);
    expect(res.body.cases.some((cs: { clientId: string }) => cs.clientId === c.id)).toBe(true);
  });

  it("без токена — 401", async () => {
    const res = await request(app).get("/api/v1/reports/security-review-digest");
    expect(res.status).toBe(401);
  });
});
