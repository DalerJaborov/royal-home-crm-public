import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
/**
 * Карта обращений в тестах «пусто/густо» — подменённая, а не из общей базы
 * (24.09.2026): после нескольких полных прогонов в тестовой базе копилось 299
 * обращений за 90 дней, больше порога HEATMAP_MIN_EVENTS, и тест «на пустой
 * базе» краснел у соседей, хотя код не менялся. По умолчанию вызов уходит в
 * настоящую функцию; тест, которому важен объём, кладёт свои клетки в
 * `heatmapOverride` и сам его убирает.
 */
// Источник часов, постоянные окна, глубина карты и опережение — константы с
// 01.11.2026 (lib/settingsConstants.ts). Тест подменяет их здесь; в базе остались
// только рубильник, рабочее окно и промежуток.
const PROD_TUNING = { priorityWindows: [720, 840, 1140, 1260], heatmapDays: 90, leadHours: 1, useHeatmap: false, useInstagramOnline: false };
const tuning = vi.hoisted(() => ({
  priorityWindows: [720, 840, 1140, 1260] as number[], heatmapDays: 90, leadHours: 1, useHeatmap: false, useInstagramOnline: false,
}));
vi.mock("../src/lib/settingsConstants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/settingsConstants.js")>()),
  PUBLISH_SCHEDULE_TUNING: tuning,
}));
const heatmapOverride = vi.hoisted(() => ({ cells: null as null | { dow: number; hour: number; count: number }[] }));
vi.mock("../src/lib/audienceHeatmap.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/audienceHeatmap.js")>();
  return {
    ...orig,
    loadHeatmapCells: (params: Parameters<typeof orig.loadHeatmapCells>[0]) =>
      heatmapOverride.cells && params.signal === "all" ? Promise.resolve(heatmapOverride.cells) : orig.loadHeatmapCells(params),
  };
});

import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { loadPublishScheduleRules } from "../src/lib/publishScheduleRules.js";
import { DEFAULT_PUBLISH_SCHEDULE_RULES, HEATMAP_MIN_EVENTS } from "../src/lib/publishSchedule.js";

/**
 * ПРАВИЛА РАСПИСАНИЯ ИЗ НАСТРОЕК И РАЗДЕЛ «РАСПИСАНИЕ» (23.09.2026, владелец:
 * «все это должно быть в настройках… чтобы я видел время выхода, объекты,
 * почему именно, какие площадки»).
 *
 * Сама арифметика слотов проверяется без базы в publish-schedule.test.ts.
 * Здесь — то, что без базы не проверить: как поля `Settings.publishSchedule*`
 * превращаются в правила (lib/publishScheduleRules.ts) и что показывает
 * GET /marketing/publish-schedule.
 *
 * НАСТРОЙКИ — ОДНА СТРОКА НА ВСЮ БАЗУ, и тесты идут в два процесса. Поэтому
 * тронутые поля сохраняются в beforeAll и возвращаются в afterAll, как в
 * settings-lead-rules.test.ts: иначе сосед по прогону увидел бы чужую сетку.
 */
const runId = Date.now();
const password = "testpass123";
const TOUCHED = [
  "publishScheduleEnabled",
  "publishScheduleWindowStartMin",
  "publishScheduleWindowEndMin",
  "publishScheduleMinGapMin",
] as const;

let districtId: string;
let marketingToken: string;
let agentToken: string;
let adminToken: string;
let saved: Record<string, unknown>;
const propertyIds: string[] = [];
const agentIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

const TUNING_KEYS: Record<string, keyof typeof tuning> = {
  publishScheduleUseHeatmap: "useHeatmap",
  publishScheduleUseInstagramOnline: "useInstagramOnline",
  publishSchedulePriorityWindows: "priorityWindows",
  publishScheduleHeatmapDays: "heatmapDays",
  publishScheduleLeadHours: "leadHours",
};

