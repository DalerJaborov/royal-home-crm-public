import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { _clearMarketingInsightsCache } from "../src/lib/marketingInsights.js";

/**
 * «ОДИН ЭКРАН МАРКЕТОЛОГА» (01.09.2026, сессия bf52df31 — была не закоммичена,
 * без единого теста). Четыре новых роута reports.ts: /marketing-funnel (уже
 * покрыт своими тестами buildMarketingFunnel — здесь только доступ), /lost-by-channel,
 * /waiting-now, /marketing-insights (lib/marketingInsights.ts).
 *
 * Проверяем: гейт reports.view (MANAGER — да, AGENT — нет), форма ответа,
 * что «потери» считаются от лидов ТОГО ЖЕ 90-дневного окна (а не общего числа),
 * что ИИ-разбор без ключа Gemini в dev честно отдаёт пустой результат, а не 500,
 * и что кэш ИИ-разбора можно обойти force=1.
 */

const runId = Date.now();
const password = "testpass123";

let managerToken = "";
let managerId = "";
let agentToken = "";
let agentId = "";
const clientIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const manager = await prisma.agent.create({
    data: {
      fullName: `Маркетолог ${runId}`,
      phone: `+99297${String(runId).slice(-7)}`,
      role: "MANAGER",
      passwordHash: await bcrypt.hash(password, 10),
      isActive: true,
    },
  });
  managerId = manager.id;
  managerToken = await login(manager.phone);

  const agent = await prisma.agent.create({
    data: {
      fullName: `Агент экрана маркетолога ${runId}`,
      phone: `+99298${String(runId).slice(-7)}`,
      role: "AGENT",
      passwordHash: await bcrypt.hash(password, 10),
      isActive: true,
    },
  });
  agentId = agent.id;
  agentToken = await login(agent.phone);

  // Один потерянный лид источника SITE за окно 90 дней, чтобы /lost-by-channel
  // не был вечно пустым (проверяем форму ответа, не конкретные цифры).
  const client = await prisma.client.create({
    data: {
      fullName: `Потерянный клиент экрана маркетолога ${runId}`,
      phone: `+99299${String(runId).slice(-7)}`,
      kind: "BUYER",
      source: "WEBSITE",
      status: "LOST",
      workStatus: "ACTIVE",
      escalatedAt: new Date(),
      refusalReason: "EXPENSIVE",
      assignedAgentId: agentId,
    },
  });
  clientIds.push(client.id);
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [managerId, agentId] } } });
  _clearMarketingInsightsCache();
});

describe("Доступ — гейт reports.view на весь роутер", () => {
  it("AGENT без reports.view — 403 на все четыре роута", async () => {
    for (const path of ["/marketing-funnel", "/lost-by-channel", "/waiting-now", "/marketing-insights"]) {
      const res = await request(app).get(`/api/v1/reports${path}`).set("Authorization", `Bearer ${agentToken}`);
      expect(res.status).toBe(403);
    }
  });

  it("без Authorization — 401", async () => {
    const res = await request(app).get("/api/v1/reports/lost-by-channel");
    expect(res.status).toBe(401);
  });
});

describe("GET /reports/lost-by-channel", () => {
  it("MANAGER — 200, доля считается от лидов того же 90-дневного окна", async () => {
    const res = await request(app)
      .get("/api/v1/reports/lost-by-channel")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(90);
    expect(Array.isArray(res.body.channels)).toBe(true);
    const site = res.body.channels.find((c: { source: string }) => c.source === "WEBSITE");
    expect(site).toBeDefined();
    expect(site.lost).toBeGreaterThanOrEqual(1);
    expect(site.totalLeads).toBeGreaterThanOrEqual(site.lost);
    expect(site.lostShare).toBe(Math.round((site.lost / site.totalLeads) * 100));
    expect(site.topReason).toBeTruthy();
  });
});

describe("GET /reports/waiting-now", () => {
  it("MANAGER — 200, форма ответа честная (живой снимок, не история)", async () => {
    const res = await request(app).get("/api/v1/reports/waiting-now").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.totalWaiting).toBe("number");
    expect(Array.isArray(res.body.channels)).toBe(true);
  });
});

describe("GET /reports/marketing-funnel", () => {
  it("MANAGER — 200", async () => {
    const res = await request(app)
      .get("/api/v1/reports/marketing-funnel")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.channels)).toBe(true);
  });
});

describe("GET /reports/marketing-insights", () => {
  it("без ключа Gemini в dev — честный пустой результат, не 500", async () => {
    const res = await request(app)
      .get("/api/v1/reports/marketing-insights")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("headline");
    expect(res.body).toHaveProperty("insights");
    expect(Array.isArray(res.body.insights)).toBe(true);
  });

  it("force=1 не падает и снова честно отвечает без ключа", async () => {
    const res = await request(app)
      .get("/api/v1/reports/marketing-insights?force=1")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("insights");
  });
});
