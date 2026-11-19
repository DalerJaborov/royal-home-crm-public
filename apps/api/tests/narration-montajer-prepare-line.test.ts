import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

/**
 * СТРОКА МОНТАЖЁРУ «ОЗВУЧКА ГОТОВИТСЯ» ТОЛЬКО ЕСЛИ CRM ДЕЙСТВИТЕЛЬНО ЕЁ ПОДГОТОВИТ (20.11.2026). Живой случай 19.11: объект,
 * заведённый 04.11, ушёл на перемонтаж — монтажёру написали «Озвучка готовится», а озвучки нет и не будет («А почему не пришло
 * озвучка?», владелец). Условия «CRM готовит» — одно место, lib/narrationPlan.ts; здесь строка сверяется с НАСТОЯЩИМ обходом
 * озвучки (refreshNarrationDrafts и backfillMontageQueue на настоящей базе): строка говорит «готовится» тогда и только тогда,
 * когда обход завёл объекту версию. ElevenLabs не вызывается вовсе (до генерации обход здесь не доходит).
 */
process.env.ELEVENLABS_API_KEY = "test-key-not-real";
const { prisma } = await import("../src/db.js");
const { narrationLineForMontajer } = await import("../src/lib/narrationMontajerNote.js");
const { refreshNarrationDrafts, backfillMontageQueue } = await import("../src/lib/narrationAutoFlow.js");
const { crmWillPrepareFirstNarration, narrationPlannerOpen } = await import("../src/lib/narrationPlan.js");
const { loadNarrationConfiguration } = await import("../src/lib/narrationGeneration.js");

const runId = Date.now();
const DAY = 86_400_000;
const TEMPLATE = { id: "ru-line-1", name: "Тест", lang: "ru" as const, text: "В продаже {вид}. Площадь {площадь} метров. Цена {цена}." };
const CONFIG = { modelId: "eleven_v4", voices: [{ id: "voiceA", name: "А", gender: "female" as const }], templates: [TEMPLATE], autoGenerate: true };
const PREPARES = "Озвучка готовится";
const modeBefore = process.env.CRM_NARRATION_EXECUTION_MODE;
let districtId: string, agentId: string;
let configBefore: unknown = null;
const ids: string[] = [];

async function seed(data: Record<string, unknown> = {}) {
  const p = await prisma.property.create({ data: { title: `Строка монтажёру-${runId}`, type: "APARTMENT", areaSqm: 64, price: 61000, currency: "USD", districtId,
    address: `Сино, ${ids.length + 1}`, condition: "GOOD", status: "EDITING", assignedAgentId: agentId, ...data }, include: { district: true } });
  ids.push(p.id);
  return p;
}
async function setConfig(extra: Record<string, unknown> = {}) {
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: { ...CONFIG, ...extra } as object } });
}
/** Строка до обхода, потом настоящий обход (пока не обработает всех кандидатов базы), потом: завёл ли он версию. */
async function lineVersusPlanner(propertyIds: string[], backfill: boolean) {
  const before = new Map<string, string | null>();
  for (const id of propertyIds) before.set(id, await narrationLineForMontajer(id));
  const { config } = await loadNarrationConfiguration();
  for (let pass = 0; pass < 6; pass++) {
    if (backfill) await backfillMontageQueue(config, new Date());
    await refreshNarrationDrafts(config, new Date());
  }
  const result = new Map<string, { says: boolean; planned: boolean }>();
  for (const id of propertyIds) result.set(id, { says: !!before.get(id)?.includes(PREPARES), planned: (await prisma.propertyNarrationVersion.count({ where: { propertyId: id } })) > 0 });
  return result;
}

