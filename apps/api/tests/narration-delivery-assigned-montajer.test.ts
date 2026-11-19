import { randomInt, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * МОНТАЖЁР — ТОТ, КТО НАЗНАЧЕН В НАСТРОЙКАХ, А НЕ РОЛЬ (прод 19.11.2026).
 * Назначенный монтажёр (Settings.videoMontajerAgentId) заведён с ролью MARKETING, а передача
 * озвучки искала сотрудника с ролью EDITOR: ни одна озвучка не ушла монтажёру, а отказ
 * глотался пустым catch и выглядел как «объект не у монтажёра». Очередь монтажа роль не
 * проверяет, поэтому монтажёр получал исходники и монтировал без голоса.
 *
 * Настоящая база; наружу (Telegram) ничего не уходит — сеть подменена.
 */
const net = vi.hoisted(() => ({ document: vi.fn(), message: vi.fn() }));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendDocumentFile: net.document,
  sendMessage: net.message,
}));

import { prisma } from "../src/db.js";
import { afterNarrationApproved, runNarrationAutoFlow } from "../src/lib/narrationAutoFlow.js";
import { narrationFacts, narrationHash } from "../src/lib/propertyNarration.js";
import { waitFor } from "./helpers/waitFor.js";

const fx = { approverId: randomUUID(), montajerId: randomUUID(), districtId: randomUUID(), propertyIds: [] as string[], clientIds: [] as string[] };
let oldMontajerId: string | null = null;
let settingsExisted = false;

beforeAll(async () => {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } });
  settingsExisted = !!settings; oldMontajerId = settings?.videoMontajerAgentId ?? null;
  await prisma.agent.createMany({ data: [
    { id: fx.approverId, fullName: "Synthetic narration approver", phone: `role-approver-${fx.approverId}`, role: "AGENT", passwordHash: "unused", isActive: true },
    // Как на проде: монтажёр назначен в Настройках, но роль у него MARKETING, не EDITOR.
    { id: fx.montajerId, fullName: "Synthetic marketing montajer", phone: `role-montajer-${fx.montajerId}`, role: "MARKETING", passwordHash: "unused", isActive: true, telegramChatId: `synthetic-${fx.montajerId}` },
  ] });
  await prisma.district.create({ data: { id: fx.districtId, name: `Synthetic montajer role district ${fx.districtId}` } });
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", videoMontajerAgentId: fx.montajerId }, update: { videoMontajerAgentId: fx.montajerId } });
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRM_NARRATION_EXECUTION_MODE", "LIVE");
  net.document.mockResolvedValue({ message_id: 1 });
  net.message.mockResolvedValue({ message_id: 1 });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await prisma.property.deleteMany({ where: { id: { in: fx.propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: fx.clientIds } } });
  fx.propertyIds.length = 0; fx.clientIds.length = 0;
  await prisma.agent.update({ where: { id: fx.montajerId }, data: { telegramChatId: `synthetic-${fx.montajerId}`, isActive: true } });
});
afterAll(async () => {
  if (settingsExisted) await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: oldMontajerId } });
  else await prisma.settings.updateMany({ where: { id: "singleton", videoMontajerAgentId: fx.montajerId }, data: { videoMontajerAgentId: null } });
  await prisma.auditLog.deleteMany({ where: { agentId: { in: [fx.approverId, fx.montajerId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [fx.approverId, fx.montajerId] } } });
  await prisma.district.deleteMany({ where: { id: fx.districtId } });
});

