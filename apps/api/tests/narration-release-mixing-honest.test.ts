import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

/**
 * «CRM НАКЛАДЫВАЕТ ОЗВУЧКУ» — ТОЛЬКО КОГДА ПРАВДА НАКЛАДЫВАЕТ (20.11.2026, разбор владельца по объекту №209).
 * Карточка показывала «Озвучка утверждена. CRM накладывает её на ролик, обычно пару минут» больше суток: ролик вышел,
 * наложенной CRM версии нет — значит «накладывает». А голос вклеил монтажёр по передаче, своей музыки для этой
 * версии нет, и обход перемикса объект не брал никогда. Теперь стадию MIXING ставит то же решение, что у обхода
 * (narrationRemixPending → remixWanted). Сеть не нужна: ничего не сводится и не публикуется.
 */
const { prisma } = await import("../src/db.js");
const { narrationReleaseView } = await import("../src/lib/narrationRelease.js");
const { narrationFacts, narrationHash } = await import("../src/lib/propertyNarration.js");

const runId = `${Date.now()}`.slice(-8);
let districtId = "";
let agentId = "";
const propertyIds: string[] = [];
const modeBefore = process.env.CRM_NARRATION_EXECUTION_MODE;
let configBefore: unknown = null;

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Наложение ${runId}` } })).id;
  agentId = (await prisma.agent.create({ data: { fullName: `Агент наложения ${runId}`, phone: `+992937${runId.slice(-6)}`, role: "AGENT", passwordHash: "x" } })).id;
  const s = await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {}, select: { propertyNarrationConfig: true } });
  configBefore = s.propertyNarrationConfig;
  // Своя музыка выключена: путь «CRM сама» — только ролик без голоса от монтажёра (мастер).
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: { modelId: "eleven_v4", voices: [{ id: "voiceA", name: "А" }], autoGenerate: true } } });
  process.env.CRM_NARRATION_EXECUTION_MODE = "LIVE";
});
afterAll(async () => {
  process.env.CRM_NARRATION_EXECUTION_MODE = modeBefore;
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: (configBefore ?? {}) as object } });
  await prisma.propertyNarrationDelivery.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyNarrationVersion.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

/** Вышедший ролик (RECEIVED, пост в Instagram) и утверждённая озвучка с актуальными цифрами. */
async function publishedWithApprovedVoice(extra: Record<string, unknown> = {}) {
  const created = await prisma.property.create({ data: { title: `Наложение ${runId}-${propertyIds.length}`, type: "APARTMENT", rooms: 2, areaSqm: 58, floor: 5, price: 450000, currency: "TJS",
    districtId, address: "Тестовая, 1", condition: "GOOD", status: "AVAILABLE", intakeAgentId: agentId, publishedChannels: ["INSTAGRAM"], videoHandoffStatus: "RECEIVED",
    videoHandoffFinalPath: `final-${runId}-${propertyIds.length}.mp4`, ...extra } as never });
  propertyIds.push(created.id);
  const p = await prisma.property.findUniqueOrThrow({ where: { id: created.id }, include: { district: true } });
  const facts = narrationFacts(p);
  const v = await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 1, script: "Квартира, звоните.", factsSnapshot: facts, factsHash: narrationHash(facts),
    voiceId: "voiceA", modelId: "eleven_v4", status: "READY", storageKey: `${p.id}/v.mp3`, createdById: agentId, requestKey: randomUUID(), source: "WIZARD",
    approvedAt: new Date(Date.now() - 26 * 3_600_000), approvedById: agentId } });
  return { p, v };
}

describe("стадия «накладывает» в карточке", () => {
  it("№209: голос вклеил монтажёр (передача SENT), мастера без голоса нет — «накладывает» не показывается", async () => {
    const { p, v } = await publishedWithApprovedVoice();
    await prisma.propertyNarrationDelivery.create({ data: { propertyId: p.id, versionId: v.id, editorId: agentId, mode: "AUDIO_ONLY", status: "SENT", requestKey: randomUUID(), createdById: agentId, executionMode: "LIVE" } });
    expect(await narrationReleaseView(p, v)).toBeNull();
  });
  it("мастер без голоса от монтажёра есть — CRM правда наложит: «накладывает»", async () => {
    const { p, v } = await publishedWithApprovedVoice({ videoMasterStorageKey: `master-${runId}.mp4`, videoMasterSource: "EDITOR" });
    expect((await narrationReleaseView(p, v))?.stage).toBe("MIXING");
  });
  it("отправка не LIVE — обход ничего не сводит, «накладывает» не показывается", async () => {
    const { p, v } = await publishedWithApprovedVoice({ videoMasterStorageKey: `master2-${runId}.mp4`, videoMasterSource: "EDITOR" });
    process.env.CRM_NARRATION_EXECUTION_MODE = "PREVIEW";
    try { expect(await narrationReleaseView(p, v)).toBeNull(); }
    finally { process.env.CRM_NARRATION_EXECUTION_MODE = "LIVE"; }
  });
  it("наложение этой версии упало — не «накладывает» (карточка показывает «не легла на ролик»)", async () => {
    const { p, v } = await publishedWithApprovedVoice({ videoMasterStorageKey: `master3-${runId}.mp4`, videoMasterSource: "EDITOR" });
    await prisma.property.update({ where: { id: p.id }, data: { videoMasterMixErrorVersionId: v.id, videoMasterMixError: "ffmpeg упал" } });
    const fresh = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(await narrationReleaseView(fresh, v)).toBeNull();
  });
});
