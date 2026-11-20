import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { morningBriefingSchema } from "@royal-home/shared";

/**
 * Утренний брифинг директору внутри CRM (GET /api/v1/dashboard/briefing).
 *
 * Проверяется ровно то, что ломается тихо:
 *   1. Права: агент получает 403, директор — 200. Брифинг содержит комиссию
 *      месяца и потерянные звонки, то есть данные всей компании.
 *   2. Кеш на сутки: модель зовётся ОДИН раз, сколько бы раз директор ни
 *      открыл главную. Без этого каждое обновление вкладки — оплаченный вызов.
 *   3. Отказ ИИ — не ошибка экрана: source становится "fallback", а текст
 *      собирается по числам (тот же, что buildFallbackBriefingText).
 *
 * callAiText и synthesizeSpeech замоканы: настоящий вызов — это сеть и деньги,
 * а здесь важно только сколько раз он был сделан и что вернулось.
 */

const callAiText = vi.fn();

vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText }));

vi.mock("../src/ai/tts.js", () => ({
  synthesizeSpeech: vi.fn(async () => ({
    audioBase64: Buffer.alloc(200).toString("base64"),
    sampleRateHz: 24000,
  })),
  // lib/greetingVoice.ts берёт отсюда имя модели для ключа кеша.
  GEMINI_TTS_MODEL: "gemini-2.5-flash-preview-tts",
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { resetBriefingCache, buildFallbackBriefingText, pickBriefingNumbers } = await import(
  "../src/lib/morningBriefing.js"
);
const { loadMorningNumbers } = await import("../src/lib/morningNumbers.js");

const runId = Date.now();
const password = "testpass123";
const directorPhone = `+99295${String(runId).slice(-7)}`;
const agentPhone = `+99296${String(runId).slice(-7)}`;
const managerPhone = `+99294${String(runId).slice(-7)}`;

let directorId: string;
let agentId: string;
let directorToken: string;
let agentToken: string;
let managerId: string;
let managerToken: string;

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const director = await prisma.agent.create({
    data: { fullName: "Брифинг Директор", phone: directorPhone, role: "DIRECTOR", passwordHash, isActive: true },
  });
  directorId = director.id;
  const agent = await prisma.agent.create({
    data: { fullName: "Брифинг Агент", phone: agentPhone, role: "AGENT", passwordHash, isActive: true },
  });
  agentId = agent.id;

  // Руководитель: dashboard.analytics есть, finance.view нет.
  const manager = await prisma.agent.create({
    data: { fullName: "Брифинг Руководитель", phone: managerPhone, role: "MANAGER", passwordHash, isActive: true },
  });
  managerId = manager.id;

  directorToken = await login(directorPhone);
  agentToken = await login(agentPhone);
  managerToken = await login(managerPhone);
});

afterAll(async () => {
  await prisma.agent.delete({ where: { id: directorId } }).catch(() => {});
  await prisma.agent.delete({ where: { id: agentId } }).catch(() => {});
  await prisma.agent.delete({ where: { id: managerId } }).catch(() => {});
  const dir = path.join(
    path.resolve(process.env.PRIVATE_UPLOADS_DIR ?? "./uploads-private"),
    "voice",
    "briefings"
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetBriefingCache();
  callAiText.mockReset();
});

describe("GET /api/v1/dashboard/briefing", () => {
  it("401 без авторизации", async () => {
    const res = await request(app).get("/api/v1/dashboard/briefing");
    expect(res.status).toBe(401);
  });

  it("403 агенту: брифинг — данные всей компании", async () => {
    callAiText.mockResolvedValue({ text: "Текст брифинга." });
    const res = await request(app)
      .get("/api/v1/dashboard/briefing")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
    // Отказ по правам не должен успевать позвать модель.
    expect(callAiText).not.toHaveBeenCalled();
  });

  it("директору отдаёт форму, проходящую morningBriefingSchema", async () => {
    callAiText.mockResolvedValue({ text: "Сегодня у команды дела идут ровно. Данных нет по касаниям." });
    const res = await request(app)
      .get("/api/v1/dashboard/briefing")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    const parsed = morningBriefingSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect(res.body.source).toBe("ai");
    expect(res.body.text).toContain("Данных нет");
  });

  it("кеш на сутки: повторный запрос не зовёт модель второй раз", async () => {
    callAiText.mockResolvedValue({ text: "Первый и единственный текст за сегодня." });
    const first = await request(app)
      .get("/api/v1/dashboard/briefing")
      .set("Authorization", `Bearer ${directorToken}`);
    const second = await request(app)
      .get("/api/v1/dashboard/briefing")
      .set("Authorization", `Bearer ${directorToken}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.text).toBe(first.body.text);
    expect(second.body.dushanbeDate).toBe(first.body.dushanbeDate);
    expect(callAiText).toHaveBeenCalledTimes(1);
  });

  it("отказ ИИ — честный текст по числам, а не пустой экран", async () => {
    callAiText.mockResolvedValue(null);
    const res = await request(app)
      .get("/api/v1/dashboard/briefing")
      .set("Authorization", `Bearer ${directorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("fallback");
    expect(res.body.text).toBe(buildFallbackBriefingText(pickBriefingNumbers(await loadMorningNumbers())));
    expect(res.body.text.length).toBeGreaterThan(0);
  });
});

describe("buildFallbackBriefingText", () => {
  const zero = pickBriefingNumbers({
    tasksToday: 0,
    leadsYesterday: 0,
    dealsYesterday: 0,
    commissionMonth: 0,
    errorsYesterday: 0,
    incomingYesterday: 0,
    missedYesterday: 0,
    unqualifiedNow: 0,
    firstTouchMedianMin: null,
    firstTouchSlowCount: 0,
    firstTouchNoneCount: 0,
    unvisitedScreens: [],
    sellersWithoutPropertyOver7Days: 0,
    showingSummariesOverdue48h: 0,
    soldElsewhereWeek: 0,
    changedMindWeek: 0,
    emptySellerCardsWeek: 0,
    reactivationSentThisWeek: 0,
    reactivationRepliedThisWeek: 0,
    reviewsYesterday: 0,
  });

  it("нет данных по первому касанию — так и говорит, а не пишет ноль минут", () => {
    const text = buildFallbackBriefingText(zero);
    expect(text).toContain("данных нет");
    expect(text).not.toContain("за 0 минут");
  });

  it("не выдумывает ошибок, которых не было", () => {
    expect(buildFallbackBriefingText(zero)).not.toContain("ошиб");
  });
});

describe("GET /api/v1/dashboard/briefing: комиссия компании только с finance.view (21.11.2026)", () => {
  const get = (token: string) => request(app).get("/api/v1/dashboard/briefing").set("Authorization", `Bearer ${token}`);
  const factsOf = (call: number) => (callAiText.mock.calls[call]?.[0] as { user: string }).user;

  it("руководитель без finance.view: нет комиссии ни в числах, ни в подсказке, ни в запасном тексте", async () => {
    callAiText.mockResolvedValue({ text: "Спокойное утро." });
    const res = await get(managerToken);
    expect(res.status).toBe(200);
    expect(res.body.numbers.commissionMonth).toBeNull();
    expect(morningBriefingSchema.safeParse(res.body).success).toBe(true);
    expect(factsOf(0)).not.toMatch(/комисс/i);

    resetBriefingCache();
    callAiText.mockResolvedValue(null);
    const fallback = await get(managerToken);
    expect(fallback.body.text).not.toMatch(/комисс/i);
  });

  it("директор видит комиссию; кэш не смешивается в обе стороны", async () => {
    callAiText.mockResolvedValue({ text: "Утро." });
    const director = await get(directorToken);
    expect(director.body.numbers.commissionMonth).toEqual(expect.any(Number));
    expect(factsOf(0)).toMatch(/комисс/i);

    // директор уже закэшировал вариант с деньгами — руководитель обязан получить свой, без них
    const manager = await get(managerToken);
    expect(manager.body.numbers.commissionMonth).toBeNull();
    expect(factsOf(1)).not.toMatch(/комисс/i);
    expect(callAiText).toHaveBeenCalledTimes(2);

    resetBriefingCache();
    callAiText.mockClear();
    await get(managerToken);
    const directorAfter = await get(directorToken);
    expect(directorAfter.body.numbers.commissionMonth).toEqual(expect.any(Number));
    expect(callAiText).toHaveBeenCalledTimes(2);
  });
});
