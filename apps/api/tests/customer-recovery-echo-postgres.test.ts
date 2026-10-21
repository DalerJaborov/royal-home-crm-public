import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { recruitmentRecoveryHash } from "../src/ai/recruitmentRecoveryReply.js";
import { isOwnCustomerOutboxEcho } from "../src/lib/customerOutboxEcho.js";

it("reads actual durable recovery attempts before projection without treating READY, UNKNOWN or a different staff text as own echo", async () => {
  const rollback = new Error("synthetic-echo-rollback-only");
  await expect(prisma.$transaction(async tx => {
    const scope = await tx.customerEndpointScope.create({ data: { realmKey: "synthetic-recovery-echo", channel: "INSTAGRAM", transportKey: randomUUID() } });
    const actor = await tx.agent.create({ data: { fullName: "Synthetic echo actor", phone: `synthetic-${randomUUID()}`, role: "DIRECTOR" } });
    const native = await tx.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `synthetic-${randomUUID()}`, endpointScopeId: scope.id } });
    const id = randomUUID(), text = "Открыта вакансия видеографа. Резюме можно прислать в этом чате.";
    const fence = { inquiryId: randomUUID(), nativeId: native.id, endpoint: { endpointScopeId: scope.id, channel: "INSTAGRAM", accountId: null,
      peerId: native.subscriberId, threadId: "" }, stateRevision: "1", intentRevision: "1", ownershipEpoch: "0", bindingRevision: "1",
      scopeRevision: "1", policyRevision: "1", ownerToken: null };
    const transport = { endpointScopeId: scope.id, channel: "INSTAGRAM", accountId: null, transportKey: scope.transportKey, scopeRevision: "1", subscriberId: native.subscriberId };
    const hash = "a".repeat(64), cipher = encryptSecret(text), payloadHash = recruitmentRecoveryHash({ text });
    await tx.$executeRaw`INSERT INTO "RecruitmentRecovery" ("id","campaign","originalConversationId","conversationId","endpointScopeId","transportJson","fenceJson",
      "sourceHash","sourceAt","catalogHash","payloadEncrypted","payloadHash","actorId") VALUES (${id},'synthetic-echo',${native.id},${native.id},${scope.id},${JSON.stringify(transport)}::jsonb,
      ${JSON.stringify(fence)}::jsonb,${hash},now(),${hash},${cipher},${payloadHash},${actor.id})`;
    const input = { conversationId: native.id, accountId: null, channel: "INSTAGRAM", peer: native.subscriberId, text, messageId: "synthetic-stored-mid" };
    expect(await isOwnCustomerOutboxEcho(input, tx)).toBe(false);
    await tx.$executeRaw`UPDATE "RecruitmentRecovery" SET "status"='IN_FLIGHT',"attemptAt"=now() WHERE "id"=${id}`;
    expect(await isOwnCustomerOutboxEcho(input, tx)).toBe(true);
    expect(await isOwnCustomerOutboxEcho({ ...input, text: "Настоящий сотрудник отвечает иначе" }, tx)).toBe(false);
    expect((await tx.botConversation.findUniqueOrThrow({ where: { id: native.id } })).messages).toEqual([]);
    expect((await tx.botConversation.findUniqueOrThrow({ where: { id: native.id } })).pausedUntil).toBeNull();
    await tx.$executeRaw`UPDATE "RecruitmentRecovery" SET "status"='ACCEPTED',"providerMid"=${input.messageId},"finishedAt"=now() WHERE "id"=${id}`;
    expect(await isOwnCustomerOutboxEcho({ ...input, text: "" }, tx)).toBe(true);
    expect(await isOwnCustomerOutboxEcho({ ...input, messageId: "different-staff-mid" }, tx)).toBe(false);
    throw rollback;
  })).rejects.toBe(rollback);
});
