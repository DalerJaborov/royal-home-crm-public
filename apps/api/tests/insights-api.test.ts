import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { app } from "../src/app.js";
import request from "supertest";

let agentId: string;
let digestId: string;
let caseIds: string[];
let token: string;
let agentWithoutPhoneViewId: string;
let tokenWithoutPhoneView: string;

async function login(phone: string, password: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  // Уникальный суффикс чтобы избежать конфликтов unique-полей
  const suffix = Date.now().toString().slice(-6);
  const password = "testpass123";
  const passwordHash = await bcrypt.hash(password, 10);

  // Создаём тестового агента с правом insights.view
  const agent = await prisma.agent.create({
    data: {
      fullName: "Test Agent Insights",
      phone: `+99200000${suffix}1`,
      role: "AGENT",
      passwordHash,
      permissions: { granted: ["insights.view", "calls.ownTranscripts"], revoked: [] },
    },
  });
  agentId = agent.id;
  token = await login(agent.phone, password);

  // Агент БЕЗ права clients.viewPhone
  const agentNoPhone = await prisma.agent.create({
    data: {
      fullName: "Test Agent No Phone View",
      phone: `+99200000${suffix}2`,
      role: "AGENT",
      passwordHash,
      permissions: { granted: ["insights.view"], revoked: [] },
    },
  });
  agentWithoutPhoneViewId = agentNoPhone.id;
  tokenWithoutPhoneView = await login(agentNoPhone.phone, password);

  // Создаём клиент для кейсов
  const client = await prisma.client.create({
    data: {
      fullName: `Test Client Insight ${suffix}`,
      phone: `+9929188445${suffix.slice(0, 4)}`,
      kind: "BUYER",
      source: "WEBSITE",
    },
  });

  // Создаём диджест
  const periodStart = new Date("2026-09-01T00:00:00Z");
  const periodEnd = new Date("2026-09-15T23:59:59Z");
  const meetingAt = new Date("2026-09-15T09:00:00Z");

  const digest = await prisma.insightDigest.create({
    data: {
      periodStart,
      periodEnd,
      meetingAt,
      status: "READY",
      coverage: { calls: 100, analyzed: 80, findings: 5, penalties: 2 },
    },
  });
  digestId = digest.id;

  // Создаём 3 кейса с разными kind/severity
  const cases = await Promise.all([
    prisma.insightCase.create({
      data: {
        digestId,
        agentId,
        clientId: client.id,
        kind: "call_low_score",
        severity: 3,
        sourceKey: "call_abc123",
        timeline: {
          type: "call",
          transcript: "Клиент звонит на +992910001003 и говорит о покупке",
          notes: "Номер для связи: +992910001003",
        },
        verdict: {
          wrong: [{ quote: "неправильный подход", why: "агент перебил клиента" }],
          better: ["слушать активнее"],
          summary: "Нужно больше слушать",
        },
      },
    }),
    prisma.insightCase.create({
      data: {
        digestId,
        agentId,
        clientId: client.id,
        kind: "score_penalty",
        severity: 5,
        sourceKey: "penalty_xyz789", // gitleaks:allow -- reviewed synthetic test value or non-secret identifier
        timeline: {
          type: "penalty",
          description: "Штраф за грубость, звонок с +79161234567",
        },
        verdict: null,
      },
    }),
    prisma.insightCase.create({
      data: {
        digestId,
        agentId,
        clientId: client.id,
        kind: "positive",
        severity: 1,
        sourceKey: "good_call_001",
        timeline: "Отличный разговор, клиент доволен. Контакт: +992900123456",
        verdict: {
          summary: "Всё прошло хорошо",
        },
      },
    }),
  ]);
  caseIds = cases.map((c) => c.id);
});

afterAll(async () => {
  try {
    if (digestId) {
      await prisma.insightCase.deleteMany({ where: { digestId } });
      await prisma.insightDigest.delete({ where: { id: digestId } }).catch(() => {});
    }
    const agentIds = [agentId, agentWithoutPhoneViewId].filter(Boolean);
    if (agentIds.length > 0) {
      await prisma.agent.deleteMany({ where: { id: { in: agentIds as string[] } } });
    }
    await prisma.client.deleteMany({ where: { fullName: { contains: "Test Client Insight" } } });
  } finally {
    await prisma.$disconnect();
  }
});

describe("GET /insights", () => {
  it("возвращает массив с 1 диджестом", async () => {
    const res = await request(app)
      .get("/api/v1/insights")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    const digest = res.body.find((d: any) => d.id === digestId);
    expect(digest).toBeDefined();
    expect(digest.casesCount).toBe(3);
    expect(digest.status).toBe("READY");
  });
});

