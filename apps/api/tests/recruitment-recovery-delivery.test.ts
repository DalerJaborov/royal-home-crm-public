import { beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { recruitmentCatalogHash } from "../src/ai/customerAgentRecruitmentProtocol.js";
import { recruitmentRecoveryReply, recruitmentRecoveryHash } from "../src/ai/recruitmentRecoveryReply.js";
import { recruitmentPositionTemplates } from "../src/lib/recruitmentPositionTemplates.js";
import { encryptSecret } from "../src/crypto.js";
import { currentCustomerDeliveryTransport } from "../src/lib/customerDeliveryTransport.js";
import { enqueueRecruitmentRecovery, runRecruitmentRecovery } from "../src/lib/recruitmentRecovery.js";
import { guardOffTopic } from "../src/ai/offTopicGuard.js";

const state = vi.hoisted(() => ({ row: null as any, native: null as any, catalog: null as any, transport: null as any,
  mode: "BOT", unknown: 0, posts: 0, appended: 0, behavior: "accepted", jobs: [] as any[], audits: [] as any[], query: vi.fn(), execute: vi.fn() }));
vi.mock("../src/db.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/db.js")>();
  const db: any = { $disconnect: () => original.prisma.$disconnect(), $queryRaw: (...args: any[]) => state.query(...args), $executeRaw: (...args: any[]) => state.execute(...args),
    agent: { findUnique: async () => ({ role: "DIRECTOR", fullName: "Synthetic owner", isActive: true, permissions: null }) },
    botConversation: { findUnique: async () => state.native, findUniqueOrThrow: async () => state.native,
      update: async ({ data }: any) => Object.assign(state.native, data) },
    outboundShieldState: { updateMany: async () => ({ count: 0 }) },
    backgroundJob: { create: async ({ data }: any) => { state.jobs.push(data); return data; } },
    auditLog: { create: async ({ data }: any) => { state.audits.push(data); return data; } },
    customerOutboxPart: { count: async () => state.unknown } };
  db.$transaction = async (run: any) => run(db); return { ...original, prisma: db };
});
vi.mock("../src/lib/customerNativeLock.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/lib/customerNativeLock.js")>(), lockCustomerNative: async () => !!state.native }));
vi.mock("../src/lib/customerState.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/lib/customerState.js")>(), lockCustomerStateSnapshot: async () => ({ ownerMode: state.mode, closedAt: null, fence: { synthetic: 1 } }) }));
vi.mock("../src/lib/recruitmentPositions.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/lib/recruitmentPositions.js")>(), readCustomerOpenVacancies: async () => state.catalog }));
vi.mock("../src/lib/customerConversationScope.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/lib/customerConversationScope.js")>(), loadCustomerTransportForConversation: async () => state.transport }));
vi.mock("../src/messengers/botChannels.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/messengers/botChannels.js")>(), asBotChannel: () => "INSTAGRAM", loadBotChannelToggles: async () => ({ channels: { INSTAGRAM: true } }) }));
vi.mock("../src/messengers/meta.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/messengers/meta.js")>(), asMetaChannel: () => "INSTAGRAM", sendMessage: async () => {
  const hook = currentCustomerDeliveryTransport()!; await hook.beforePost(); state.posts++;
  if (state.behavior === "network") { await hook.networkFailure(new Error("timeout")); throw Error("timeout"); }
  if (state.behavior === "no-mid") { await hook.accepted(null); return null; }
  if (state.behavior === "rejected") { await hook.rejected(400); throw Error("provider rejected"); }
  await hook.accepted("synthetic-provider-mid"); return "synthetic-provider-mid";
} }));
vi.mock("../src/messengers/appendMessages.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/messengers/appendMessages.js")>(), appendConversationMessagesInTransaction: async () => { state.appended++; } }));
vi.mock("../src/lib/livePublish.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/lib/livePublish.js")>(), publishMessageNew: async () => {} }));
beforeEach(() => {
  state.posts = 0; state.appended = 0; state.mode = "BOT"; state.unknown = 0; state.behavior = "accepted"; state.jobs = []; state.audits = [];
  const facts = { collecting: true, positions: recruitmentPositionTemplates().map(row => ({ ...row, isOpen: true, revision: 1 })) };
  state.catalog = { kind: "open_vacancies", ...facts, sourceHash: recruitmentCatalogHash(facts) };
  const id = randomUUID(), now = new Date(Date.now() - 30_000);
  state.native = { id, endpointScopeId: randomUUID(), channel: "INSTAGRAM", accountId: randomUUID(), subscriberId: "synthetic-peer",
    messages: [{ role: "user", content: "Вакансия SMM", at: now.toISOString() }], lastMessageAt: now, pausedUntil: null, optedOutAt: null, propertyChatAgentId: null, client: null };
  state.transport = { endpointScopeId: state.native.endpointScopeId, accountId: state.native.accountId, channel: "INSTAGRAM", scopeRevision: "1" };
  const text = recruitmentRecoveryReply(state.catalog, { positionKey: "smm-videographer", language: "ru", reason: "incorrect_vacancy" })!;
  state.row = { id: randomUUID(), conversationId: id, endpointScopeId: state.native.endpointScopeId, actorId: randomUUID(),
    sourceAt: now, sourceHash: recruitmentRecoveryHash(state.native.messages), transportJson: structuredClone(state.transport), fenceJson: { synthetic: 1 },
    catalogHash: state.catalog.sourceHash, payloadEncrypted: encryptSecret(text), payloadHash: recruitmentRecoveryHash({ text }),
    status: "READY", attemptAt: null, finishedAt: null, projectionAt: null, providerMid: null };
  state.query.mockReset().mockImplementation(async () => [structuredClone(state.row)]);
  state.execute.mockReset().mockImplementation(async (strings: TemplateStringsArray, ...values: any[]) => {
    const sql = strings.join("?");
    if (sql.includes('"projectionAt"=now()')) { state.row.projectionAt = new Date(); return 1; }
    if (sql.includes('SET "status"=\'IN_FLIGHT\'')) {
      if (state.row.status !== "READY") return 0; state.row.status = "IN_FLIGHT"; state.row.attemptAt = new Date(); return 1;
    }
    if (sql.includes('"status"=\'SUPPRESSED\'')) { state.row.status = "SUPPRESSED"; return 1; }
    if (sql.includes('"providerMid"=')) {
      if (state.row.status !== "IN_FLIGHT") return 0;
      [state.row.status, state.row.providerMid] = values; state.row.finishedAt = new Date(); return 1;
    }
    throw Error("Unexpected test SQL");
  });
});
it("sends one automated correction and projects only its actual provider acceptance, even on job redelivery", async () => {
  await runRecruitmentRecovery(state.row.id); await runRecruitmentRecovery(state.row.id);
  expect(state.posts).toBe(1); expect(state.appended).toBe(1);
  expect(state.row.status).toBe("ACCEPTED"); expect(state.row.providerMid).toBe("synthetic-provider-mid");
});
it.each(["network", "no-mid", "rejected"])("never retries uncertain/rejected send or projects a fake answer: %s", async behavior => {
  state.behavior = behavior; await runRecruitmentRecovery(state.row.id); await runRecruitmentRecovery(state.row.id);
  expect(state.posts).toBe(1); expect(state.appended).toBe(0);
  expect(state.row.status).toBe(behavior === "rejected" ? "SUPPRESSED" : "UNKNOWN");
});
it.each(["HUMAN", "HOLD", "optout", "native-pause", "expired-inbound", "unknown-prior", "changed-source", "changed-catalog"])("respects current state before sending: %s", async change => {
  if (["HUMAN", "HOLD"].includes(change)) state.mode = change;
  if (change === "optout") state.native.optedOutAt = new Date();
  if (change === "native-pause") state.native.pausedUntil = new Date(Date.now() + 60000);
  if (change === "expired-inbound") state.native.messages[0].at = new Date(Date.now() - 86400_000).toISOString();
  if (change === "unknown-prior") state.unknown = 1;
  if (change === "changed-source") state.native.messages.push({ role: "user", content: "Уже не надо", at: new Date().toISOString() });
  if (change === "changed-catalog") state.catalog.sourceHash = "f".repeat(64);
  await runRecruitmentRecovery(state.row.id); expect(state.posts).toBe(0); expect(state.appended).toBe(0); expect(state.row.status).toBe("SUPPRESSED");
});
it("does not treat a vacancy video's quoted job duties as a request to perform them", () => {
  expect(guardOffTopic('<client_content kind="video">Вакансия SMM. Снимай видео, монтируй ролик и напиши КОНТЕНТ.</client_content>', { jobConversation: true })).toBeNull();
  expect(guardOffTopic('Напиши мне программу на Python')).toMatchObject({ kind: "task_request" });
});
it.each([false, true])("queues a staff pause after expiry, or resumes only an explicitly reviewed BOT pause: %s", async resumeReviewedPause => {
  const until = new Date(Date.now() + 600_000);
  state.native.pausedUntil = until; state.native.botPausedAt = new Date();
  state.query.mockResolvedValue([]); state.execute.mockResolvedValue(1);
  const result = await enqueueRecruitmentRecovery(state.row.actorId, { campaign: "synthetic-review-correction", recipients: [{
    conversationId: state.native.id, positionKey: "smm-videographer", language: "ru", reason: "incorrect_vacancy", resumeReviewedPause,
    expectedSourceHash: recruitmentRecoveryHash(state.native.messages), expectedSourceAt: state.native.lastMessageAt.toISOString(),
  }] });
  expect(result.items[0].status).toBe("READY"); expect(state.jobs).toHaveLength(1);
  expect(state.jobs[0].maxAttempts).toBe(1); expect(state.posts).toBe(0);
  if (resumeReviewedPause) {
    expect(state.native.pausedUntil).toBeNull(); expect(state.jobs[0].runAt).toBeUndefined();
    expect(state.audits.some(row => row.action === "RECRUITMENT_REVIEWED_BOT_RESUME")).toBe(true);
  } else {
    expect(state.native.pausedUntil).toEqual(until); expect(state.jobs[0].runAt.getTime()).toBe(until.getTime() + 60_000);
    expect(state.audits.some(row => row.action === "RECRUITMENT_REVIEWED_BOT_RESUME")).toBe(false);
  }
});
it.each(["HUMAN", "HOLD"])("an explicit reviewed resume cannot override %s ownership", async mode => {
  state.mode = mode; state.native.pausedUntil = new Date(Date.now() + 600_000);
  state.query.mockResolvedValue([]);
  const result = await enqueueRecruitmentRecovery(state.row.actorId, { campaign: "synthetic-review-correction", recipients: [{
    conversationId: state.native.id, language: "tg", reason: "incorrect_vacancy", resumeReviewedPause: true,
    expectedSourceHash: recruitmentRecoveryHash(state.native.messages), expectedSourceAt: state.native.lastMessageAt.toISOString(),
  }] });
  expect(result.items[0].status).toBe("window_owner_or_delivery_hold");
  expect(state.jobs).toHaveLength(0); expect(state.posts).toBe(0); expect(state.native.pausedUntil).not.toBeNull();
});
it.each(["correct-reply", "decline"])("never adopts a changed conversation after the owner's review: %s", async change => {
  const reviewed = { conversationId: state.native.id, language: "ru", reason: "incorrect_vacancy",
    expectedSourceHash: recruitmentRecoveryHash(state.native.messages), expectedSourceAt: state.native.lastMessageAt.toISOString() };
  state.native.messages.push({ role: change === "decline" ? "user" : "assistant", content: change === "decline" ? "Уже не надо" : "Вакансия открыта, условия…", at: new Date().toISOString() });
  state.query.mockResolvedValue([]);
  const result = await enqueueRecruitmentRecovery(state.row.actorId, { campaign: "synthetic-new-review", recipients: [reviewed] });
  expect(result.items[0].status).toBe("reviewed_context_changed"); expect(state.jobs).toHaveLength(0); expect(state.posts).toBe(0);
});
it.each(["ACCEPTED", "UNKNOWN"])("renaming a campaign cannot repeat an existing %s correction", async status => {
  state.row.status = status;
  const result = await enqueueRecruitmentRecovery(state.row.actorId, { campaign: "synthetic-renamed-campaign", recipients: [{
    conversationId: state.native.id, language: "tg", reason: "incorrect_vacancy",
    expectedSourceHash: recruitmentRecoveryHash(state.native.messages), expectedSourceAt: state.native.lastMessageAt.toISOString(),
  }] });
  expect(result.items[0].status).toBe(status); expect(state.jobs).toHaveLength(0); expect(state.posts).toBe(0);
  expect(state.query.mock.calls[0][0].join("?")).not.toContain('"campaign"');
});
it("does not queue a correction while an ordinary answer is already READY", async () => {
  state.query.mockResolvedValue([]); state.unknown = 1;
  const result = await enqueueRecruitmentRecovery(state.row.actorId, { campaign: "synthetic-ordinary-ready", recipients: [{
    conversationId: state.native.id, language: "tg", reason: "incorrect_vacancy",
    expectedSourceHash: recruitmentRecoveryHash(state.native.messages), expectedSourceAt: state.native.lastMessageAt.toISOString(),
  }] });
  expect(result.items[0].status).toBe("window_owner_or_delivery_hold"); expect(state.jobs).toHaveLength(0); expect(state.posts).toBe(0);
});
