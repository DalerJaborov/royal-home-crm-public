import { randomInt, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ sms: vi.fn(), telegram: vi.fn() }));
vi.mock("../src/lib/sms/index.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/sms/index.js")>(), sendSms: transport.sms }));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/telegram/api.js")>(), sendDocumentFile: transport.telegram }));
import { prisma } from "../src/db.js";
import { setOwnerReportConsent, prepareOwnerReportDelivery, executeOwnerReportDelivery } from "../src/lib/ownerReport/delivery.js";
import { prepareNarrationDeliveryPlan, executeNarrationDelivery } from "../src/lib/narrationDelivery.js";
import { narrationFacts, narrationHash } from "../src/lib/propertyNarration.js";
import { localVideoUpload, localVideoDelete } from "../src/lib/localVideoStorage.js";

function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function bounded<T>(promise: Promise<T>, label: string, ms = 6000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
const fixture = { actorId: randomUUID(), editorId: randomUUID(), districtId: randomUUID(), propertyIds: [] as string[], clientIds: [] as string[], storageKeys: [] as string[] };
let oldEditorId: string | null = null;
let oldSettingsExisted = false;

beforeAll(async () => {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } });
  oldSettingsExisted = !!settings; oldEditorId = settings?.videoMontajerAgentId ?? null;
  await prisma.agent.createMany({ data: [
    { id: fixture.actorId, fullName: "Synthetic media owner admin", phone: `media-admin-${fixture.actorId}`, role: "ADMIN", passwordHash: "unused", isActive: false },
    { id: fixture.editorId, fullName: "Synthetic media editor", phone: `media-editor-${fixture.editorId}`, role: "EDITOR", passwordHash: "unused", isActive: true, telegramChatId: `synthetic-${fixture.editorId}` },
  ] });
  await prisma.district.create({ data: { id: fixture.districtId, name: `Synthetic media district ${fixture.districtId}` } });
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", videoMontajerAgentId: fixture.editorId }, update: { videoMontajerAgentId: fixture.editorId } });
});
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("CRM_PUBLIC_URL", "https://crm-media.example.test"); vi.stubEnv("JWT_ACCESS_SECRET", "synthetic-media-delivery-secret");
  vi.stubEnv("CRM_OWNER_REPORT_EXECUTION_MODE", "LIVE"); vi.stubEnv("CRM_NARRATION_EXECUTION_MODE", "LIVE");
  transport.sms.mockResolvedValue({ ok: true, id: "synthetic-sms-journal", providerMessageId: "synthetic-payom-receipt", dryRun: false, deliveryStatus: "SERVICE_ACCEPTED" });
  transport.telegram.mockResolvedValue({ message_id: 123, document: { file_id: "synthetic-telegram-file" } });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  // Only these exact synthetic IDs; cascade removes narration/report/link records.
  await prisma.property.deleteMany({ where: { id: { in: fixture.propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: fixture.clientIds } } });
  for (const key of fixture.storageKeys.splice(0)) expect(await localVideoDelete(key)).toBe(true);
  fixture.propertyIds.length = 0; fixture.clientIds.length = 0;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (oldSettingsExisted) await prisma.settings.update({ where: { id: "singleton" }, data: { videoMontajerAgentId: oldEditorId } });
  else await prisma.settings.updateMany({ where: { id: "singleton", videoMontajerAgentId: fixture.editorId }, data: { videoMontajerAgentId: null } });
  await prisma.auditLog.deleteMany({ where: { agentId: { in: [fixture.actorId, fixture.editorId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [fixture.actorId, fixture.editorId] } } });
  await prisma.district.deleteMany({ where: { id: fixture.districtId } });
});