/** Поля, ставшие константами, уходят в подмену; остальные — в строку Settings. */
async function setSchedule(data: Record<string, unknown>) {
  const dbData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const tuningKey = TUNING_KEYS[key];
    if (tuningKey) (tuning as Record<string, unknown>)[tuningKey] = value;
    else dbData[key] = value;
  }
  if (Object.keys(dbData).length > 0) await prisma.settings.update({ where: { id: "singleton" }, data: dbData });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-расписание-${runId}` } })).id;

  const marketing = await prisma.agent.create({
    data: { fullName: `Маркетинг расписания ${runId}`, phone: `+992961${runId}`, role: "MARKETING", passwordHash },
  });
  const plain = await prisma.agent.create({
    data: { fullName: `Агент расписания ${runId}`, phone: `+992962${runId}`, role: "AGENT", passwordHash },
  });
  const admin = await prisma.agent.create({
    data: { fullName: `Админ расписания ${runId}`, phone: `+992963${runId}`, role: "ADMIN", passwordHash },
  });
  agentIds.push(marketing.id, plain.id, admin.id);
  marketingToken = await login(`+992961${runId}`);
  agentToken = await login(`+992962${runId}`);
  adminToken = await login(`+992963${runId}`);
  grantElevation(admin.id);

  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  saved = Object.fromEntries(TOUCHED.map((k) => [k, (current as Record<string, unknown>)[k]]));
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Правила расписания из настроек", () => {
  it("постоянные окна из настроек становятся приоритетными часами", async () => {
    await setSchedule({
      publishScheduleEnabled: true,
      publishScheduleUseHeatmap: false,
      publishScheduleWindowStartMin: 10 * 60,
      publishScheduleWindowEndMin: 20 * 60,
      publishScheduleMinGapMin: 45,
      publishSchedulePriorityWindows: [16 * 60, 17 * 60],
    });
    const loaded = await loadPublishScheduleRules();
    expect(loaded.rules.enabled).toBe(true);
    expect(loaded.rules.windowStartMin).toBe(10 * 60);
    expect(loaded.rules.windowEndMin).toBe(20 * 60);
    expect(loaded.rules.minGapMin).toBe(45);
    expect(loaded.rules.prioritySource).toBe("fixed");
    expect(loaded.rules.priorityWindows).toEqual([[16 * 60, 17 * 60]]);
    expect(loaded.priorityHours).toEqual([16]);
  });

  it("выключенное расписание доезжает до правил, а не теряется по дороге", async () => {
    await setSchedule({ publishScheduleEnabled: false, publishScheduleUseHeatmap: false });
    expect((await loadPublishScheduleRules()).rules.enabled).toBe(false);
  });

  it("пустой список постоянных окон не оставляет расстановку без часов", async () => {
    // Пустой список — это «часы не заданы», а не «часов нет». Без запасных окон
    // первая публикация пачки перестала бы метить в пик вообще.
    await setSchedule({ publishScheduleEnabled: true, publishScheduleUseHeatmap: false, publishSchedulePriorityWindows: [] });
    const loaded = await loadPublishScheduleRules();
    expect(loaded.rules.priorityWindows).toEqual(DEFAULT_PUBLISH_SCHEDULE_RULES.priorityWindows);
  });

  it("нечётный хвост в списке окон отбрасывается, а не валит расстановку", async () => {
    await setSchedule({
      publishScheduleEnabled: true,
      publishScheduleUseHeatmap: false,
      publishSchedulePriorityWindows: [11 * 60, 12 * 60, 15 * 60],
    });
    const loaded = await loadPublishScheduleRules();
    expect(loaded.rules.priorityWindows).toEqual([[11 * 60, 12 * 60]]);
  });

  it("включённая тепловая карта на пустой базе честно падает на постоянные окна", async () => {
    // Обращений меньше порога — расстановка обязана сказать об этом
    // источником "fixed", а не выдать шум за час пик. Объём задаёт сам тест,
    // а не то, что накопили в общей базе соседние файлы.
    await setSchedule({
      publishScheduleEnabled: true,
      publishScheduleUseHeatmap: true,
      // Статистику Instagram соседний файл (instagram-online-followers.test.ts)
      // кладёт в ту же базу — здесь проверяется только карта обращений.
      publishScheduleUseInstagramOnline: false,
      publishSchedulePriorityWindows: [13 * 60, 14 * 60],
    });
    heatmapOverride.cells = [{ dow: 1, hour: 19, count: HEATMAP_MIN_EVENTS - 1 }];
    try {
      const loaded = await loadPublishScheduleRules();
      expect(loaded.rules.prioritySource).toBe("fixed");
      expect(loaded.priorityHours).toEqual([13]);
    } finally {
      heatmapOverride.cells = null;
    }
  });

  it("обращений не меньше порога — окна берутся с карты, за час до пика", async () => {
    await setSchedule({
      publishScheduleEnabled: true,
      publishScheduleUseHeatmap: true,
      publishScheduleUseInstagramOnline: false,
      publishScheduleLeadHours: 1,
      publishSchedulePriorityWindows: [13 * 60, 14 * 60],
    });
    heatmapOverride.cells = [{ dow: 1, hour: 19, count: HEATMAP_MIN_EVENTS }];
    try {
      const loaded = await loadPublishScheduleRules();
      expect(loaded.rules.prioritySource).toBe("heatmap");
      expect(loaded.priorityHours).toEqual([18]);
      expect(loaded.heatmapEvents).toBe(HEATMAP_MIN_EVENTS);
    } finally {
      heatmapOverride.cells = null;
    }
  });
});

/**
 * СОВЕТ ПОД КАРТОЙ = НАСТОЯЩЕЕ РАСПИСАНИЕ (23.09.2026). До этой правки
 * GET /dashboard/heatmap считал всегда за 90 дней и «за час до всплеска», а
 * расстановка роликов — по Настройкам. Поменял владелец «за сколько дней» или
 * «за сколько часов» — и совет на /sources молча расходился с часами выхода.
 */
describe("GET /dashboard/heatmap — окно и запас из тех же Настроек", () => {
  it("отдаёт дни и запас из Настроек, а не свои постоянные", async () => {
    await setSchedule({ publishScheduleHeatmapDays: 30, publishScheduleLeadHours: 2 });
    const res = await request(app)
      .get("/api/v1/dashboard/heatmap")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(30);
    expect(res.body.leadHours).toBe(2);
    const loaded = await loadPublishScheduleRules();
    expect(loaded.heatmapDays).toBe(res.body.days);
  });
});

describe("GET /marketing/publish-schedule", () => {
  it("показывает сетку, площадки и очередь роликов с причиной каждого часа", async () => {
    await setSchedule({
      publishScheduleEnabled: true,
      publishScheduleUseHeatmap: false,
      publishScheduleWindowStartMin: 9 * 60,
      publishScheduleWindowEndMin: 21 * 60,
      publishScheduleMinGapMin: 90,
      publishSchedulePriorityWindows: [12 * 60, 14 * 60],
    });

    const waiting = await prisma.property.create({
      data: {
        title: `Ждёт слота ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая расписания, 1",
        condition: "GOOD",
        status: "AVAILABLE",
        videoHandoffStatus: "RECEIVED",
        scheduledPublishAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
        scheduledPublishReason: "Ближайший приоритетный час из настроек — 12:00.",
      },
    });
    const published = await prisma.property.create({
      data: {
        title: `Уже вышел ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая расписания, 2",
        condition: "GOOD",
        status: "AVAILABLE",
        videoHandoffStatus: "RECEIVED",
        publishedChannels: ["TELEGRAM"],
        scheduledPublishAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    const overdue = await prisma.property.create({
      data: {
        title: `Час прошёл ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая расписания, 3",
        condition: "GOOD",
        status: "AVAILABLE",
        videoHandoffStatus: "RECEIVED",
        scheduledPublishAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        scheduledPublishReason: "Очередь: 90 минут после предыдущей публикации.",
      },
    });
    propertyIds.push(waiting.id, published.id, overdue.id);

    const res = await request(app)
      .get("/api/v1/marketing/publish-schedule")
      .set("Authorization", `Bearer ${marketingToken}`);
    expect(res.status).toBe(200);
    expect(res.body.schedule.enabled).toBe(true);
    expect(res.body.schedule.windowStartMin).toBe(9 * 60);
    expect(res.body.schedule.prioritySource).toBe("fixed");
    expect(res.body.schedule.priorityHours).toEqual([12]);

    const ids = res.body.upcoming.map((u: { propertyId: string }) => u.propertyId);
    expect(ids).toContain(waiting.id);
    // Уже опубликованный ролик в очереди не висит — иначе раздел показывал бы
    // работу, которой нет.
    expect(ids).not.toContain(published.id);

    const row = res.body.upcoming.find((u: { propertyId: string }) => u.propertyId === waiting.id);
    expect(row.reason).toBe("Ближайший приоритетный час из настроек — 12:00.");
    expect(row.overdue).toBe(false);
    expect(Array.isArray(row.channels)).toBe(true);

    // Слот прошёл, а ролик всё ещё ждёт — это застрявшая публикация, и раздел
    // обязан отличать её от обычной очереди.
    const late = res.body.upcoming.find((u: { propertyId: string }) => u.propertyId === overdue.id);
    expect(late.overdue).toBe(true);
  });

  it("обычному агенту раздел не отдаётся", async () => {
    const res = await request(app)
      .get("/api/v1/marketing/publish-schedule")
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
  });
});