/** Объект у монтажёра (SENT_TO_EDITOR) с готовой озвучкой, одобренной агентом. */
async function propertyAtMontajerWithApprovedVoice() {
  const sellerId = randomUUID(); fx.clientIds.push(sellerId);
  await prisma.client.create({ data: { id: sellerId, fullName: "Synthetic seller", phone: `+99291${randomInt(1000000, 9999999)}`, source: "WALK_IN", kind: "SELLER", assignedAgentId: fx.approverId } });
  const id = randomUUID(); fx.propertyIds.push(id);
  const p = await prisma.property.create({ data: { id, title: "Synthetic narration role property", type: "APARTMENT", areaSqm: 61, price: 400000, currency: "TJS", districtId: fx.districtId,
    address: "Synthetic fixture only", condition: "GOOD", sellerClientId: sellerId, videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() }, include: { district: true } });
  const facts = narrationFacts(p);
  const version = await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 1, script: "Синтетический текст озвучки.", factsSnapshot: facts, factsHash: narrationHash(facts),
    status: "READY", storageKey: `${p.id}/voice.mp3`, approvedAt: new Date(), approvedById: fx.approverId, createdById: fx.approverId, requestKey: randomUUID(), source: "AUTO" } });
  return { p, version };
}

describe("озвучка уходит назначенному монтажёру, а не роли EDITOR", () => {
  it("одобрение: монтажёр с ролью MARKETING получает передачу QUEUED", async () => {
    const { p, version } = await propertyAtMontajerWithApprovedVoice();
    expect(await afterNarrationApproved(p.id, version.id)).toBe("QUEUED");
    const rows = await prisma.propertyNarrationDelivery.findMany({ where: { propertyId: p.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "QUEUED", editorId: fx.montajerId, mode: "AUDIO_ONLY", versionId: version.id });
  });

  it("обход раз в минуту делает то же самое", async () => {
    const { p, version } = await propertyAtMontajerWithApprovedVoice();
    await runNarrationAutoFlow({});
    const rows = await prisma.propertyNarrationDelivery.findMany({ where: { propertyId: p.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "QUEUED", editorId: fx.montajerId, versionId: version.id });
  });

  it("у назначенного монтажёра нет Telegram: передачи нет, но журнал ошибок говорит об этом", async () => {
    await prisma.agent.update({ where: { id: fx.montajerId }, data: { telegramChatId: null } });
    const { p, version } = await propertyAtMontajerWithApprovedVoice();
    expect(await afterNarrationApproved(p.id, version.id)).not.toBe("QUEUED");
    expect(await prisma.propertyNarrationDelivery.count({ where: { propertyId: p.id } })).toBe(0);
    const row = await waitFor(() => prisma.errorLog.findFirst({ where: { message: { contains: `№${p.shortId}` }, AND: [{ message: { contains: "Telegram" } }] } }),
      { label: "запись в журнале ошибок о монтажёре без Telegram" });
    expect(row?.message).toContain("не подключён Telegram");
  });

  it("обход: объект у монтажёра, озвучка одобрена, голос не ушёл — сторож пишет в журнал причину", async () => {
    await prisma.agent.update({ where: { id: fx.montajerId }, data: { telegramChatId: null } });
    const { p } = await propertyAtMontajerWithApprovedVoice();
    await runNarrationAutoFlow({});
    expect(await prisma.propertyNarrationDelivery.count({ where: { propertyId: p.id } })).toBe(0);
    const row = await waitFor(() => prisma.errorLog.findFirst({ where: { message: { contains: `Озвучка объекта №${p.shortId} одобрена, объект у монтажёра, а голос ему не ушёл` } } }),
      { label: "сторож обхода" });
    expect(row?.message).toContain("Telegram");
  });

  it("монтажёр отключён: причина не выдаётся за «нет Telegram»", async () => {
    await prisma.agent.update({ where: { id: fx.montajerId }, data: { isActive: false } });
    const { p, version } = await propertyAtMontajerWithApprovedVoice();
    expect(await afterNarrationApproved(p.id, version.id)).not.toBe("QUEUED");
    const row = await waitFor(() => prisma.errorLog.findFirst({ where: { message: { contains: `№${p.shortId}` }, AND: [{ message: { contains: "монтажёр" } }] } }),
      { label: "запись об отключённом монтажёре" });
    expect(row?.message).toContain("отключён");
    expect(row?.message).not.toContain("Telegram");
  });
});