async function property(holder = false) {
  const ownerId = randomUUID(); fixture.clientIds.push(ownerId);
  const seller = await prisma.client.create({ data: { id: ownerId, fullName: "Synthetic consent owner", phone: `+99290${randomInt(1000000, 9999999)}`, source: "WALK_IN", kind: "SELLER", assignedAgentId: fixture.actorId } });
  const id = randomUUID(); fixture.propertyIds.push(id);
  const row = await prisma.property.create({ data: { id, title: "Synthetic media delivery property", type: "APARTMENT", areaSqm: 55, price: 350000, currency: "TJS", districtId: fixture.districtId, address: "Synthetic fixture only", condition: "GOOD", sellerClientId: seller.id,
    ...(holder ? { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date(), videoHandoffManualSince: null } : {}) }, include: { district: true } });
  return { row, seller };
}
async function ownerDelivery() {
  const p = await property();
  await prisma.propertyOwnerReportLink.create({ data: { propertyId: p.row.id, token: randomUUID().replaceAll("-", "") + "synthetic12", createdById: fixture.actorId } });
  await setOwnerReportConsent(p.row.id, fixture.actorId, true);
  const delivery = await prepareOwnerReportDelivery(p.row.id);
  expect(delivery).not.toBeNull();
  return { ...p, delivery: delivery! };
}
async function narrationDelivery() {
  const p = await property(true), versionId = randomUUID();
  const key = `${p.row.id}/${versionId}.mp3`; fixture.storageKeys.push(key);
  await localVideoUpload(key, Buffer.from("synthetic mp3 bytes, never sent"));
  const facts = narrationFacts(p.row);
  const version = await prisma.propertyNarrationVersion.create({ data: { id: versionId, propertyId: p.row.id, revision: 1, script: "Полный синтетический текст без цены.", factsSnapshot: facts, factsHash: narrationHash(facts), status: "READY", storageKey: key, approvedAt: new Date(), approvedById: fixture.actorId, createdById: fixture.actorId, requestKey: randomUUID() } });
  const prepared = await prepareNarrationDeliveryPlan(p.row.id, version.id, "AUDIO_ONLY");
  const delivery = await prisma.propertyNarrationDelivery.create({ data: { propertyId: p.row.id, versionId: version.id, editorId: fixture.editorId, mode: "AUDIO_ONLY", status: "QUEUED", executionMode: "LIVE", plan: prepared.plan, requestKey: randomUUID(), createdById: fixture.actorId } });
  return { ...p, version, delivery };
}