beforeAll(async () => {
  process.env.CRM_NARRATION_EXECUTION_MODE = "LIVE";
  districtId = (await prisma.district.create({ data: { name: `Строка монтажёру-${runId}` } })).id;
  agentId = (await prisma.agent.create({ data: { fullName: "Агент Строки", phone: `+99293${String(runId).slice(-6)}1`, role: "AGENT", passwordHash: "x" } })).id;
  configBefore = (await prisma.settings.findUnique({ where: { id: "singleton" }, select: { propertyNarrationConfig: true } }))?.propertyNarrationConfig ?? null;
  await setConfig();
});
afterAll(async () => {
  process.env.CRM_NARRATION_EXECUTION_MODE = modeBefore;
  await prisma.settings.update({ where: { id: "singleton" }, data: { propertyNarrationConfig: (configBefore ?? {}) as object } }).catch(() => {});
  await prisma.propertyNarrationVersion.deleteMany({ where: { propertyId: { in: ids } } });
  await prisma.property.deleteMany({ where: { id: { in: ids } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("строка «Озвучка готовится» сверена с обходом озвучки", () => {
  it("проход по очереди монтажа ВЫКЛЮЧЕН: давний объект в очереди (случай 19.11) не получает «готовится», новый — получает, и обход ровно то же", async () => {
    await setConfig();
    const oldQueued = await seed({ createdAt: new Date(Date.now() - 16 * DAY), videoHandoffStatus: "QUEUED" });
    const oldAtEditor = await seed({ createdAt: new Date(Date.now() - 16 * DAY), videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() });
    const freshWizard = await seed({ createdInCrmWizard: true });
    const freshQueued = await seed({ videoHandoffStatus: "QUEUED" });
    const freshSite = await seed({});
    const freshSold = await seed({ createdInCrmWizard: true, status: "SOLD" });
    const all = [oldQueued, oldAtEditor, freshWizard, freshQueued, freshSite, freshSold].map((p) => p.id);
    const r = await lineVersusPlanner(all, false);
    expect(r.get(oldQueued.id)).toEqual({ says: false, planned: false });
    expect(r.get(oldAtEditor.id)).toEqual({ says: false, planned: false });
    expect(r.get(freshWizard.id)).toEqual({ says: true, planned: true });
    expect(r.get(freshQueued.id)).toEqual({ says: true, planned: true });
    expect(r.get(freshSite.id)).toEqual({ says: false, planned: false });
    expect(r.get(freshSold.id)).toEqual({ says: false, planned: false });
    // Главное: строка и обход всегда согласны (одно условие на двоих).
    for (const [, v] of r) expect(v.says).toBe(v.planned);
  });
  it("проход по очереди монтажа ВКЛЮЧЁН: давние объекты в очереди получают и строку, и озвучку; без очереди или с ручной сдачей — ни того ни другого", async () => {
    await setConfig({ backfillMontageQueue: true });
    const oldQueued = await seed({ createdAt: new Date(Date.now() - 16 * DAY), videoHandoffStatus: "QUEUED" });
    const oldAtEditor = await seed({ createdAt: new Date(Date.now() - 16 * DAY), videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() });
    const oldNoQueue = await seed({ createdAt: new Date(Date.now() - 16 * DAY) });
    const oldManual = await seed({ createdAt: new Date(Date.now() - 16 * DAY), videoHandoffStatus: "QUEUED", videoHandoffManualSince: new Date() });
    const r = await lineVersusPlanner([oldQueued.id, oldAtEditor.id, oldNoQueue.id, oldManual.id], true);
    expect(r.get(oldQueued.id)).toEqual({ says: true, planned: true });
    expect(r.get(oldAtEditor.id)).toEqual({ says: true, planned: true });
    expect(r.get(oldNoQueue.id)).toEqual({ says: false, planned: false });
    expect(r.get(oldManual.id)).toEqual({ says: false, planned: false });
    for (const [, v] of r) expect(v.says).toBe(v.planned);
  });
  it("обход закрыт — «готовится» не пишем: автоозвучка выключена, нет ключа, отправка не LIVE; «Без озвучки» остаётся прежней строкой", async () => {
    const wizard = await seed({ createdInCrmWizard: true });
    await setConfig({ autoGenerate: false });
    expect(await narrationLineForMontajer(wizard.id)).toBeNull();
    await setConfig();
    expect(await narrationLineForMontajer(wizard.id)).toContain(PREPARES);
    process.env.CRM_NARRATION_EXECUTION_MODE = "PREVIEW";
    try { expect(await narrationLineForMontajer(wizard.id)).toBeNull(); } finally { process.env.CRM_NARRATION_EXECUTION_MODE = "LIVE"; }
    const { config } = await loadNarrationConfiguration();
    expect(narrationPlannerOpen(config, null)).toBe(false);
    expect(await crmWillPrepareFirstNarration(wizard.id, config, null)).toBe(false);
    expect(await crmWillPrepareFirstNarration(wizard.id, config, "k")).toBe(true);
    const off = await seed({ createdInCrmWizard: true, narrationOff: true });
    expect(await narrationLineForMontajer(off.id)).toContain("Без озвучки");
  });
  it("у объекта уже есть версия — прежние строки, предикат не вмешивается", async () => {
    const p = await seed({ createdInCrmWizard: true });
    await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 1, script: "Текст.", factsSnapshot: {}, factsHash: "x", status: "DRAFT", createdById: agentId, requestKey: randomUUID(), source: "AUTO" } });
    expect(await narrationLineForMontajer(p.id)).toContain("ждёт одобрения");
  });
});
