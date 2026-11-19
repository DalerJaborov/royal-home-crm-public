import { randomInt, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * РАЗОВЫЙ ВОЗВРАТ СДАННЫХ РОЛИКОВ «ВКЛЕЙТЕ ГОЛОС» (19.11.2026, решение владельца: «Ролик который сдан
 * отправить монтажеру»). lib/narrationAutoFlow.ts::returnClipForNarrationVoice — логика скрипта
 * src/scripts/return-clips-for-voice.ts. Настоящая база; дозвон монтажёру в Telegram подменён.
 */
const net = vi.hoisted(() => ({ dispatch: vi.fn(), document: vi.fn(), message: vi.fn() }));
vi.mock("../src/lib/videoHandoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/videoHandoff.js")>()),
  dispatchToEditor: net.dispatch,
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendDocumentFile: net.document,
  sendMessage: net.message,
}));

import { prisma } from "../src/db.js";
import { requestNarrationAddVoice, returnClipForNarrationVoice } from "../src/lib/narrationAutoFlow.js";
import { narrationFacts, narrationHash } from "../src/lib/propertyNarration.js";
import { waitFor } from "./helpers/waitFor.js";

const fx = { agentId: randomUUID(), montajerId: randomUUID(), districtId: randomUUID(), propertyIds: [] as string[], clientIds: [] as string[] };
let oldSettings: { videoMontajerAgentId: string | null; videoHandoffEnabled: boolean } | null = null;

