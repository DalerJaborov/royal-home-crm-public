import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * ИИ-разбор рекламы (/api/v1/ads/insights) и деньги компании (21.11.2026).
 *
 * Раздел открыт роли MARKETING, а в подсказку модели шла «прибыль N с.» по
 * проданным объектам, и разбор называл её словами; кэш был общий на всех.
 * Правило то же, что у /ads/report: прибыль и комиссия — только с finance.view.
 *
 * Проверяется:
 *   1. маркетолог (без finance.view): в подсказке модели нет прибыли и комиссии;
 *   2. директор: есть;
 *   3. кэш раздельный: директор, затем маркетолог — маркетолог не получает
 *      директорский текст, модель зовётся заново без денег.
 * Вызов ИИ и отчёт по объектам подменены: важно, ЧТО уходит в подсказку.
 */

const callAiText = vi.fn();

vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));

vi.mock("../src/lib/ads/adSpendReport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ads/adSpendReport.js")>()),
  buildAdSpendReport: vi.fn(async () => ({
    month: "2026-11",
    from: "2026-11-01",
    to: "2026-11-30",
    truncated: false,
    totals: { spendTjs: 100, spendOriginal: null, currency: null, impressions: 10, clicks: 2, conversations: 1, adsCount: 1 },
    rows: [
      {
        property: { id: "p1", shortId: 777, status: "SOLD" },
        spendTjs: 100,
        impressions: 10,
        clicks: 2,
        conversations: 1,
        comments: null,
        campaigns: ["Тест"],
        profitTjs: 31337.5,
        commissionTjs: 41337.5,
        lifetimeSpendTjs: 10000,
      },
    ],
  })),
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { _clearInsightsCache } = await import("../src/lib/ads/adInsights.js");

const runId = String(Date.now()).slice(-7);
const password = "testpass123";
const agentIds: string[] = [];
let directorToken = "";
let marketingToken = "";

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken;
}

const insights = (token: string) =>
  request(app).get("/api/v1/ads/insights?month=2026-11").set("Authorization", `Bearer ${token}`);

/** Всё, что ушло модели в последнем вызове: и system, и user. */
function lastPrompt(): string {
  const call = callAiText.mock.calls.at(-1)?.[0] as { system: string; user: string };
  return `${call.system}\n${call.user}`;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const [director, marketing] = await Promise.all([
    prisma.agent.create({ data: { fullName: "Директор разбора", phone: `+99297${runId}`, role: "DIRECTOR", passwordHash } }),
    prisma.agent.create({ data: { fullName: "Маркетолог разбора", phone: `+99298${runId}`, role: "MARKETING", passwordHash } }),
  ]);
  agentIds.push(director.id, marketing.id);
  directorToken = await login(director.phone);
  marketingToken = await login(marketing.phone);
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

beforeEach(() => {
  _clearInsightsCache();
  callAiText.mockReset();
  callAiText.mockImplementation(async (opts: { system: string }) => ({
    analysis: opts.system.includes("прибыль") ? "ТЕКСТ С ДЕНЬГАМИ" : "ТЕКСТ БЕЗ ДЕНЕГ",
  }));
});

describe("ИИ-разбор рекламы: деньги компании только с finance.view", () => {
  it("маркетолог получает разбор, а в подсказке модели нет прибыли и комиссии", async () => {
    const res = await insights(marketingToken);
    expect(res.status).toBe(200);
    expect(res.body.text).toBe("ТЕКСТ БЕЗ ДЕНЕГ");
    const prompt = lastPrompt();
    expect(prompt).not.toMatch(/прибыл/i);
    expect(prompt).not.toMatch(/комисс/i);
    expect(prompt).not.toContain("31337");
    // расход на рекламу маркетологу виден — разбор по нему и строится
    expect(prompt).toContain("100.00");
  });

  it("директор получает разбор с прибылью", async () => {
    const res = await insights(directorToken);
    expect(res.status).toBe(200);
    expect(res.body.text).toBe("ТЕКСТ С ДЕНЬГАМИ");
    expect(lastPrompt()).toContain("прибыль 31337.50 с.");
  });

  it("кэш не смешивается: директор, потом маркетолог", async () => {
    const first = await insights(directorToken);
    expect(first.body.text).toBe("ТЕКСТ С ДЕНЬГАМИ");
    const second = await insights(marketingToken);
    expect(second.body.text).toBe("ТЕКСТ БЕЗ ДЕНЕГ");
    expect(second.body.cached).toBe(false);
    expect(lastPrompt()).not.toMatch(/прибыл|комисс/i);
    expect(callAiText).toHaveBeenCalledTimes(2);
    // и каждый свой кэш получает повторно без нового вызова модели
    expect((await insights(marketingToken)).body).toMatchObject({ text: "ТЕКСТ БЕЗ ДЕНЕГ", cached: true });
    expect((await insights(directorToken)).body).toMatchObject({ text: "ТЕКСТ С ДЕНЬГАМИ", cached: true });
    expect(callAiText).toHaveBeenCalledTimes(2);
  });

  it("обратный порядок: маркетолог, потом директор — директор не получает урезанный текст", async () => {
    expect((await insights(marketingToken)).body.text).toBe("ТЕКСТ БЕЗ ДЕНЕГ");
    const res = await insights(directorToken);
    expect(res.body.text).toBe("ТЕКСТ С ДЕНЬГАМИ");
    expect(res.body.cached).toBe(false);
  });
});
