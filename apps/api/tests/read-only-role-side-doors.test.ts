import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { invalidateAgentAccess } from "../src/auth/middleware.js";
import { issueLeadActionToken } from "../src/lib/pushLeadActions.js";
import { buildConnectUrl, completeConnect, MetaAdsConnectError } from "../src/lib/ads/metaAdsOAuth.js";
import { agentAccessCanWriteAds as canWriteAds, agentCanWriteAds } from "../src/lib/ads/adsWriteAccess.js";
import * as scoreRecommendation from "../src/lib/scoreRecommendation.js";

/**
 * Три «боковые двери» роли «только просмотр» (ревью Codex 10.10.2026,
 * CODEX-ROLES-08436-SOURCE-REVIEW.md). Запрет записи стоит в requireAuth, но:
 *  1) POST /push/action идёт БЕЗ requireAuth по подписанному маркеру, выданному
 *     до смены роли — действие обязано отбиться по текущей роли;
 *  2) GET /me/royal-score при пустом кэше генерировал ИИ-совет и писал его —
 *     чтение акционера не должно иметь побочных действий;
 *  3) OAuth-колбэк Meta пишет маркер в Settings по `state`, выданному при нажатии
 *     кнопки — право проверяется заново перед записью.
 * У каждого запрета есть положительный контроль, иначе зелёный тест ничего не
 * доказывает (CLAUDE.md: «новый сторож проверяется внесением поломки»).
 */

vi.mock("../src/lib/scoreRecommendation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/scoreRecommendation.js")>()),
  generateScoreAdvice: vi.fn(async () => null),
}));

const runId = String(Date.now()).slice(-7);
let shareholderId = "";
let shareholderToken = "";
let agentId = "";
let agentToken = "";
let adminId = "";
let inactiveId = "";
const clientIds: string[] = [];
let savedPushEnabled: boolean | null = null;
let savedRoyalScore: boolean | null = null;
const savedEnv = {
  META_APP_ID: process.env.META_APP_ID,
  META_APP_SECRET: process.env.META_APP_SECRET,
  CRM_PUBLIC_URL: process.env.CRM_PUBLIC_URL,
};

