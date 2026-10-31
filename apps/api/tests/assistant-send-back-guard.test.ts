import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

/**
 * ВОЗВРАТ МОНТАЖЁРУ ОТ ИМЕНИ ПОМОЩНИКА НА НАСТОЯЩЕЙ ФУНКЦИИ (П3 «prop», 31.10.2026):
 * lib/propertySendBack.ts → lib/publishedVideoFix.ts::sendBackToMontajer.
 *
 * Здесь `sendBackToMontajer` НЕ подменён (в ai-assistant-property-tools.test.ts он
 * подменён) — проверяются два новых условия функции:
 *  - `guard`: счётчик возвратов тот же, что видел человек в превью, иначе stale и
 *    ни одной записи (двойной «Подтвердить» / возврат из другого места между
 *    превью и исполнением не даёт второго задания монтажёру);
 *  - `dryRun`: те же отказы, что у настоящей отправки, но без записи.
 * И что кнопка в карточке (REST) идёт через ту же обёртку с теми же правами.
 */

const { sendMessage, sendDocumentFile, sendPushToAgent } = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => {}),
  sendDocumentFile: vi.fn(async () => {}),
  sendPushToAgent: vi.fn(async () => {}),
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
  sendDocumentFile,
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));

const { prisma } = await import("../src/db.js");
const { sendPropertyBackToMontajerAs, sendBackDenied } = await import("../src/lib/propertySendBack.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { cleanupAssistantActionAgents } = await import("./helpers/assistantActionFixture.js");
const { waitForSettled } = await import("./helpers/waitFor.js");

const runId = Date.now();
let districtId = "";
let ownerId = "";
let montajerId = "";
let directorId = "";
const propertyIds: string[] = [];
let settingsBefore: { videoHandoffEnabled: boolean; videoMontajerAgentId: string | null } | null = null;

const can = (perms: string[]) => (p: string) => perms.includes(p);
const director = () => ({ agentId: directorId, role: "DIRECTOR", can: can(["properties.editForeign"]) as never });

async function seed(overrides: Record<string, unknown> = {}, withVideo = true) {
  const property = await prisma.property.create({
    data: {
      title: `Возврат помощника ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 50,
      price: 400000,
      currency: "TJS",
      districtId,
      address: "Возвратная, 1",
      condition: "GOOD",
      status: "AVAILABLE",
      createdById: ownerId,
      assignedAgentId: ownerId,
      videoHandoffFinalPath: "/uploads/video-handoff/test-final.mp4",
      ...overrides,
    } as never,
  });
  propertyIds.push(property.id);
  if (withVideo) {
    await prisma.propertyVideo.create({
      data: { propertyId: property.id, storageKey: `${property.id}/${randomUUID()}.mp4`, filename: "obhod.mp4", sizeBytes: 1024, uploadedById: ownerId },
    });
  }
  return property;
}

const writes = (propertyId: string) => prisma.videoRemakeRequest.count({ where: { propertyId } });

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Возврат помощника ${runId}` } })).id;
  ownerId = await createTestAgent(`Владелец возврата ${runId}`);
  directorId = await createTestAgent(`Директор возврата ${runId}`, "DIRECTOR");
  montajerId = await createTestAgent(`Монтажёр возврата ${runId}`);
  const current = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoHandoffEnabled: true, videoMontajerAgentId: true } });
  settingsBefore = current;
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { videoHandoffEnabled: true, videoMontajerAgentId: montajerId },
    create: { id: "singleton", videoHandoffEnabled: true, videoMontajerAgentId: montajerId },
  });
});

beforeEach(() => {
  sendMessage.mockClear();
  sendDocumentFile.mockClear();
});

afterAll(async () => {
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await prisma.montajerMessage.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.videoRemakeRequest.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyVideo.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  const agents = [ownerId, directorId, montajerId];
  await waitForSettled(() => prisma.auditLog.count({ where: { agentId: { in: agents } } }));
  await prisma.auditLog.deleteMany({ where: { agentId: { in: agents } } });
  await cleanupAssistantActionAgents(agents);
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("guard: счётчик возвратов", () => {
  it("совпал — возврат идёт, счётчик растёт; тот же guard второй раз — stale, второго задания нет", async () => {
    const property = await seed({ videoRemakeCount: 2 });
    const body = { reason: "NO_MUSIC" as const };
    const first = await sendPropertyBackToMontajerAs({ propertyId: property.id, actor: director(), body, source: "crm", guard: { videoRemakeCount: 2 } });
    expect(first.ok).toBe(true);
    expect(await writes(property.id)).toBe(1);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).videoRemakeCount).toBe(3);

    // Объект «вернулся к монтажёру и обратно» — место свободно, но счётчик уже другой.
    await prisma.property.update({ where: { id: property.id }, data: { videoHandoffStatus: "NONE" } });
    const second = await sendPropertyBackToMontajerAs({ propertyId: property.id, actor: director(), body, source: "crm", guard: { videoRemakeCount: 2 } });
    expect(second).toMatchObject({ ok: false, status: 409, stale: true });
    expect(await writes(property.id)).toBe(1);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).videoRemakeCount).toBe(3);
  });

  it("без guard (кнопка в карточке) поведение прежнее", async () => {
    const property = await seed({ videoRemakeCount: 5 });
    const result = await sendPropertyBackToMontajerAs({ propertyId: property.id, actor: director(), body: { reason: "POOR_EDIT" }, source: "crm" });
    expect(result.ok).toBe(true);
    expect(await writes(property.id)).toBe(1);
  });
});

