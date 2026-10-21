import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { encryptSecret } from "../src/crypto.js";
import { recruitmentRecoveryHash } from "../src/ai/recruitmentRecoveryReply.js";
import { isOwnCustomerOutboxEcho } from "../src/lib/customerOutboxEcho.js";

const state = vi.hoisted(() => ({ native: null as any, recovery: null as any, query: vi.fn() }));
vi.mock("../src/db.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/db.js")>();
  return { ...original, prisma: { ...original.prisma,
    $disconnect: () => original.prisma.$disconnect(),
    botConversation: { findUnique: async () => state.native },
    customerOutboxPart: { findMany: async () => [] },
    recruitmentRecovery: { findMany: (...args: any[]) => state.query(...args) },
  } };
});
const text = "Сейчас открыта вакансия SMM / видеографа. Можно прислать резюме или рассказать о своём опыте.";
beforeEach(() => {
  const id = randomUUID(), scope = randomUUID(), account = randomUUID();
  state.native = { channel: "INSTAGRAM", accountId: account, endpointScopeId: scope, subscriberId: "synthetic-candidate" };
  state.recovery = { id: randomUUID(), originalConversationId: id, conversationId: id, endpointScopeId: scope,
    status: "IN_FLIGHT", attemptAt: new Date(Date.now() - 1000), finishedAt: null, providerMid: null,
    payloadEncrypted: encryptSecret(text), payloadHash: recruitmentRecoveryHash({ text }),
    transportJson: { channel: "INSTAGRAM", accountId: account, endpointScopeId: scope, transportKey: `messenger-account:${account}`, scopeRevision: "1", subscriberId: "synthetic-candidate" },
    fenceJson: { inquiryId: randomUUID(), nativeId: id, endpoint: { endpointScopeId: scope, channel: "INSTAGRAM", accountId: account,
      peerId: "synthetic-candidate", threadId: "" }, stateRevision: "1", intentRevision: "1", ownershipEpoch: "0", bindingRevision: "1",
      scopeRevision: "1", policyRevision: "1", ownerToken: null } };
  state.query.mockReset().mockImplementation(async () => [state.recovery]);
});
function echo() { return { conversationId: state.recovery.conversationId, accountId: state.native.accountId,
  channel: "INSTAGRAM", peer: state.native.subscriberId, text, messageId: "synthetic-recovery-mid" }; }

it("recognizes recovery text while Meta echo precedes the acceptance receipt and native projection", async () => {
  expect(await isOwnCustomerOutboxEcho(echo())).toBe(true);
});
it("recognizes a completed recovery by its exact scoped provider receipt", async () => {
  Object.assign(state.recovery, { status: "ACCEPTED", providerMid: echo().messageId, finishedAt: new Date() });
  expect(await isOwnCustomerOutboxEcho({ ...echo(), text: "" })).toBe(true);
});
it.each(["READY", "UNKNOWN", "SUPPRESSED"])("never infers own delivery from recovery status %s", async status => {
  state.recovery.status = status;
  expect(await isOwnCustomerOutboxEcho(echo())).toBe(false);
});
it.each(["account", "scope", "peer", "channel", "native", "transport", "transport-peer", "missing-peer", "extra-field", "hash", "ciphertext", "expired", "future", "partial-text"])(
  "preserves manual-echo handling when recovery proof differs: %s", async changed => {
    const input = echo();
    if (changed === "account") state.recovery.fenceJson.endpoint.accountId = randomUUID();
    if (changed === "scope") state.recovery.endpointScopeId = randomUUID();
    if (changed === "peer") state.recovery.fenceJson.endpoint.peerId = "other-peer";
    if (changed === "channel") state.recovery.transportJson.channel = "FACEBOOK";
    if (changed === "native") state.recovery.originalConversationId = randomUUID();
    if (changed === "transport") state.recovery.transportJson.scopeRevision = "2";
    if (changed === "transport-peer") state.recovery.transportJson.subscriberId = "other-peer";
    if (changed === "missing-peer") delete state.recovery.transportJson.subscriberId;
    if (changed === "extra-field") state.recovery.transportJson.untrustedExtra = "not-allowed";
    if (changed === "hash") state.recovery.payloadHash = "0".repeat(64);
    if (changed === "ciphertext") state.recovery.payloadEncrypted = "invalid-encrypted-text";
    if (changed === "expired") state.recovery.attemptAt = new Date(Date.now() - 121_000);
    if (changed === "future") state.recovery.attemptAt = new Date(Date.now() + 60_000);
    if (changed === "partial-text") input.text = "Можно прислать резюме";
    expect(await isOwnCustomerOutboxEcho(input)).toBe(false);
  });
it("leaves an actual different staff message and unavailable proof to normal ownership handling", async () => {
  expect(await isOwnCustomerOutboxEcho({ ...echo(), text: "Я сотрудник и отвечаю лично" })).toBe(false);
  state.query.mockRejectedValue(new Error("synthetic database unavailable"));
  expect(await isOwnCustomerOutboxEcho(echo())).toBe(false);
});