describe("GET /insights/:id", () => {
  it("возвращает 3 кейса с таймлайном и вердиктом", async () => {
    const res = await request(app)
      .get(`/api/v1/insights/${digestId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body).toHaveLength(3);

    // Проверяем первый кейс
    const firstCase = res.body.find((c: any) => c.kind === "call_low_score");
    expect(firstCase).toBeDefined();
    expect(firstCase.severity).toBe(3);
    expect(firstCase.verdict).toBeDefined();
    expect(firstCase.verdict.summary).toBe("Нужно больше слушать");
  });

  it("маскирует телефоны в timeline при отсутствии права clients.viewPhone", async () => {
    const res = await request(app)
      .get(`/api/v1/insights/${digestId}`)
      .set("Authorization", `Bearer ${tokenWithoutPhoneView}`)
      .expect(200);

    expect(res.body).toHaveLength(3);

    // Ищем кейс с телефоном в строке
    const caseWithStringTimeline = res.body.find((c: any) => typeof c.timeline === "string");
    if (caseWithStringTimeline) {
      expect(caseWithStringTimeline.timeline).not.toContain("+992900123456");
      // maskPhonesDeep использует CLIENT_PHONE_MASK_CHAR = "•"
      expect(caseWithStringTimeline.timeline).toContain("•••••");
    }

    // Ищем кейс с объектом timeline
    const caseWithObjectTimeline = res.body.find((c: any) => typeof c.timeline === "object");
    if (caseWithObjectTimeline) {
      const timelineStr = JSON.stringify(caseWithObjectTimeline.timeline);
      expect(timelineStr).not.toContain("+992910001003");
      expect(timelineStr).toContain("•••••");
    }
  });
});

describe("PATCH /insights/cases/:id", () => {
  it("обновляет reviewedAt и meetingNote", async () => {
    const caseId = caseIds[0];
    const reviewedAt = new Date().toISOString();
    const meetingNote = "Обсудили на собрании, агент исправился";

    const res = await request(app)
      .patch(`/api/v1/insights/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reviewedAt, meetingNote })
      .expect(200);

    expect(res.body.reviewedAt).toBe(reviewedAt);
    expect(res.body.meetingNote).toBe(meetingNote);
  });
});
describe("находка №156 (ночная проверка 24.09.2026): имя клиента и правка несуществующего дела", () => {
  let maskedAgentId = "";
  let maskedToken = "";
  let phoneAgentId = "";
  let phoneToken = "";
  let nameCaseId = "";
  const nameDigits = "910001004";

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash("testpass123", 10);
    const phone = `+99200001${Date.now().toString().slice(-6)}`;
    const agent = await prisma.agent.create({
      data: {
        fullName: "Test Agent Masked Insights",
        phone,
        role: "AGENT",
        passwordHash,
        // Право на разбор есть, права на номер клиента — нет.
        permissions: { granted: ["insights.view"], revoked: ["clients.viewPhone"] },
      },
    });
    maskedAgentId = agent.id;
    maskedToken = await login(phone, "testpass123");

    const phoneAgent = await prisma.agent.create({
      data: {
        fullName: "Test Agent Phone Insights",
        phone: `+99200002${Date.now().toString().slice(-6)}`,
        role: "AGENT",
        passwordHash,
        permissions: { granted: ["insights.view", "clients.viewPhone"], revoked: [] },
      },
    });
    phoneAgentId = phoneAgent.id;
    phoneToken = await login(phoneAgent.phone, "testpass123");

    const client = await prisma.client.create({
      data: {
        fullName: `Test Client Insight Входящий +992${nameDigits}`,
        phone: `+992900${Date.now().toString().slice(-6)}`,
        kind: "BUYER",
        source: "WEBSITE",
      },
    });
    const c = await prisma.insightCase.create({
      data: {
        digestId,
        agentId,
        clientId: client.id,
        kind: "call_low_score",
        severity: 2,
        sourceKey: "name_mask_case",
        timeline: { type: "call", transcript: "без номеров" },
        verdict: null,
      },
    });
    nameCaseId = c.id;
  });

  afterAll(async () => {
    await prisma.insightCase.deleteMany({ where: { id: nameCaseId } });
    await prisma.agent.deleteMany({ where: { id: { in: [maskedAgentId, phoneAgentId] } } });
  });

  it("без права на телефон номер внутри имени клиента закрыт маской", async () => {
    const res = await request(app).get(`/api/v1/insights/${digestId}`).set("Authorization", `Bearer ${maskedToken}`).expect(200);
    const row = res.body.find((c: { id: string }) => c.id === nameCaseId);
    expect(row).toBeDefined();
    expect(row.clientName).not.toContain(nameDigits);
    expect(row.clientName).toContain("•");
  });

  it("с правом на телефон имя отдаётся как есть", async () => {
    const res = await request(app).get(`/api/v1/insights/${digestId}`).set("Authorization", `Bearer ${phoneToken}`).expect(200);
    const row = res.body.find((c: { id: string }) => c.id === nameCaseId);
    expect(row.clientName).toContain(nameDigits);
  });

  it("PATCH несуществующего дела — 404, а не 500", async () => {
    const res = await request(app)
      .patch("/api/v1/insights/cases/00000000-0000-4000-8000-000000000000")
      .set("Authorization", `Bearer ${token}`)
      .send({ meetingNote: "нет такого дела" });
    expect(res.status).toBe(404);
  });
});
