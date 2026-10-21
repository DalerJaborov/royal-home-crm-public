import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/ai/interviewInviteCallParse.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/ai/interviewInviteCallParse.js")>()),
  parseInterviewInviteCall: vi.fn(async () => ({ outcome: "CONFIRMED", confidence: 0.95, quote: "да, приду", summary: "Подтвердил", proposedTime: null })),
}));
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { ensureScopedBotConversation } from "../src/lib/customerConversationScope.js";
import { previewRecruitmentContact, confirmRecruitmentContact, recruitmentContactOptions, dispatchRecruitmentCommunication,
  __setRecruitmentCommunicationTransportsForTests, recordRecruitmentSmsReceipt, finishRecruitmentAssistantCall, runRecruitmentCommunicationTick } from "../src/lib/recruitmentCommunications.js";
import type { RecruitmentContactPreviewInput } from "@royal-home/shared";
import type { ProviderSendResult } from "../src/lib/sms/payom.js";
import type { LiveVoiceClientCallResult } from "../src/lib/telephony/liveVoiceBridge.js";

const marker = `staff-recruit-${randomUUID()}`, key = `synthetic-${randomUUID()}`;
const created: Array<{ app: string; native: string; inquiry: string }> = [];
let actorId: string, accountId: string, scopeId: string;
let savedSettings: Awaited<ReturnType<typeof readSettings>>, savedPolicy: Awaited<ReturnType<typeof readPolicy>>;
const readSettings = () => prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
  smsProvider: true, smsApiToken: true, smsSender: true, liveVoiceEnabled: true, interviewInviteAddress: true,
} });
const readPolicy = () => prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" }, select: { contractVersion: true, rolloutMode: true, capabilities: true } });
const sms = vi.fn(async (): Promise<ProviderSendResult> => ({ ok: true, messageId: `synthetic-receipt-${randomUUID()}`, parts: 2, deliveryStatus: "SERVICE_ACCEPTED" }));
const call = vi.fn(async (_phone: string, _task: unknown, options?: { channelId?: string }): Promise<LiveVoiceClientCallResult> => ({ ok: true, channelId: options!.channelId }));
async function candidate() {
  const native = await prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel: "WHATSAPP", subscriberId: `synthetic-${randomUUID()}`, accountId }));
  scopeId = native.transport.endpointScopeId;
  const inquiry = await prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: native.id } });
  // Synthetic stored core state, not an ingress frame or a BOT authority.
  await prisma.customerInquiry.update({ where: { id: inquiry.id }, data: { ownerMode: "BOT", ownerToken: randomUUID(),
    publicState: { language: "ru", topic: "job", openQuestion: "none", jobPositionKey: key } } });
  const app = await prisma.jobApplication.create({ data: { channel: "WHATSAPP", name: marker, phone: "+992000000001",
    customerInquiryId: inquiry.id, customerPositionKey: key, customerApplicationRevision: 1n, rawText: "Синтетические материалы" } });
  created.push({ app: app.id, native: native.id, inquiry: inquiry.id });
  return { app: app.id, native: native.id, inquiry: inquiry.id };
}
async function legacyCandidate(assigned = true) {
  const c = await candidate();
  await prisma.jobApplication.update({ where: { id: c.app }, data: { customerInquiryId: null, customerPositionKey: null,
    customerApplicationRevision: null, conversationId: c.native } });
  if (assigned) await prisma.$executeRaw`UPDATE "JobApplication" SET "hrPositionKey"=${key},"updatedAt"=now() WHERE "id"=${c.app}`;
  return c;
}
const invite = (): RecruitmentContactPreviewInput => ({ purpose: "INVITE", language: "ru", channels: ["SMS"],
  interviewAt: new Date(Date.now() + 48 * 3600_000).toISOString(), preparation: "Работы по желанию" });
