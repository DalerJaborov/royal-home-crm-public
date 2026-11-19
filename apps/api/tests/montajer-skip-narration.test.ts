import { randomInt, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ГОЛОС НЕ ТЕРЯЕТСЯ, КОГДА МОНТАЖЁР ОТЛОЖИЛ ОБЪЕКТ (ревью 19.11.2026, кнопки очереди в боте).
 * Передача озвучки по объекту, который ушёл обратно в очередь («Сделаю позже»), гасла в FAILED,
 * а обход озвучки версию с любой передачей больше не брал: вернувшись к монтажёру, объект
 * монтировался без голоса. Теперь такая передача ЖДЁТ (WAITING) и уходит, когда объект
 * снова у монтажёра; уже ушедший голос второй раз не уходит; ложных тревог сторожа нет.
 *
 * Настоящая база; Telegram подменён.
 */
const net = vi.hoisted(() => ({ document: vi.fn(), message: vi.fn() }));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendDocumentFile: net.document,
  sendMessage: net.message,
}));

import { prisma } from "../src/db.js";
import { afterNarrationApproved, runNarrationAutoFlow } from "../src/lib/narrationAutoFlow.js";
import { executeNarrationDelivery } from "../src/lib/narrationDelivery.js";
import { narrationFacts, narrationHash } from "../src/lib/propertyNarration.js";
import { localVideoDelete, localVideoUpload } from "../src/lib/localVideoStorage.js";
import { waitForSettled } from "./helpers/waitFor.js";

const fx = { approverId: randomUUID(), montajerId: randomUUID(), districtId: randomUUID(), propertyIds: [] as string[], clientIds: [] as string[], storageKeys: [] as string[] };
let oldMontajerId: string | null = null;

beforeAll(async () => {
  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" }, select: { videoMontajerAgentId: true } });
  oldMontajerId = settings.videoMontajerAgentId;
  await prisma.agent.createMany({ data: [
    { id: fx.approverId, fullName: "Synthetic skip approver", phone: `skip-approver-${fx.approverId}`, role: "DIRECTOR", passwordHash: "unused", isActive: true },
    { id: fx.montajerId, fullName: "Synthetic skip montajer", phone: `skip-montajer-${fx.montajerId}`, role: "MARKETING", passwordHash: "unused", isActive: true, telegramChatId: `synthetic-${fx.montajerId}` },
  ] });
  await prisma.district.create({ data: { id: fx.districtId, name: `Synthetic skip district ${fx.districtId}` } });
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("CRM_NARRATION_EXECUTION_MODE", "LIVE");
  net.document.mockResolvedValue({ message_id: 1, document: { file_id: "synthetic" } });
  net.message.mockResolvedValue({ message_id: 1 });
  await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: fx.montajerId } });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await prisma.property.deleteMany({ where: { id: { in: fx.propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: fx.clientIds } } });
  for (const key of fx.storageKeys.splice(0)) await localVideoDelete(key);
  fx.propertyIds.length = 0;
  fx.clientIds.length = 0;
});
afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: oldMontajerId } });
  await prisma.auditLog.deleteMany({ where: { agentId: { in: [fx.approverId, fx.montajerId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [fx.approverId, fx.montajerId] } } });
  await prisma.district.deleteMany({ where: { id: fx.districtId } });
});

async function holderWithApprovedVoice() {
  const sellerId = randomUUID();
  fx.clientIds.push(sellerId);
  await prisma.client.create({ data: { id: sellerId, fullName: "Synthetic seller", phone: `+99291${randomInt(1000000, 9999999)}`, source: "WALK_IN", kind: "SELLER", assignedAgentId: fx.approverId } });
  const id = randomUUID();
  fx.propertyIds.push(id);
  const p = await prisma.property.create({ data: { id, title: "Synthetic skip property", type: "APARTMENT", areaSqm: 61, price: 400000, currency: "TJS", districtId: fx.districtId,
    address: "Synthetic fixture only", condition: "GOOD", sellerClientId: sellerId, videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date() }, include: { district: true } });
  const facts = narrationFacts(p);
  const storageKey = `${p.id}/${randomUUID()}.mp3`;
  fx.storageKeys.push(storageKey);
  await localVideoUpload(storageKey, Buffer.from("synthetic mp3 bytes, never sent"));
  const version = await prisma.propertyNarrationVersion.create({ data: { propertyId: p.id, revision: 1, script: "Синтетический текст.", factsSnapshot: facts, factsHash: narrationHash(facts),
    status: "READY", storageKey, approvedAt: new Date(), approvedById: fx.approverId, createdById: fx.approverId, requestKey: randomUUID(), source: "AUTO" } });
  return { p, version };
}

const setHandoff = (id: string, status: "QUEUED" | "SENT_TO_EDITOR") => prisma.property.update({ where: { id }, data: { videoHandoffStatus: status } });
const voiceErrors = (id: string) => waitForSettled(() => prisma.errorLog.count({ where: { OR: [{ dedupKey: { contains: id } }, { message: { contains: "голос монтажёру не ушёл" } }] } }));

describe("«Сделаю позже» и голос", () => {
  it("объект ушёл в очередь до отправки голоса — передача ждёт, а вернувшись к монтажёру, голос уходит один раз и без тревог", async () => {
    const { p, version } = await holderWithApprovedVoice();
    expect(await afterNarrationApproved(p.id, version.id)).toBe("QUEUED");
    const [row] = await prisma.propertyNarrationDelivery.findMany({ where: { propertyId: p.id } });
    const errorsBefore = await voiceErrors(p.id);

    await setHandoff(p.id, "QUEUED"); // монтажёр нажал «Сделаю позже»
    expect((await executeNarrationDelivery(row!.id)).status).toBe("WAITING");
    expect(net.document).not.toHaveBeenCalled();

    await runNarrationAutoFlow({}); // объект ещё в очереди — ничего не уходит
    expect(net.document).not.toHaveBeenCalled();

    await setHandoff(p.id, "SENT_TO_EDITOR"); // объект снова у монтажёра
    await runNarrationAutoFlow({});
    const rows = await prisma.propertyNarrationDelivery.findMany({ where: { propertyId: p.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("QUEUED");
    expect((await executeNarrationDelivery(rows[0]!.id)).status).toBe("SENT");
    expect(net.document).toHaveBeenCalledTimes(1);

    await runNarrationAutoFlow({});
    expect(await prisma.propertyNarrationDelivery.count({ where: { propertyId: p.id } })).toBe(1);
    expect(net.document).toHaveBeenCalledTimes(1);
    expect(await voiceErrors(p.id)).toBe(errorsBefore);
  });

  it("голос уже ушёл в этом заходе — после «Сделаю позже» и возврата второй раз не уходит", async () => {
    const { p, version } = await holderWithApprovedVoice();
    await afterNarrationApproved(p.id, version.id);
    const [row] = await prisma.propertyNarrationDelivery.findMany({ where: { propertyId: p.id } });
    expect((await executeNarrationDelivery(row!.id)).status).toBe("SENT");
    await setHandoff(p.id, "QUEUED");
    await setHandoff(p.id, "SENT_TO_EDITOR");
    await runNarrationAutoFlow({});
    expect(await prisma.propertyNarrationDelivery.count({ where: { propertyId: p.id } })).toBe(1);
    expect(net.document).toHaveBeenCalledTimes(1);
  });
});
