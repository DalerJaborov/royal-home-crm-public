import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { FUNCTION_REGISTRY, functionStatusResponseSchema } from "@royal-home/shared";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import {
  EVALUATED_FUNCTION_KEYS,
  cronHealth,
  evaluateFunctions,
  type FunctionStatusInput,
  type FunctionStatusSettings,
} from "../src/lib/functionStatus.js";

/**
 * «Состояние функций» (14.11.2026): реестр ↔ расчёт, ловушка «тумблер включён, а сервер не разрешает»,
 * значения переменных не утекают в ответ, права на маршрут.
 */

const NOW = new Date("2026-11-14T08:00:00.000Z");
const MIN = 60_000;

const SETTINGS: FunctionStatusSettings = {
  botPauseWatchEnabled: true,
  botPauseAlertHours: 24,
  botPauseEscalateHours: 72,
  botCanSendPhotos: true,
  botPhotosPerOffer: 6,
  botCanSendVoiceReplies: false,
  botLeadOnlyMode: false,
  liveVoiceEnabled: true,
  liveVoiceInboundMode: "always",
  liveVoiceProvider: "elevenlabs",
  telegramPortalAlertsPaused: true,
  groundedSearchEnabled: false,
  narrationAutoGenerate: true,
  alarmHoursStart: "09:50",
  alarmHoursEnd: "14:45",
  geminiSpareKeyInSettings: false,
};

function input(over: Partial<FunctionStatusInput> = {}, settings: Partial<FunctionStatusSettings> = {}): FunctionStatusInput {
  return {
    now: NOW,
    env: process.env,
    settings: { ...SETTINGS, ...settings },
    spend: { dayUsed: 12.4, dayCap: 60, monthUsed: 40, monthCap: 250, held: null },
    heartbeats: [],
    errors: [],
    ...over,
  };
}

