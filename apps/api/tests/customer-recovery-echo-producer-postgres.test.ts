import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { TxClient } from "../src/db.js";
import { prisma } from "../src/db.js";
import { encryptSecret, decryptSecret } from "../src/crypto.js";
import { recruitmentCatalogHash } from "../src/ai/customerAgentRecruitmentProtocol.js";
import { recruitmentRecoveryHash } from "../src/ai/recruitmentRecoveryReply.js";
import { recruitmentPositionTemplates } from "../src/lib/recruitmentPositionTemplates.js";
import { enqueueRecruitmentRecovery } from "../src/lib/recruitmentRecovery.js";
import { isOwnCustomerOutboxEcho } from "../src/lib/customerOutboxEcho.js";

// Only catalog/controller policy is synthetic. The installed account loader,
// enqueue serializer, PostgreSQL record and echo reader are the actual code.
// Route nested application transactions into one rolled-back stand fixture.
const state = vi.hoisted(() => ({ tx: null as TxClient | null, fence: null as any, catalog: null as any }));
vi.mock("../src/db.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/db.js")>();
  return { ...original, prisma: new Proxy(original.prisma, { get(target, key) {
    if (key === "$transaction" && state.tx) return (run: (tx: TxClient) => unknown) => run(state.tx!);
    const source = state.tx ?? target, value = Reflect.get(source, key);
    return typeof value === "function" ? value.bind(source) : value;
  } }) };
});
vi.mock("../src/lib/customerState.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/customerState.js")>(),
  lockCustomerStateSnapshot: async () => ({ ownerMode: "BOT", closedAt: null, fence: state.fence }),
}));
vi.mock("../src/lib/recruitmentPositions.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/recruitmentPositions.js")>(), readCustomerOpenVacancies: async () => state.catalog,
}));

it.each(["ACCEPTED", "UNKNOWN"])("reads actual loader → enqueue → stored scoped transport through %s", async outcome => {
  const rollback = new Error("synthetic-producer-rollback-only");
  let rolledBack = false;
  try {
    await prisma.$transaction(async tx => {
      state.tx = tx;
      const account = await tx.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId: `synthetic-${randomUUID()}`,
        title: "Synthetic recovery producer", token: encryptSecret("test-account-token") } });
      const scope = await tx.customerEndpointScope.create({ data: { realmKey: "royal-home", channel: "INSTAGRAM",
        kind: "NORMAL", scopeRevision: 1n, messengerAccountId: account.id, transportKey: `messenger-account:${account.id}` } });
      const actor = await tx.agent.create({ data: { fullName: "Synthetic recovery owner", phone: `synthetic-${randomUUID()}`, role: "DIRECTOR" } });
      const at = new Date(Date.now() - 30_000), messages = [{ role: "user", content: "Вакансия видеографа", at: at.toISOString() }];
      const native = await tx.botConversation.create({ data: { channel: "INSTAGRAM", accountId: account.id,
        subscriberId: `synthetic-${randomUUID()}`, endpointScopeId: scope.id, messages, lastMessageAt: at } });
      state.fence = { inquiryId: randomUUID(), nativeId: native.id, endpoint: { endpointScopeId: scope.id, channel: "INSTAGRAM",
        accountId: account.id, peerId: native.subscriberId, threadId: "" }, stateRevision: "1", intentRevision: "1", ownershipEpoch: "0",
        bindingRevision: "1", scopeRevision: "1", policyRevision: "1", ownerToken: null };
      const facts = { collecting: true, positions: recruitmentPositionTemplates().map(row => ({ ...row, isOpen: true, revision: 1 })) };
      state.catalog = { kind: "open_vacancies", ...facts, sourceHash: recruitmentCatalogHash(facts) };
      const result = await enqueueRecruitmentRecovery(actor.id, { campaign: `synthetic-${randomUUID()}`, recipients: [{
        conversationId: native.id, positionKey: "smm-videographer", language: "ru", reason: "incorrect_vacancy",
        expectedSourceHash: recruitmentRecoveryHash(native.messages), expectedSourceAt: native.lastMessageAt!.toISOString(),
      }] });
      expect(result.items).toEqual([expect.objectContaining({ status: "READY", conversationId: native.id })]);
      const id = result.items[0].id!;
      const row = await tx.recruitmentRecovery.findUniqueOrThrow({ where: { id } });
      expect(row.transportJson).toEqual({ endpointScopeId: scope.id, channel: "INSTAGRAM", accountId: account.id,
        accountExternalId: account.externalId, transportKey: scope.transportKey, scopeRevision: "1", subscriberId: native.subscriberId });
      const input = { conversationId: native.id, accountId: account.id, channel: "INSTAGRAM", peer: native.subscriberId,
        text: decryptSecret(row.payloadEncrypted), messageId: "synthetic-producer-mid" };
      expect(await isOwnCustomerOutboxEcho(input, tx)).toBe(false);
      await tx.$executeRaw`UPDATE "RecruitmentRecovery" SET "status"='IN_FLIGHT',"attemptAt"=now() WHERE "id"=${id}`;
      expect(await isOwnCustomerOutboxEcho(input, tx)).toBe(true);
      expect(await isOwnCustomerOutboxEcho({ ...input, text: "Настоящий сотрудник отвечает иначе" }, tx)).toBe(false);
      for (const changed of [{ ...input, peer: "different-peer" }, { ...input, accountId: randomUUID() },
        { ...input, conversationId: randomUUID() }, { ...input, channel: "FACEBOOK" }]) {
        expect(await isOwnCustomerOutboxEcho(changed, tx)).toBe(false);
      }
      const mid = outcome === "ACCEPTED" ? input.messageId : null;
      await tx.$executeRaw`UPDATE "RecruitmentRecovery" SET "status"=${outcome},"providerMid"=${mid},"finishedAt"=now() WHERE "id"=${id}`;
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86400_000);
      try {
        expect(await isOwnCustomerOutboxEcho({ ...input, text: "" }, tx)).toBe(outcome === "ACCEPTED");
        expect(await isOwnCustomerOutboxEcho({ ...input, messageId: undefined }, tx)).toBe(false);
        expect(await isOwnCustomerOutboxEcho({ ...input, messageId: "different-mid" }, tx)).toBe(false);
      } finally { clock.mockRestore(); }
      const unchanged = await tx.botConversation.findUniqueOrThrow({ where: { id: native.id } });
      expect(unchanged.messages).toEqual(messages); expect(unchanged.pausedUntil).toBeNull();
      throw rollback;
    }, { timeout: 20_000 });
  } catch (error) {
    if (error !== rollback) throw error;
    rolledBack = true;
  } finally { state.tx = null; }
  expect(rolledBack).toBe(true);
});