describe("dryRun: отказы те же, записи нет", () => {
  it("всё в порядке — ok, но ничего не записано и монтажёру ничего не ушло", async () => {
    const property = await seed({ videoRemakeCount: 1 });
    const result = await sendPropertyBackToMontajerAs({ propertyId: property.id, actor: director(), body: { reason: "WRONG_OBJECT" }, source: "crm", dryRun: true });
    expect(result.ok).toBe(true);
    expect(await writes(property.id)).toBe(0);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.videoRemakeCount).toBe(1);
    expect(after.videoHandoffStatus).toBe("NONE");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendDocumentFile).not.toHaveBeenCalled();
  });

  it("объект ещё не был у монтажёра, продан, исходников нет, уже в очереди — те же тексты отказа", async () => {
    const noHistory = await seed({ videoHandoffFinalPath: null, instagramUrl: null, status: "EDITING", publishedChannels: [] });
    const sold = await seed({ status: "SOLD" });
    const noSource = await seed({}, false);
    const queued = await seed({ videoHandoffStatus: "QUEUED" });
    const run = (id: string) => sendPropertyBackToMontajerAs({ propertyId: id, actor: director(), body: { reason: "NO_MUSIC" }, source: "crm", dryRun: true });
    expect(await run(noHistory.id)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/ещё не был у монтажёра/) });
    expect(await run(sold.id)).toMatchObject({ ok: false, error: expect.stringMatching(/продан/) });
    expect(await run(noSource.id)).toMatchObject({ ok: false, error: expect.stringMatching(/исходные ролики/i) });
    expect(await run(queued.id)).toMatchObject({ ok: false, error: expect.stringMatching(/уже у монтажёра/) });
    for (const p of [noHistory, sold, noSource, queued]) expect(await writes(p.id)).toBe(0);
  });
});

describe("права: одна проверка на кнопку и на помощника", () => {
  it("sendBackDenied: чужой, рядовой после публикации, снятие из соцсетей — только маркетингу", () => {
    const published = { status: "AVAILABLE", assignedAgentId: "a", intakeAgentId: null, createdById: "a" };
    const draft = { status: "EDITING", assignedAgentId: "a", intakeAgentId: null, createdById: "a" };
    const own = { agentId: "a", role: "AGENT", can: can([]) as never };
    expect(sendBackDenied({ ...own, agentId: "b" }, draft, undefined)).toMatchObject({ status: 403 });
    expect(sendBackDenied(own, published, undefined)).toMatchObject({ status: 403 });
    expect(sendBackDenied(own, draft, undefined)).toBeNull();
    expect(sendBackDenied(own, draft, true)).toMatchObject({ status: 403 });
    expect(sendBackDenied({ ...own, role: "MARKETING" }, draft, true)).toBeNull();
    expect(sendBackDenied({ agentId: "d", role: "DIRECTOR", can: can(["properties.editForeign"]) as never }, published, true)).toBeNull();
  });

  it("объекта нет — 404, чужой неопубликованный — 403 до любой записи", async () => {
    const missing = await sendPropertyBackToMontajerAs({ propertyId: randomUUID(), actor: director(), body: { reason: "NO_MUSIC" }, source: "crm" });
    expect(missing).toMatchObject({ ok: false, status: 404 });
    const draft = await seed({ status: "EDITING" });
    const foreign = await sendPropertyBackToMontajerAs({
      propertyId: draft.id,
      actor: { agentId: montajerId, role: "AGENT", can: can([]) as never },
      body: { reason: "NO_MUSIC" },
      source: "crm",
    });
    expect(foreign).toMatchObject({ ok: false, status: 403 });
    expect(await writes(draft.id)).toBe(0);
  });
});