async function makeClient(suffix: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент боковой двери ${runId}${suffix}`,
      phone: `+99293${suffix}${runId.slice(-5)}`,
      source: "PHONE_CALL",
    },
  });
  clientIds.push(c.id);
  return c.id;
}

beforeAll(async () => {
  const mk = (fullName: string, phone: string, role: "SHAREHOLDER" | "AGENT" | "ADMIN", isActive = true) =>
    prisma.agent.create({ data: { fullName, phone, role, passwordHash: "x", isActive } });
  shareholderId = (await mk(`Акционер дверь ${runId}`, `+992981${runId}`, "SHAREHOLDER")).id;
  agentId = (await mk(`Агент дверь ${runId}`, `+992982${runId}`, "AGENT")).id;
  adminId = (await mk(`Админ дверь ${runId}`, `+992983${runId}`, "ADMIN")).id;
  inactiveId = (await mk(`Отключённый дверь ${runId}`, `+992984${runId}`, "AGENT", false)).id;
  shareholderToken = signAccessToken({ sub: shareholderId, role: "SHAREHOLDER" });
  agentToken = signAccessToken({ sub: agentId, role: "AGENT" });

  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedPushEnabled = settings.pushLeadActionsEnabled;
  savedRoyalScore = settings.royalScoreEnabled;
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { pushLeadActionsEnabled: true, royalScoreEnabled: true },
  });
  process.env.META_APP_ID = "test-app-id";
  process.env.META_APP_SECRET = "test-app-secret";
  process.env.CRM_PUBLIC_URL = "https://crm.test";
});

afterAll(async () => {
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { pushLeadActionsEnabled: savedPushEnabled ?? undefined, royalScoreEnabled: savedRoyalScore ?? undefined },
  });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const agents = [shareholderId, agentId, adminId, inactiveId];
  await prisma.pushActionToken.deleteMany({ where: { agentId: { in: agents } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agents } } });
  invalidateAgentAccess();
  await prisma.$disconnect();
});

describe("1. POST /push/action — маркер, выданный до смены роли", () => {
  it("акционер: действие отбивается, лид не назначен", async () => {
    const clientId = await makeClient("1");
    const token = await issueLeadActionToken(shareholderId, clientId, 10);
    const res = await request(app).post("/api/v1/push/action").send({ token, action: "lead-accept" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toBe("Действие недоступно — откройте CRM");
    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { assignedAgentId: true } });
    expect(client?.assignedAgentId).toBeNull();
  });

  it("отключённая учётка: то же самое", async () => {
    const clientId = await makeClient("2");
    const token = await issueLeadActionToken(inactiveId, clientId, 10);
    const res = await request(app).post("/api/v1/push/action").send({ token, action: "lead-accept" });
    expect(res.body.ok).toBe(false);
    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { assignedAgentId: true } });
    expect(client?.assignedAgentId).toBeNull();
  });

  it("положительный контроль: живой агент тем же путём доходит до действия", async () => {
    const clientId = await makeClient("3");
    const token = await issueLeadActionToken(agentId, clientId, 10);
    const res = await request(app).post("/api/v1/push/action").send({ token, action: "lead-accept" });
    expect(res.status).toBe(200);
    // Не «Действие недоступно»: проверка роли пройдена, дальше работает acceptLead
    // со своими правилами (портфель, окно) — его исход здесь не предмет теста.
    expect(res.body.message).not.toBe("Действие недоступно — откройте CRM");
  });
});

describe("2. GET /me/royal-score — чтение без побочных действий", () => {
  it("акционер: ИИ-совет не генерируется и не пишется", async () => {
    vi.mocked(scoreRecommendation.generateScoreAdvice).mockClear();
    const res = await request(app).get("/api/v1/me/royal-score").set("Authorization", `Bearer ${shareholderToken}`);
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) expect(res.body.advice).toBeNull();
    expect(scoreRecommendation.generateScoreAdvice).not.toHaveBeenCalled();
  });

  it("положительный контроль: агенту с пустым кэшем совет генерируется", async () => {
    vi.mocked(scoreRecommendation.generateScoreAdvice).mockClear();
    const res = await request(app).get("/api/v1/me/royal-score").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(scoreRecommendation.generateScoreAdvice).toHaveBeenCalledTimes(1);
  });
});

describe("3. OAuth-колбэк Meta — право проверяется заново перед записью", () => {
  it("canWriteAds: акционер — нет даже с finance.manage, маркетинг и finance.manage — да", () => {
    expect(canWriteAds("SHAREHOLDER", new Set(["finance.manage"]))).toBe(false);
    expect(canWriteAds("MARKETING", new Set())).toBe(true);
    expect(canWriteAds("ADMIN", new Set(["finance.manage"]))).toBe(true);
    expect(canWriteAds("AGENT", new Set())).toBe(false);
  });

  it("agentCanWriteAds по базе: админ — да, акционер и отключённый — нет", async () => {
    invalidateAgentAccess();
    expect(await agentCanWriteAds(adminId)).toBe(true);
    expect(await agentCanWriteAds(shareholderId)).toBe(false);
    expect(await agentCanWriteAds(inactiveId)).toBe(false);
    expect(await agentCanWriteAds("00000000-0000-4000-8000-000000000000")).toBe(false);
  });

  it("completeConnect: state акционера сгорает и падает на праве, не доходя до обмена кода", async () => {
    const url = await buildConnectUrl(shareholderId);
    const state = new URL(url).searchParams.get("state")!;
    expect(state).toBeTruthy();
    invalidateAgentAccess(shareholderId);
    const before = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaAdsToken: true } });
    await expect(completeConnect("code-x", state)).rejects.toThrow(MetaAdsConnectError);
    await expect(completeConnect("code-x", state)).rejects.toThrow(/просрочено|использовано/);
    const after = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaAdsToken: true } });
    expect(after?.metaAdsToken ?? null).toBe(before?.metaAdsToken ?? null);
  });

  it("completeConnect: текст отказа называет право, а не «просрочено»", async () => {
    const state = new URL(await buildConnectUrl(shareholderId)).searchParams.get("state")!;
    await expect(completeConnect("code-x", state)).rejects.toThrow(/Вести расходы/);
  });
});