beforeAll(async () => {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true, videoHandoffEnabled: true } });
  oldSettings = s ?? null;
  await prisma.agent.createMany({ data: [
    { id: fx.agentId, fullName: "Synthetic voice approver", phone: `ret-agent-${fx.agentId}`, role: "AGENT", passwordHash: "unused", isActive: true },
    { id: fx.montajerId, fullName: "Synthetic montajer", phone: `ret-montajer-${fx.montajerId}`, role: "MARKETING", passwordHash: "unused", isActive: true, telegramChatId: `synthetic-${fx.montajerId}` },
  ] });
  await prisma.district.create({ data: { id: fx.districtId, name: `Synthetic return district ${fx.districtId}` } });
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", videoMontajerAgentId: fx.montajerId, videoHandoffEnabled: true },
    update: { videoMontajerAgentId: fx.montajerId, videoHandoffEnabled: true } });
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRM_NARRATION_EXECUTION_MODE", "LIVE");
  net.dispatch.mockResolvedValue(true);
  net.document.mockResolvedValue({ message_id: 1 });
  net.message.mockResolvedValue({ message_id: 1 });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await prisma.videoRemakeRequest.deleteMany({ where: { propertyId: { in: fx.propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: fx.propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: fx.clientIds } } });
  fx.propertyIds.length = 0; fx.clientIds.length = 0;
});
afterAll(async () => {
  if (oldSettings) await prisma.settings.update({ where: { id: "singleton" }, data: oldSettings });
  await prisma.auditLog.deleteMany({ where: { agentId: { in: [fx.agentId, fx.montajerId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [fx.agentId, fx.montajerId] } } });
  await prisma.district.deleteMany({ where: { id: fx.districtId } });
});

/** Ролик сдан монтажёром (RECEIVED) и вышел в Instagram без голоса; озвучка готова. */
async function deliveredClip(opts: { approved: boolean; published?: boolean }) {
  const sellerId = randomUUID(); fx.clientIds.push(sellerId);
  await prisma.client.create({ data: { id: sellerId, fullName: "Synthetic seller", phone: `+99292${randomInt(1000000, 9999999)}`, source: "WALK_IN", kind: "SELLER", assignedAgentId: fx.agentId } });
  const id = randomUUID(); fx.propertyIds.push(id);
  const published = opts.published ?? true;
  const p = await prisma.property.create({ data: { id, title: "Synthetic delivered clip", type: "APARTMENT", areaSqm: 64, price: 410000, currency: "TJS", districtId: fx.districtId,
    address: "Synthetic fixture only", condition: "GOOD", sellerClientId: sellerId, status: "AVAILABLE", intakeAgentId: fx.agentId,
    videoHandoffStatus: "RECEIVED", videoHandoffReceivedAt: new Date(), videoHandoffFinalPath: `synthetic/${id}/final.mp4`,
    ...(published ? { publishedChannels: ["INSTAGRAM"], publishedPostIds: { INSTAGRAM: `ig-${id}` } } : {}) }, include: { district: true } });
  await prisma.propertyVideo.create({ data: { propertyId: id, storageKey: `synthetic/${id}/raw.mp4`, filename: "raw.mp4", sizeBytes: 1024, uploadedById: fx.agentId } });
  const facts = narrationFacts(p);
  const version = await prisma.propertyNarrationVersion.create({ data: { propertyId: id, revision: 1, script: "Синтетический текст.", factsSnapshot: facts, factsHash: narrationHash(facts),
    status: "READY", storageKey: `${id}/voice.mp3`, createdById: fx.agentId, requestKey: randomUUID(), source: "WIZARD",
    ...(opts.approved ? { approvedAt: new Date(), approvedById: fx.agentId } : {}) } });
  return { p, version };
}

describe("возврат сданного ролика монтажёру «вклейте голос»", () => {
  it("вышедший ролик возвращается, старые посты снимутся только когда выйдет новый", async () => {
    const { p } = await deliveredClip({ approved: true });
    const r = await returnClipForNarrationVoice(p.id, { includePublished: true, apply: true, source: "test-script" });
    expect(r).toMatchObject({ outcome: "RETURNED", published: true, revision: 1 });
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(["QUEUED", "SENT_TO_EDITOR"]).toContain(after.videoHandoffStatus);
    expect(after.videoHandoffRemakeReason).toBe("NARRATION_CHANGED");
    expect(after.publishedChannels).toEqual(["INSTAGRAM"]); // сейчас ничего не снято
    const remakes = await prisma.videoRemakeRequest.findMany({ where: { propertyId: p.id } });
    expect(remakes).toHaveLength(1);
    expect(remakes[0]).toMatchObject({ reason: "NARRATION_CHANGED", replaceOldPostsOnPublish: true, requestedById: fx.agentId });
    expect(remakes[0].comment).toContain("вклейте голос");
    const audit = await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: p.id, action: "PROPERTY_SENT_BACK_TO_MONTAJER" } }), { label: "аудит возврата" });
    expect(audit?.meta).toMatchObject({ reason: "NARRATION_CHANGED", source: "test-script", published: true });
  });

  it("сухой прогон ничего не меняет", async () => {
    const { p } = await deliveredClip({ approved: true });
    expect(await returnClipForNarrationVoice(p.id, { includePublished: true, apply: false, source: "test-script" })).toMatchObject({ outcome: "WOULD_RETURN", published: true });
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).videoHandoffStatus).toBe("RECEIVED");
    expect(await prisma.videoRemakeRequest.count({ where: { propertyId: p.id } })).toBe(0);
    expect(net.dispatch).not.toHaveBeenCalled();
  });

  it("неодобренная озвучка — пропуск с причиной", async () => {
    const { p } = await deliveredClip({ approved: false });
    expect(await returnClipForNarrationVoice(p.id, { includePublished: true, apply: true, source: "test-script" })).toMatchObject({ outcome: "SKIPPED", reason: "озвучка не одобрена" });
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).videoHandoffStatus).toBe("RECEIVED");
    expect(await prisma.videoRemakeRequest.count({ where: { propertyId: p.id } })).toBe(0);
  });

  it("одобрена только самой CRM — на вышедшем ролике не считается", async () => {
    const { p, version } = await deliveredClip({ approved: true });
    await prisma.propertyNarrationVersion.update({ where: { id: version.id }, data: { approvalNotifiedAt: version.approvedAt } });
    expect(await returnClipForNarrationVoice(p.id, { includePublished: true, apply: true, source: "test-script" })).toMatchObject({ outcome: "SKIPPED" });
    expect(await prisma.videoRemakeRequest.count({ where: { propertyId: p.id } })).toBe(0);
  });

  it("голос монтажёру уже уходил — пропуск", async () => {
    const { p, version } = await deliveredClip({ approved: true });
    await prisma.propertyNarrationDelivery.create({ data: { propertyId: p.id, versionId: version.id, editorId: fx.montajerId, mode: "AUDIO_ONLY", requestKey: randomUUID(), createdById: fx.agentId, status: "SENT", executionMode: "LIVE" } });
    expect(await returnClipForNarrationVoice(p.id, { includePublished: true, apply: true, source: "test-script" })).toMatchObject({ outcome: "SKIPPED", reason: "голос монтажёру уже уходил" });
  });

  it("повторный запуск ничего не задваивает", async () => {
    const { p } = await deliveredClip({ approved: true });
    expect((await returnClipForNarrationVoice(p.id, { includePublished: true, apply: true, source: "test-script" })).outcome).toBe("RETURNED");
    const again = await returnClipForNarrationVoice(p.id, { includePublished: true, apply: true, source: "test-script" });
    expect(again.outcome).toBe("SKIPPED");
    expect(await prisma.videoRemakeRequest.count({ where: { propertyId: p.id } })).toBe(1);
    await waitFor(() => prisma.auditLog.count({ where: { entityId: p.id, action: "PROPERTY_SENT_BACK_TO_MONTAJER" } }), { label: "аудит" });
    expect(await prisma.auditLog.count({ where: { entityId: p.id, action: "PROPERTY_SENT_BACK_TO_MONTAJER" } })).toBe(1);
  });

  it("невышедший ролик: возврат без снятия постов; обход по-прежнему не трогает вышедший", async () => {
    const fresh = await deliveredClip({ approved: true, published: false });
    expect(await requestNarrationAddVoice(fresh.p.id, fresh.version.id)).toBe("QUEUED");
    const remake = await prisma.videoRemakeRequest.findFirst({ where: { propertyId: fresh.p.id } });
    expect(remake?.replaceOldPostsOnPublish ?? false).toBe(false);
    const out = await deliveredClip({ approved: true, published: true });
    expect(await requestNarrationAddVoice(out.p.id, out.version.id)).toBe("SKIPPED");
    expect((await prisma.property.findUniqueOrThrow({ where: { id: out.p.id } })).videoHandoffStatus).toBe("RECEIVED");
  });
});
