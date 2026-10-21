import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { prisma } from "../src/db.js";

it("retains immutable attempts/receipts, rejects false acceptance and does not prevent native deletion in real PostgreSQL", async () => {
  const rollback = new Error("synthetic-rollback-only");
  await expect(prisma.$transaction(async tx => {
    const scope = await tx.customerEndpointScope.create({ data: { realmKey: "synthetic-recovery-storage", channel: "INSTAGRAM", transportKey: randomUUID() } });
    const actor = await tx.agent.create({ data: { fullName: "Synthetic recovery actor", phone: `synthetic-${randomUUID()}`, role: "DIRECTOR" } });
    const native = await tx.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `synthetic-${randomUUID()}`, endpointScopeId: scope.id } });
    const id = randomUUID(), hash = "a".repeat(64);
    await tx.$executeRaw`INSERT INTO "RecruitmentRecovery" ("id","campaign","originalConversationId","conversationId","endpointScopeId","transportJson","fenceJson",
      "sourceHash","sourceAt","catalogHash","payloadEncrypted","payloadHash","actorId") VALUES (${id},'synthetic-test',${native.id},${native.id},${scope.id},'{}'::jsonb,
      NULL,${hash},now(),${hash},'synthetic-encrypted-only',${hash},${actor.id})`;
    const rejects = async (run: () => Promise<unknown>) => {
      await tx.$executeRawUnsafe("SAVEPOINT recovery_negative");
      await expect(run()).rejects.toThrow();
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT recovery_negative");
    };
    await rejects(() => tx.$executeRaw`INSERT INTO "RecruitmentRecovery" ("id","campaign","originalConversationId","conversationId","endpointScopeId","transportJson","fenceJson","sourceHash","sourceAt","catalogHash","payloadEncrypted","payloadHash","actorId") VALUES (${randomUUID()},'synthetic-other-campaign',${native.id},${native.id},${scope.id},'{}'::jsonb,NULL,${hash},now(),${hash},'synthetic-encrypted-only',${hash},${actor.id})`);
    await rejects(() => tx.$executeRaw`UPDATE "RecruitmentRecovery" SET "payloadEncrypted"='replacement' WHERE "id"=${id}`);
    await rejects(() => tx.$executeRaw`UPDATE "RecruitmentRecovery" SET "status"='ACCEPTED',"finishedAt"=now() WHERE "id"=${id}`);
    await tx.$executeRaw`UPDATE "RecruitmentRecovery" SET "status"='IN_FLIGHT',"attemptAt"=now() WHERE "id"=${id}`;
    await tx.$executeRaw`UPDATE "RecruitmentRecovery" SET "status"='UNKNOWN',"finishedAt"=now() WHERE "id"=${id}`;
    await rejects(() => tx.$executeRaw`UPDATE "RecruitmentRecovery" SET "status"='READY' WHERE "id"=${id}`);
    await rejects(() => tx.$executeRaw`UPDATE "RecruitmentRecovery" SET "attemptAt"=now()+interval '1 second' WHERE "id"=${id}`);
    await tx.botConversation.delete({ where: { id: native.id } });
    const [retained] = await tx.$queryRaw<Array<{ conversationId: string | null; originalConversationId: string; status: string }>>`
      SELECT "conversationId","originalConversationId","status" FROM "RecruitmentRecovery" WHERE "id"=${id}`;
    expect(retained).toEqual({ conversationId: null, originalConversationId: native.id, status: "UNKNOWN" });
    throw rollback;
  })).rejects.toBe(rollback);
});