async function queued(input = invite()) {
  const c = await candidate(), preview = await previewRecruitmentContact(c.app, actorId, input), idempotencyKey = randomUUID();
  const result = await confirmRecruitmentContact(c.app, actorId, { previewId: preview.previewId, idempotencyKey });
  return { ...c, preview, idempotencyKey, result, id: result.deliveries[0].id };
}
async function row(id: string) { const [value] = await prisma.$queryRaw<Array<{ status: string; providerReceipt: string | null; snapshotJson: unknown }>>`SELECT * FROM "RecruitmentCommunication" WHERE "id"=${id}`; return value; }
beforeAll(async () => {
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "11".repeat(32));
  savedSettings = await readSettings(); savedPolicy = await readPolicy();
  await prisma.settings.update({ where: { id: "singleton" }, data: { smsProvider: "payom", smsApiToken: encryptSecret("synthetic-token"),
    smsSender: "TEST", liveVoiceEnabled: true, interviewInviteAddress: "Синтетический офис" } });
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "scoped", rolloutMode: "ACTIVE", capabilities: { publicRead: true, contactWrite: true } } });
  const actor = await prisma.agent.create({ data: { fullName: marker, phone: marker, role: "DIRECTOR", passwordHash: "synthetic-unused" } }); actorId = actor.id;
  const account = await prisma.messengerAccount.create({ data: { title: marker, channel: "WHATSAPP", externalId: randomUUID(), token: encryptSecret("synthetic-token"), enabled: true } }); accountId = account.id;
  await prisma.recruitmentPosition.create({ data: { key, titleRu: "SMM — синтетическая вакансия", titleTg: "SMM — вазифаи санҷишӣ", detailsRu: "Монтаж видео", detailsTg: "Таҳрири видео", isOpen: true } });
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("Real external I/O forbidden"); }));
});
beforeEach(() => {
  sms.mockClear(); call.mockClear(); vi.stubEnv("SMS_DRY_RUN", "0");
  __setRecruitmentCommunicationTransportsForTests({ sms, call });
});
afterAll(async () => {
  __setRecruitmentCommunicationTransportsForTests(null); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  if (actorId) await prisma.$executeRaw`DELETE FROM "RecruitmentCommunication" WHERE "actorId"=${actorId}`;
  await prisma.$executeRaw`DELETE FROM "RecruitmentSmsReceipt" WHERE "providerId" LIKE 'synthetic-receipt-%'`;
  if (actorId) await prisma.auditLog.deleteMany({ where: { agentId: actorId } });
  await prisma.jobApplication.deleteMany({ where: { id: { in: created.map(c => c.app) } } });
  await prisma.customerInquiry.deleteMany({ where: { id: { in: created.map(c => c.inquiry) } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: created.map(c => c.native) } } });
  if (accountId) {
    await prisma.customerEndpointScope.deleteMany({ where: { messengerAccountId: accountId } });
    await prisma.messengerAccount.deleteMany({ where: { id: accountId } });
  }
  await prisma.recruitmentPosition.deleteMany({ where: { key } });
  if (actorId) await prisma.agent.deleteMany({ where: { id: actorId } });
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  if (savedPolicy) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { ...savedPolicy, capabilities: savedPolicy.capabilities! } });
});