describe("actual PostgreSQL media delivery claims; providers only are mocked", () => {
  it("two concurrent owner dispatches call provider once, while normal edits and revocation are not locked", async () => {
    const { row, seller, delivery } = await ownerDelivery();
    const entered = barrier(), release = barrier();
    transport.sms.mockImplementation(async () => { entered.release(); await bounded(release.promise, "release SMS", 15000); return { ok: true, id: "sms-receipt", providerMessageId: "provider-accepted", dryRun: false, deliveryStatus: "SERVICE_ACCEPTED" }; });
    const first = executeOwnerReportDelivery(delivery.id); void first.catch(() => undefined);
    try {
      await bounded(entered.promise, "SMS entered");
      expect(await bounded(executeOwnerReportDelivery(delivery.id), "second claim")).toEqual({ status: "NOT_CLAIMED" });
      await bounded(prisma.property.update({ where: { id: row.id }, data: { title: "Normal edit while SMS pending" } }), "normal property edit");
      await bounded(prisma.client.update({ where: { id: seller.id }, data: { fullName: "Owner updated while SMS pending" } }), "normal client edit");
      await bounded(setOwnerReportConsent(row.id, fixture.actorId, false), "consent revocation");
      expect((await prisma.ownerReportSubscription.findUniqueOrThrow({ where: { propertyId: row.id } })).active).toBe(false);
      release.release(); expect(await bounded(first, "receipt persisted")).toEqual({ status: "SENT" });
      const receipt = await prisma.ownerReportDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(receipt.providerReceipt).toMatchObject({ providerMessageId: "provider-accepted", deliveryStatus: "SERVICE_ACCEPTED" });
      expect(receipt.deliveredAt).toBeNull(); // acceptance is not human delivery; in-flight cannot be recalled
      expect(transport.sms).toHaveBeenCalledOnce();
      expect(await prepareOwnerReportDelivery(row.id)).toBeNull();
    } finally { release.release(); await Promise.allSettled([first]); }
  }, 30000);

  it("owner late proof cannot promote a manually resolved FAILED row", async () => {
    const { delivery } = await ownerDelivery(); const entered = barrier(), release = barrier();
    transport.sms.mockImplementation(async () => { entered.release(); await bounded(release.promise, "release late SMS", 15000); return { ok: true, id: "late-sms", providerMessageId: "late-provider-id", dryRun: false }; });
    const attempt = executeOwnerReportDelivery(delivery.id); void attempt.catch(() => undefined);
    try {
      await bounded(entered.promise, "late SMS entered");
      await bounded(prisma.ownerReportDelivery.update({ where: { id: delivery.id }, data: { status: "FAILED", lastError: "Manual reconciliation fixture", providerReceipt: { existingEvidence: "preserve" } } }), "manual reconciliation write");
      release.release(); expect(await bounded(attempt, "late SMS persisted")).toEqual({ status: "UNKNOWN" });
      const after = await prisma.ownerReportDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(after.status).toBe("FAILED"); expect(after.lastError).toBe("Manual reconciliation fixture");
      expect(after.providerReceipt).toMatchObject({ existingEvidence: "preserve", lateReceipt: { providerMessageId: "late-provider-id" } });
      expect(transport.sms).toHaveBeenCalledOnce();
    } finally { release.release(); await Promise.allSettled([attempt]); }
  }, 30000);

  it("changed full recipient number aborts before any provider call", async () => {
    const { seller, delivery } = await ownerDelivery();
    await prisma.client.update({ where: { id: seller.id }, data: { phone: `+99291${randomInt(1000000, 9999999)}` } });
    expect(await executeOwnerReportDelivery(delivery.id)).toEqual({ status: "CANCELLED" }); expect(transport.sms).not.toHaveBeenCalled();
  });

  it("PREVIEW subscription and old preview delivery never promote after server gate changes", async () => {
    vi.stubEnv("CRM_OWNER_REPORT_EXECUTION_MODE", "PREVIEW"); const { row, delivery } = await ownerDelivery(); expect(delivery.status).toBe("PREVIEW");
    vi.stubEnv("CRM_OWNER_REPORT_EXECUTION_MODE", "LIVE");
    expect(await executeOwnerReportDelivery(delivery.id)).toEqual({ status: "NOT_CLAIMED" });
    const again = await prepareOwnerReportDelivery(row.id); expect(again?.id).toBe(delivery.id); expect(again?.status).toBe("PREVIEW"); expect(transport.sms).not.toHaveBeenCalled();
  });

  it("narration provider await holds no property lock and late receipt does not resume second file", async () => {
    const { row, delivery } = await narrationDelivery(); const entered = barrier(), release = barrier();
    transport.telegram.mockImplementation(async () => { entered.release(); await bounded(release.promise, "release Telegram", 15000); return { message_id: 1234, document: { file_id: "late-file" } }; });
    const attempt = executeNarrationDelivery(delivery.id); void attempt.catch(() => undefined);
    try {
      await bounded(entered.promise, "Telegram entered");
      expect(await bounded(executeNarrationDelivery(delivery.id), "second narration claim")).toEqual({ status: "NOT_CLAIMED" });
      await bounded(prisma.property.update({ where: { id: row.id }, data: { title: "Normal narration edit during await" } }), "narration property edit");
      await bounded(prisma.propertyNarrationDelivery.update({ where: { id: delivery.id }, data: { status: "FAILED", lastError: "Manual narration reconciliation fixture", receipts: { earlier: { messageId: 111 } } } }), "narration reconciliation");
      release.release(); expect(await bounded(attempt, "late narration receipt")).toEqual({ status: "UNKNOWN" });
      const after = await prisma.propertyNarrationDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(after.status).toBe("FAILED"); expect(after.lastError).toBe("Manual narration reconciliation fixture");
      expect(after.receipts).toMatchObject({ earlier: { messageId: 111 }, [delivery.versionId]: { messageId: 1234, late: true } });
      expect(transport.telegram).toHaveBeenCalledOnce();
    } finally { release.release(); await Promise.allSettled([attempt]); }
  }, 30000);
});