const item = (key: string, i: FunctionStatusInput = input()) => {
  const found = evaluateFunctions(i).items.find((x) => x.key === key);
  if (!found) throw new Error(`нет функции ${key}`);
  return found;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("реестр функций и расчёт состояния", () => {
  it("у каждой записи реестра есть расчёт и наоборот", () => {
    expect([...EVALUATED_FUNCTION_KEYS].sort()).toEqual(FUNCTION_REGISTRY.map((f) => f.key).sort());
    expect(new Set(FUNCTION_REGISTRY.map((f) => f.key)).size).toBe(FUNCTION_REGISTRY.length);
  });

  it("ответ проходит схему экрана", () => {
    expect(functionStatusResponseSchema.safeParse(evaluateFunctions(input())).success).toBe(true);
  });

  it("тумблер фото включён, а переменной нет — «выключено» с причиной и именем переменной (ловушка 14.11)", () => {
    vi.stubEnv("CUSTOMER_PROPERTY_MEDIA_EXECUTION_MODE", "");
    const photos = item("bot-photos");
    expect(photos.state).toBe("off");
    expect(photos.attention).toBe(true);
    expect(photos.reason).toContain("CUSTOMER_PROPERTY_MEDIA_EXECUTION_MODE");
    expect(photos.detail).toContain("не больше 5");
  });

  it("режимы PREVIEW и LIVE у фото и голоса бота", () => {
    vi.stubEnv("CUSTOMER_PROPERTY_MEDIA_EXECUTION_MODE", "PREVIEW");
    expect(item("bot-photos").state).toBe("preview");
    vi.stubEnv("CUSTOMER_PROPERTY_MEDIA_EXECUTION_MODE", "LIVE");
    expect(item("bot-photos").state).toBe("working");
    // тумблер выключен — выключено, что бы ни стояло в переменной
    expect(item("bot-photos", input({}, { botCanSendPhotos: false })).state).toBe("off");
    // режим «только заявки» перебивает тумблер
    const leadOnly = item("bot-photos", input({}, { botLeadOnlyMode: true }));
    expect(leadOnly.state).toBe("off");
    expect(leadOnly.reason).toContain("только заявки");
    vi.stubEnv("CUSTOMER_AGENT_MEDIA_EXECUTION_MODE", "LIVE");
    expect(item("bot-media", input({}, { botCanSendVoiceReplies: true })).state).toBe("working");
  });

  it("режим say: без live — только проверка", () => {
    expect(item("bot-say-mode", input({ env: {} })).state).toBe("preview");
    expect(item("bot-say-mode", input({ env: { CUSTOMER_AGENT_SAY_MODE: "live" } })).state).toBe("working");
  });

  it("сторож пауз бота: выключен тумблером — внимание", () => {
    const off = item("bot-pause-watch", input({}, { botPauseWatchEnabled: false }));
    expect(off.state).toBe("off");
    expect(off.attention).toBe(true);
    expect(item("bot-pause-watch").state).toBe("working");
  });

  it("озвучка: без CRM_NARRATION_EXECUTION_MODE — проверка; с ним, но без автоозвучки — выключено", () => {
    vi.stubEnv("CRM_NARRATION_EXECUTION_MODE", "");
    const waiting = item("narration");
    expect(waiting.state).toBe("preview");
    expect(waiting.reason).toContain("CRM_NARRATION_EXECUTION_MODE");
    vi.stubEnv("CRM_NARRATION_EXECUTION_MODE", "LIVE");
    expect(item("narration").state).toBe("working");
    expect(item("narration", input({}, { narrationAutoGenerate: false })).state).toBe("off");
  });

  it("контроль продавцов, проверка собственников, метаданные, ручные исправления: без переменных — не «работает»", () => {
    for (const name of [
      "SELLER_CONTROL_INTERNAL_LIVE",
      "SELLER_CONTROL_LIVE_FROM",
      "BUYER_CANDIDATE_INTERNAL_LIVE",
      "BUYER_CANDIDATE_LIVE_FROM",
      "CRM_OWNER_VERIFICATION_EXECUTION_MODE",
      "PUBLICATION_METADATA_EXECUTION",
      "MANUAL_DATA_CORRECTIONS_LIVE",
      "MARKET_CRAWL_ENABLED",
      "OBJECT_INTEREST_PULLS_QUEUE_LEAD",
      "GEMINI_API_KEY_2",
    ]) {
      vi.stubEnv(name, "");
    }
    const env = { ...process.env };
    const i = input({ env });
    expect(item("seller-control", i).state).toBe("preview");
    expect(item("buyer-candidates", i).state).toBe("preview");
    expect(item("owner-verification", i).state).toBe("preview");
    expect(item("publication-metadata", i).state).toBe("off");
    expect(item("manual-corrections", i).state).toBe("preview");
    expect(item("market-crawl", i).state).toBe("off");
    expect(item("object-interest-pull", i).state).toBe("off");
    expect(item("gemini-spare-key", i).state).toBe("off");
    expect(item("gemini-spare-key", input({ env }, { geminiSpareKeyInSettings: true })).state).toBe("working");

    vi.stubEnv("SELLER_CONTROL_INTERNAL_LIVE", "explicitly-approved");
    vi.stubEnv("SELLER_CONTROL_LIVE_FROM", "2026-11-15");
    vi.stubEnv("MARKET_CRAWL_ENABLED", "1");
    const live = input({ env: { ...process.env } });
    expect(item("seller-control", live).state).toBe("working");
    expect(item("market-crawl", live).state).toBe("working");
  });

  it("робот: тумблер, потолок минут", () => {
    expect(item("live-voice", input({}, { liveVoiceEnabled: false })).state).toBe("off");
    const ok = item("live-voice");
    expect(ok.state).toBe("working");
    expect(ok.detail).toContain("12.4 из 60");
    const held = item("live-voice", input({ spend: { dayUsed: 60, dayCap: 60, monthUsed: 100, monthCap: 250, held: "day" } }));
    expect(held.attention).toBe(true);
    expect(held.reason).toContain("автоответчик");
  });

  it("окно тревог руководству: узкое окно — внимание, круглые сутки — нет", () => {
    const narrow = item("director-alert-window");
    expect(narrow.attention).toBe(true);
    expect(narrow.reason).toContain("09:50");
    expect(item("director-alert-window", input({}, { alarmHoursStart: "08:00", alarmHoursEnd: "07:59" })).attention).toBe(false);
  });

  it("пауза Telegram по порталам и справочный поиск: честные причины", () => {
    expect(item("telegram-portal-pause").state).toBe("off");
    expect(item("telegram-portal-pause", input({}, { telegramPortalAlertsPaused: false })).state).toBe("working");
    expect(item("assistant-grounded-search", input({}, { groundedSearchEnabled: true })).attention).toBe(true);
  });

  it("значения переменных в ответ не попадают", () => {
    vi.stubEnv("CUSTOMER_AGENT_SAY_MODE", "sentinel-secret-value-1");
    vi.stubEnv("GEMINI_API_KEY_2", "sentinel-secret-value-2");
    vi.stubEnv("SELLER_CONTROL_LIVE_FROM", "sentinel-secret-value-3");
    const json = JSON.stringify(evaluateFunctions(input({ env: { ...process.env } })));
    expect(json).not.toContain("sentinel-secret-value");
  });

  it("фоновые задачи: ок, упала, давно не было, ни разу; сбой задачи функции — внимание", () => {
    const row = (over: Partial<FunctionStatusInput["heartbeats"][number]>) => ({
      name: "bot-pause-watch",
      expr: "20 * * * *",
      lastRunAt: new Date(NOW.getTime() - 10 * MIN),
      lastOkAt: new Date(NOW.getTime() - 10 * MIN),
      lastError: null,
      lastSkippedAt: null,
      ...over,
    });
    expect(cronHealth(row({}), NOW)).toBe("ok");
    expect(cronHealth(row({ lastRunAt: null, lastOkAt: null }), NOW)).toBe("never");
    expect(cronHealth(row({ lastOkAt: new Date(NOW.getTime() - 50 * MIN), lastError: "boom" }), NOW)).toBe("failing");
    const old = new Date(NOW.getTime() - 5 * 3600_000);
    expect(cronHealth(row({ lastRunAt: old, lastOkAt: old }), NOW)).toBe("stale");
    // еженедельная: прошла неделя с небольшим — ещё нормально
    const weekly = new Date(NOW.getTime() - 6 * 24 * 3600_000);
    expect(cronHealth(row({ expr: "30 2 * * 0", lastRunAt: weekly, lastOkAt: weekly }), NOW)).toBe("ok");

    const broken = item("bot-pause-watch", input({ heartbeats: [row({ lastRunAt: old, lastOkAt: old })] }));
    expect(broken.crons[0]?.health).toBe("stale");
    expect(broken.attention).toBe(true);
    const response = evaluateFunctions(input({ heartbeats: [row({}), row({ name: "unrelated-tick" })] }));
    expect(response.crons.map((c) => c.name)).toEqual(["bot-pause-watch", "unrelated-tick"]);
  });

  it("последняя ошибка берётся из источников функции, телефоны маскируются", () => {
    const errors = [
      { source: "storage", message: "чужая", createdAt: new Date(NOW.getTime() - MIN) },
      { source: "telephony", message: "Станция не приняла набор +992901234567", createdAt: new Date(NOW.getTime() - 5 * MIN) },
    ];
    const live = item("live-voice", input({ errors }));
    expect(live.lastError?.message).toContain("Станция не приняла набор");
    expect(live.lastError?.message).not.toContain("901234567");
    expect(item("bot-photos", input({ errors })).lastError).toBeNull();
  });
});

describe("GET /api/v1/function-status: права", () => {
  const runId = Date.now();
  const password = "testpass123";
  const ids: string[] = [];
  const tokens: Record<string, string> = {};

  async function mk(role: "DIRECTOR" | "ADMIN" | "MANAGER" | "AGENT", n: string) {
    const passwordHash = await bcrypt.hash(password, 10);
    const phone = `+99295${n}${runId}`;
    const a = await prisma.agent.create({ data: { fullName: `FnStatus ${role} ${runId}`, phone, role, passwordHash } });
    ids.push(a.id);
    const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
    expect(res.status).toBe(200);
    tokens[role] = res.body.accessToken as string;
  }

  beforeAll(async () => {
    await mk("DIRECTOR", "1");
    await mk("ADMIN", "2");
    await mk("MANAGER", "3");
    await mk("AGENT", "4");
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { id: { in: ids } } });
  });

  it("без входа — 401", async () => {
    expect((await request(app).get("/api/v1/function-status")).status).toBe(401);
  });

  it("менеджер и агент — 403", async () => {
    for (const role of ["MANAGER", "AGENT"]) {
      const res = await request(app).get("/api/v1/function-status").set("Authorization", `Bearer ${tokens[role]}`);
      expect(res.status).toBe(403);
    }
  });

  it("директор и администратор — 200, ответ по схеме, все функции реестра на месте", async () => {
    for (const role of ["DIRECTOR", "ADMIN"]) {
      const res = await request(app).get("/api/v1/function-status").set("Authorization", `Bearer ${tokens[role]}`);
      expect(res.status).toBe(200);
      const parsed = functionStatusResponseSchema.parse(res.body);
      expect(parsed.items.map((i) => i.key).sort()).toEqual(FUNCTION_REGISTRY.map((f) => f.key).sort());
      expect(parsed.summary.working + parsed.summary.preview + parsed.summary.off).toBe(parsed.items.length);
    }
  });
});