describe("durable staff recruitment SQL and actual transport boundary", () => {
  it("commits the appointment and both channel rows once; duplicate confirms never call a provider", async () => {
    const c = await candidate(), input = { ...invite(), channels: ["SMS", "ASSISTANT_CALL"] as const };
    const preview = await previewRecruitmentContact(c.app, actorId, { ...input, channels: [...input.channels] });
    const command = { previewId: preview.previewId, idempotencyKey: randomUUID() };
    const [a, b] = await Promise.all([confirmRecruitmentContact(c.app, actorId, command), confirmRecruitmentContact(c.app, actorId, command)]);
    expect(a.deliveries).toHaveLength(2); expect(b.deliveries).toEqual(a.deliveries);
    expect(await prisma.jobApplication.findUnique({ where: { id: c.app } })).toMatchObject({ status: "INTERVIEW", interviewAt: new Date(input.interviewAt!) });
    expect(sms).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
    await Promise.all([dispatchRecruitmentCommunication(a.deliveries.find(d => d.channel === "SMS")!.id), dispatchRecruitmentCommunication(a.deliveries.find(d => d.channel === "SMS")!.id)]);
    expect(sms).toHaveBeenCalledTimes(1);
  });
  it("rejects stale actor, application, selected role, core ownership and policy revisions before any contact", async () => {
    for (const change of ["app", "role", "owner", "policy", "actor"] as const) {
      const c = await candidate(), preview = await previewRecruitmentContact(c.app, actorId, invite());
      if (change === "app") await prisma.jobApplication.update({ where: { id: c.app }, data: { rawText: "Новые сведения" } });
      if (change === "role") await prisma.recruitmentPosition.update({ where: { key }, data: { revision: { increment: 1 } } });
      if (change === "owner") await prisma.customerInquiry.update({ where: { id: c.inquiry }, data: { ownerMode: "HUMAN", ownerAgentId: randomUUID(), ownerToken: randomUUID() } });
      if (change === "policy") await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { policyRevision: { increment: 1 } } });
      if (change === "actor") await prisma.agent.update({ where: { id: actorId }, data: { isActive: false } });
      try { await expect(confirmRecruitmentContact(c.app, actorId, { previewId: preview.previewId, idempotencyKey: randomUUID() })).rejects.toThrow(); }
      finally { if (change === "actor") await prisma.agent.update({ where: { id: actorId }, data: { isActive: true } }); }
    }
    expect(sms).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
  });
  it("cancels a queued old invitation after reschedule instead of sending a stale time", async () => {
    const c = await queued();
    await prisma.jobApplication.update({ where: { id: c.app }, data: { interviewAt: new Date(Date.now() + 72 * 3600_000) } });
    await dispatchRecruitmentCommunication(c.id);
    expect((await row(c.id)).status).toBe("CANCELLED"); expect(sms).not.toHaveBeenCalled();
  });
  it("retains UNKNOWN after a lost response and blocks a new preview, including a different idempotency key", async () => {
    const c = await queued(); sms.mockImplementationOnce(async () => { throw Error("response lost after acceptance"); });
    await dispatchRecruitmentCommunication(c.id); await dispatchRecruitmentCommunication(c.id);
    expect((await row(c.id)).status).toBe("UNKNOWN"); expect(sms).toHaveBeenCalledTimes(1);
    await expect(previewRecruitmentContact(c.app, actorId, invite())).rejects.toThrow("не завершено");
    expect((await recruitmentContactOptions(c.app, actorId)).recentDeliveries[0].status).toBe("UNKNOWN");
  });
  it("reconciles a delivery callback which arrives before POST response and ignores old/duplicate events", async () => {
    const c = await queued(), receipt = `synthetic-receipt-${randomUUID()}`, at = new Date();
    sms.mockImplementationOnce(async () => {
      await recordRecruitmentSmsReceipt(receipt, "DELIVERED", at);
      return { ok: true, messageId: receipt, parts: 2, deliveryStatus: "SERVICE_ACCEPTED" };
    });
    await dispatchRecruitmentCommunication(c.id);
    expect(await row(c.id)).toMatchObject({ status: "DELIVERED", providerReceipt: receipt });
    await recordRecruitmentSmsReceipt(receipt, "SENT", new Date(at.getTime() - 1000));
    await recordRecruitmentSmsReceipt(receipt, "DELIVERED", at);
    expect((await row(c.id)).status).toBe("DELIVERED");
  });
  it("keeps clarification testimony visible without manufacturing a chat IN, resume facts or interview", async () => {
    const c = await queued({ purpose: "CLARIFY", channels: ["ASSISTANT_CALL"], language: "ru" });
    // One accepted physical call, supplied by the fake boundary; bypass clock-hours only by choosing a Dushanbe business hour.
    const at = new Date(); at.setUTCHours(7, 0, 0, 0);
    await dispatchRecruitmentCommunication(c.id, at);
    expect(call).toHaveBeenCalledTimes(1);
    await finishRecruitmentAssistantCall(c.id, { channelId: c.id, transcript: ["Бот: Какой опыт?", "Клиент: Работаю в Premiere"], reason: "channel_ended", clientSpoke: true });
    const result = (await recruitmentContactOptions(c.app, actorId)).recentDeliveries[0];
    expect(result).toMatchObject({ status: "COMPLETED", result: { purpose: "CLARIFY", candidateSpoke: true, transcript: ["Бот: Какой опыт?", "Клиент: Работаю в Premiere"] } });
    expect(await prisma.jobApplication.findUnique({ where: { id: c.app } })).toMatchObject({ status: "NEW", interviewAt: null, recruitmentResume: null });
    expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: c.native } })).messages).toEqual([]);
  });
  it("never upgrades a 201 without receipt to accepted or retries a provider ambiguity", async () => {
    const c = await queued(); sms.mockResolvedValueOnce({ ok: true, messageId: null, parts: null, deliveryStatus: null });
    await dispatchRecruitmentCommunication(c.id); await dispatchRecruitmentCommunication(c.id);
    expect((await row(c.id)).status).toBe("UNKNOWN"); expect(sms).toHaveBeenCalledTimes(1);
  });
  it("records an explicit pre-send refusal separately from an unknown outcome", async () => {
    const c = await queued(); sms.mockResolvedValueOnce({ ok: false, error: "synthetic explicit refusal", failureOutcome: "refused" });
    await dispatchRecruitmentCommunication(c.id);
    expect((await row(c.id)).status).toBe("REJECTED");
  });
  it("expired previews and changed permissions prevent a queue, and a default Vitest dispatch remains DRY_RUN", async () => {
    const c = await candidate(), preview = await previewRecruitmentContact(c.app, actorId, invite());
    await prisma.$executeRaw`UPDATE "RecruitmentCommunication" SET "expiresAt"=${new Date(Date.now() - 1000)} WHERE "previewId"=${preview.previewId}`;
    await expect(confirmRecruitmentContact(c.app, actorId, { previewId: preview.previewId, idempotencyKey: randomUUID() })).rejects.toThrow("устарел");
    const other = await queued(); __setRecruitmentCommunicationTransportsForTests(null);
    await dispatchRecruitmentCommunication(other.id);
    expect((await row(other.id)).status).toBe("DRY_RUN"); expect(sms).not.toHaveBeenCalled();
  });
  it("retains an old call response as evidence without confirming the rescheduled appointment", async () => {
    const c = await queued({ ...invite(), channels: ["ASSISTANT_CALL"] });
    const at = new Date(); at.setUTCHours(7, 0, 0, 0); await dispatchRecruitmentCommunication(c.id, at);
    expect((await row(c.id)).status).toBe("ACCEPTED");
    await prisma.jobApplication.update({ where: { id: c.app }, data: { interviewAt: new Date(Date.now() + 72 * 3600_000) } });
    await finishRecruitmentAssistantCall(c.id, { channelId: c.id, reason: "channel_ended", transcript: ["Клиент: да, приду"], clientSpoke: true });
    const result = (await recruitmentContactOptions(c.app, actorId)).recentDeliveries[0];
    expect(result.status).toBe("COMPLETED"); expect(result.result!.summary).toContain("прежней версии");
  });
  it.each(["wrong_person", "voicemail", "call_back_later", "refused", "no_answer"])("never confirms an invitation from %s even if the transcript contains yes", async reason => {
    const c = await queued({ ...invite(), channels: ["ASSISTANT_CALL"] });
    await prisma.$executeRaw`UPDATE "RecruitmentCommunication" SET "status"='ACCEPTED',"providerReceipt"=${c.id} WHERE "id"=${c.id}`;
    await finishRecruitmentAssistantCall(c.id, { channelId: c.id, reason: `model_end_call:${reason}`, transcript: ["Клиент: да"], clientSpoke: true });
    const result = (await recruitmentContactOptions(c.app, actorId)).recentDeliveries[0];
    expect(result.status).toBe("COMPLETED"); expect(result.result?.summary).not.toBe("Подтвердил");
    if (["wrong_person", "voicemail", "no_answer"].includes(reason)) expect(result.result?.candidateSpoke).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });
  it("reconstructs a lost call callback from the real voice-session journal without redialling", async () => {
    const c = await queued({ purpose: "CLARIFY", channels: ["ASSISTANT_CALL"], language: "ru" });
    const at = new Date(); at.setUTCHours(7, 0, 0, 0); await dispatchRecruitmentCommunication(c.id, at);
    await prisma.$executeRaw`UPDATE "RecruitmentCommunication" SET "attemptStartedAt"=${new Date(Date.now() - 25 * 60_000)} WHERE "id"=${c.id}`;
    const session = await prisma.liveVoiceSession.create({ data: { channelId: c.id, startedAt: new Date(Date.now() - 24 * 60_000),
      endedAt: new Date(Date.now() - 23 * 60_000), endedReason: "channel_ended", transcript: "Клиент: умею монтировать" } });
    try {
      await runRecruitmentCommunicationTick();
      expect((await row(c.id)).status).toBe("COMPLETED");
      expect((await recruitmentContactOptions(c.app, actorId)).recentDeliveries[0].result?.transcript).toEqual(["Клиент: умею монтировать"]);
    } finally { await prisma.liveVoiceSession.delete({ where: { id: session.id } }); }
  });
  it("requires an explicit staff vacancy for a historical application and never invents a customer inquiry or BOT action", async () => {
    const c = await legacyCandidate(false);
    expect((await recruitmentContactOptions(c.app, actorId)).sms).toMatchObject({ available: false });
    await expect(previewRecruitmentContact(c.app, actorId, invite())).rejects.toThrow("Выберите вакансию");
    await prisma.$executeRaw`UPDATE "JobApplication" SET "hrPositionKey"=${key},"updatedAt"=now() WHERE "id"=${c.app}`;
    const inquiries = await prisma.customerInquiry.count(), actions = await prisma.customerAction.count();
    const preview = await previewRecruitmentContact(c.app, actorId, invite());
    const confirmed = await confirmRecruitmentContact(c.app, actorId, { previewId: preview.previewId, idempotencyKey: randomUUID() });
    expect((await row(confirmed.deliveries[0].id)).snapshotJson).toMatchObject({ sourceKind: "LEGACY_HR", fence: null });
    await dispatchRecruitmentCommunication(confirmed.deliveries[0].id);
    expect(sms).toHaveBeenCalledTimes(1);
    expect(await prisma.customerInquiry.count()).toBe(inquiries); expect(await prisma.customerAction.count()).toBe(actions);
    expect(await prisma.jobApplication.findUnique({ where: { id: c.app } })).toMatchObject({ customerInquiryId: null, customerPositionKey: null, hrPositionKey: key, status: "INTERVIEW" });
  });
  it("holds historical opt-outs and pauses, and rejects a changed native peer before contact", async () => {
    const optedOut = await legacyCandidate();
    await prisma.botConversation.update({ where: { id: optedOut.native }, data: { optedOutAt: new Date() } });
    await expect(previewRecruitmentContact(optedOut.app, actorId, invite())).rejects.toThrow("приостановлена");
    const paused = await legacyCandidate(), p = await previewRecruitmentContact(paused.app, actorId, invite());
    await prisma.botConversation.update({ where: { id: paused.native }, data: { pausedUntil: new Date(Date.now() + 3600_000) } });
    await expect(confirmRecruitmentContact(paused.app, actorId, { previewId: p.previewId, idempotencyKey: randomUUID() })).rejects.toThrow("приостановлена");
    const changed = await legacyCandidate(), preview = await previewRecruitmentContact(changed.app, actorId, invite());
    await prisma.botConversation.update({ where: { id: changed.native }, data: { subscriberId: `different-synthetic-${randomUUID()}` } });
    await expect(confirmRecruitmentContact(changed.app, actorId, { previewId: preview.previewId, idempotencyKey: randomUUID() })).rejects.toThrow("устарел");
    expect(sms).not.toHaveBeenCalled();
  });
  it("does not ask again for known historical age, study, work and experience fields", async () => {
    const c = await legacyCandidate();
    const position = await prisma.recruitmentPosition.findUniqueOrThrow({ where: { key } });
    try {
      await prisma.recruitmentPosition.update({ where: { key }, data: { screeningRules: { version: 1, minimumAge: null, allowStudying: true,
        allowOtherEmployment: true, requiredFacts: ["name", "phone", "age", "studyingNow", "employedNow", "experience"] } } });
      await prisma.jobApplication.update({ where: { id: c.app }, data: { age: 32, studyingNow: false, employedNow: false, experience: "Монтаж" } });
      expect((await recruitmentContactOptions(c.app, actorId)).clarification.available).toBe(false);
      await expect(previewRecruitmentContact(c.app, actorId, { purpose: "CLARIFY", channels: ["SMS"], language: "ru" })).rejects.toThrow("уже заполнены");
    } finally { await prisma.$executeRaw`UPDATE "RecruitmentPosition" SET "screeningRules"=${JSON.stringify(position.screeningRules)}::jsonb WHERE "key"=${key}`; }
  });
  it("does not expose communication results when the linked client is no longer accessible", async () => {
    const client = await prisma.client.create({ data: { fullName: marker, phone: `synthetic-client-${randomUUID()}`, source: "WHATSAPP" } });
    const candidates = [await candidate(), await legacyCandidate()];
    try {
      for (const c of candidates) {
        const preview = await previewRecruitmentContact(c.app, actorId, invite());
        await confirmRecruitmentContact(c.app, actorId, { previewId: preview.previewId, idempotencyKey: randomUUID() });
        await prisma.botConversation.update({ where: { id: c.native }, data: { clientId: client.id } });
      }
      await prisma.agent.update({ where: { id: actorId }, data: { role: "AGENT", permissions: { granted: ["vacancies.view"], revoked: ["clients.viewAll"] } } });
      for (const c of candidates) await expect(recruitmentContactOptions(c.app, actorId)).rejects.toMatchObject({ status: 403 });
      expect(sms).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
    } finally {
      await prisma.agent.update({ where: { id: actorId }, data: { role: "DIRECTOR", permissions: { granted: [], revoked: [] } } });
      await prisma.botConversation.updateMany({ where: { id: { in: candidates.map(c => c.native) } }, data: { clientId: null } });
      await prisma.client.delete({ where: { id: client.id } });
    }
  });
  it("invalidates a preview when the configured office changes", async () => {
    const c = await candidate(), preview = await previewRecruitmentContact(c.app, actorId, invite());
    const office = (await readSettings()).interviewInviteAddress;
    try {
      await prisma.settings.update({ where: { id: "singleton" }, data: { interviewInviteAddress: "Другой синтетический офис" } });
      await expect(confirmRecruitmentContact(c.app, actorId, { previewId: preview.previewId, idempotencyKey: randomUUID() })).rejects.toThrow("устарел");
      expect(sms).not.toHaveBeenCalled();
    } finally { await prisma.settings.update({ where: { id: "singleton" }, data: { interviewInviteAddress: office } }); }
  });
  it("uses the core language without an old contact profile and leaves an unknown legacy language explicit", async () => {
    const core = await candidate();
    await prisma.customerInquiry.update({ where: { id: core.inquiry }, data: { publicState: { language: "tg", topic: "job", openQuestion: "none", jobPositionKey: key } } });
    expect((await recruitmentContactOptions(core.app, actorId)).language).toBe("tg");
    const legacy = await legacyCandidate();
    expect((await recruitmentContactOptions(legacy.app, actorId)).language).toBeNull();
  });
});