/**
 * ГРАНИЦЫ СЕТКИ ПРОВЕРЯЮТСЯ НА СЕРВЕРЕ, А НЕ ТОЛЬКО В ФОРМЕ. Окно «с 21:00 до
 * 09:00» и перевёрнутая пара часов выглядят как опечатка, а ведут себя как
 * поломка: в первом случае каждый ролик переносится на завтра по кругу, во
 * втором пара молча отбрасывается загрузчиком правил — владелец видит
 * «сохранено» на настройке, которая ни на что не влияет.
 *
 * Отдельно проверяется случай «пришло одно поле из пары»: форма шлёт только
 * изменённое, и в самой схеме разницы не видно — сверка идёт с тем, что уже в
 * базе (тот же приём, что у паузы бота и окна напоминаний).
 */
describe("PATCH /settings — границы сетки публикаций", () => {
  const patch = (body: Record<string, unknown>) =>
    request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${adminToken}`).send(body);

  it("конец окна раньше начала не сохраняется", async () => {
    const res = await patch({ publishScheduleWindowStartMin: 21 * 60, publishScheduleWindowEndMin: 9 * 60 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/окна публикаций/i);
  });

  it("одно поле пары сверяется с тем, что уже в базе", async () => {
    await setSchedule({ publishScheduleWindowStartMin: 9 * 60, publishScheduleWindowEndMin: 21 * 60 });
    // Начало 22:00 при сохранённом конце 21:00 — пришло одно число, а сломана пара.
    const res = await patch({ publishScheduleWindowStartMin: 22 * 60 });
    expect(res.status).toBe(400);
    const fresh = await prisma.settings.findUnique({ where: { id: "singleton" } });
    expect(fresh?.publishScheduleWindowStartMin).toBe(9 * 60);
  });

  it("постоянные часы, глубина карты и опережение больше не правятся через PATCH (константы с 01.11.2026)", async () => {
    Object.assign(tuning, PROD_TUNING);
    const res = await patch({ publishSchedulePriorityWindows: [16 * 60, 17 * 60], publishScheduleHeatmapDays: 30, publishScheduleLeadHours: 3 });
    expect(res.status).toBe(200);
    const loaded = await loadPublishScheduleRules();
    expect(loaded.priorityHours).toEqual([12, 19]);
    expect(loaded.heatmapDays).toBe(90);
  });

  it("исправная сетка сохраняется целиком", async () => {
    const res = await patch({
      publishScheduleEnabled: true,
      publishScheduleWindowStartMin: 8 * 60,
      publishScheduleWindowEndMin: 22 * 60,
      publishScheduleMinGapMin: 60,
    });
    expect(res.status).toBe(200);
    Object.assign(tuning, PROD_TUNING);
    const loaded = await loadPublishScheduleRules();
    expect(loaded.rules.windowStartMin).toBe(8 * 60);
    expect(loaded.rules.minGapMin).toBe(60);
    expect(loaded.priorityHours).toEqual([12, 19]);
    expect(loaded.heatmapDays).toBe(90);
  });
});
