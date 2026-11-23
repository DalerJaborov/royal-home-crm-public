import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";

/**
 * РЕВЬЮ #363 (22.11.2026): рубильник «Живые слова» выключен — озвучка строго как в main. Настоящий Postgres;
 * Telegram и пуши подменены, ElevenLabs не вызывается.
 *  1 — при ВЫКЛ правка соток дома не делает озвучку устаревшей (ни обход, ни автоозвучка не заводят новую версию);
 *      при ВКЛ — делает (сотки звучат в аудио);
 *  2 — укорачивание под длину ролика работает у дома, чья версия сделана до включения (в отпечатке нет участка).
 */
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage: vi.fn(async () => ({ message_id: 1 })), sendMessageWithButtons: vi.fn(async () => ({ message_id: 2 })), isTelegramEnabled: () => true,
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 0), sendPushToAgents: vi.fn(async () => 0),
}));

const { prisma } = await import("../src/db.js");
const { narrationFacts, narrationFactsCurrent, narrationHash } = await import("../src/lib/propertyNarration.js");
const { refreshNarrationDrafts, requestAutoNarration, requestShorterNarration, resetNarrationSweepCursorsForTests } = await import("../src/lib/narrationAutoFlow.js");
const { narrationConfigSchema, narrationDraftText } = await import("@royal-home/shared");

const runId = Date.now();
const tail = runId.toString().slice(-6);
const LONG = "В продаже {вид} в районе {район}. Площадь {площадь} метров. Светлый и тёплый дом для большой и дружной семьи: рядом школа, детский сад, "
  + "магазины, парк и остановка, тихая улица и добрые соседи. Во дворе есть место для машины и для детской площадки. Приезжайте посмотреть в любое удобное время. Цена {цена}.";
const BASE = { modelId: "eleven_v4", voices: [{ id: "voiceA", name: "А" }], autoGenerate: true,
  templates: [{ id: "ru-long", name: "Длинный", lang: "ru" as const, text: LONG }, { id: "ru-short", name: "Короткий", lang: "ru" as const, text: "Продаётся {вид}. Цена {цена}." }] };
let districtId: string, agentId: string;
const propertyIds: string[] = [];
let settingsBefore: unknown = null;

async function seedHouse(landAreaSotka: number | null = 5) {
  const p = await prisma.property.create({ data: { title: `Живые слова-${runId}`, type: "HOUSE", rooms: 5, areaSqm: 200, landAreaSotka, price: 900000, currency: "TJS", districtId,
    address: `Сино, ${propertyIds.length + 1}`, condition: "GOOD", status: "EDITING", assignedAgentId: agentId }, include: { district: true } });
  propertyIds.push(p.id);
  return p;
}
const setConfig = (config: object) => prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: config } });

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Живые слова-${runId}` } })).id;
  agentId = (await prisma.agent.create({ data: { fullName: "Агент Живые", phone: `+99293${tail}1`, role: "AGENT", passwordHash: await bcrypt.hash("testpass123", 4) } })).id;
  settingsBefore = (await prisma.settings.findUnique({ where: { id: "singleton" }, select: { propertyNarrationConfig: true } }))?.propertyNarrationConfig ?? null;
});
afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: (settingsBefore ?? {}) as object } }).catch(() => {});
  await prisma.propertyNarrationVersion.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("ревью #363: «Живые слова» выключены — озвучка как в main", () => {
  it("1: при ВЫКЛ правка соток не старит озвучку дома: обход и автоозвучка новой версии не заводят", async () => {
    const config = narrationConfigSchema.parse(BASE);
    await setConfig(config);
    const p = await seedHouse(5);
    const first = await requestAutoNarration({ propertyId: p.id, actorId: agentId, source: "AUTO", config, debounceMs: 0 });
    expect(first.status).toBe("QUEUED");
    const v = await prisma.propertyNarrationVersion.findFirstOrThrow({ where: { propertyId: p.id } });
    // Отпечаток — ровно как до 21.11: без участка.
    expect(v.factsHash).toBe(narrationHash(narrationFacts(p, false)));
    expect("landSotka" in (v.factsSnapshot as object)).toBe(false);
    const edited = await prisma.property.update({ where: { id: p.id }, data: { landAreaSotka: 6 }, include: { district: true } });
    expect(narrationFactsCurrent(v, edited)).toBe(true);
    resetNarrationSweepCursorsForTests();
    await refreshNarrationDrafts(config, new Date());
    expect((await requestAutoNarration({ propertyId: p.id, actorId: agentId, source: "AUTO", config, debounceMs: 0 })).status).toBe("UNCHANGED");
    expect(await prisma.propertyNarrationVersion.count({ where: { propertyId: p.id } })).toBe(1);
  });

  it("1б: при ВКЛ участок в отпечатке — правка соток даёт новую версию", async () => {
    const config = narrationConfigSchema.parse({ ...BASE, liveWords: true });
    await setConfig(config);
    const p = await seedHouse(5);
    expect((await requestAutoNarration({ propertyId: p.id, actorId: agentId, source: "AUTO", config, debounceMs: 0 })).status).toBe("QUEUED");
    const v = await prisma.propertyNarrationVersion.findFirstOrThrow({ where: { propertyId: p.id } });
    expect(v.factsHash).toBe(narrationHash(narrationFacts(p, true)));
    await prisma.propertyNarrationVersion.update({ where: { id: v.id }, data: { status: "READY", generateAfter: null } });
    const edited = await prisma.property.update({ where: { id: p.id }, data: { landAreaSotka: 6 }, include: { district: true } });
    expect(narrationFactsCurrent(v, edited)).toBe(false);
    expect((await requestAutoNarration({ propertyId: p.id, actorId: agentId, source: "AUTO", config, debounceMs: 0 })).status).toBe("QUEUED");
    expect(await prisma.propertyNarrationVersion.count({ where: { propertyId: p.id } })).toBe(2);
  });

  it("2: укорачивание под длину ролика работает у дома, чья версия сделана до включения «Живых слов» (без участка в отпечатке)", async () => {
    const config = narrationConfigSchema.parse({ ...BASE, liveWords: true });
    await setConfig(config);
    const p = await seedHouse(5);
    // Снимок и отпечаток версии до включения: без участка (явно, чтобы тест не зависел от самой narrationFacts).
    const { landSotka: _land, ...old } = narrationFacts(p, true);
    const script = narrationDraftText(config, narrationFacts(p, true), "ru-long", null).text;
    const v = await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 1, script, factsSnapshot: old, factsHash: narrationHash(old), voiceId: "voiceA",
      modelId: "eleven_v4", templateId: "ru-long", language: "ru", status: "READY", storageKey: `${p.id}/${randomUUID()}.mp3`, approvedAt: new Date(), approvedById: agentId,
      createdById: agentId, requestKey: randomUUID(), source: "AUTO" } });
    const shorter = await requestShorterNarration(p.id, v.id, 40, 12);
    expect(shorter).not.toBeNull();
    const created = await prisma.propertyNarrationVersion.findUniqueOrThrow({ where: { id: shorter!.versionId } });
    expect(created.templateId).toBe("ru-short");
    expect(created.shortenedFromId).toBe(v.id);
    // Отпечаток новой версии — по фактам, с которыми собран её текст (с участком), и она актуальна.
    expect(created.factsHash).toBe(narrationHash(narrationFacts(p, true)));
    expect(narrationFactsCurrent(created, p)).toBe(true);
  });
});
