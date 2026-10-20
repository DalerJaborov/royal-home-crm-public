import { randomUUID } from "node:crypto";
import type { CustomerAgentRolloutConfig } from "@royal-home/shared";
import { prisma } from "../../src/db.js";
import { createCustomerAgentProviderSnapshot } from "../../src/ai/customerAgentProviderConfig.js";
import { registerCurrentCustomerAgentRevision } from "../../src/lib/customerAgentRegistration.js";
import { decodeCustomerAgentRevision } from "../../src/lib/customerAgentRevision.js";
import { ensureCustomerEndpoint } from "../../src/lib/customerConversationScope.js";
import { ensurePublicCommentInstallation } from "../../src/lib/customerPublicCommentStore.js";

/** Owned PG fixture grant: only real endpoint scopes created by this fixture enter the candidate cohort. */
export async function createCustomerRolloutFixture(registeredCandidateId?: string) {
  const savedPolicy = await prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" }, select: {
    contractVersion: true, rolloutMode: true, capabilities: true, activeAgentRevisionId: true,
  } });
  const [saved] = await prisma.$queryRaw<Array<{ rolloutConfig: unknown }>>`SELECT "rolloutConfig" FROM "CustomerRuntimePolicy" WHERE "id"='singleton'`;
  const stored = registeredCandidateId
    ? await prisma.customerAgentRevision.findUnique({ where: { id: registeredCandidateId }, select: { id: true, manifestJson: true } })
    : null;
  if (registeredCandidateId && !stored) throw new Error("Configured candidate is not registered");
  const revision = stored ? decodeCustomerAgentRevision(stored)
    : await registerCurrentCustomerAgentRevision(createCustomerAgentProviderSnapshot());
  const config: CustomerAgentRolloutConfig = { version: 1, cohortId: randomUUID(), candidateRevisionId: revision.id,
    percentBasisPoints: 10_000, allowed: [] };
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "scoped", rolloutMode: "ACTIVE",
    activeAgentRevisionId: revision.id } });
  await writeConfig(config);
  async function writeConfig(value: CustomerAgentRolloutConfig) {
    await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${JSON.stringify(value)}::jsonb WHERE "id"='singleton'`;
  }
  async function allow(surface: "dm" | "public_comment", channel: "INSTAGRAM" | "FACEBOOK", endpointScopeId: string) {
    const next = { ...config, allowed: [...config.allowed.filter(row => row.endpointScopeId !== endpointScopeId), { surface, channel, endpointScopeId }] };
    await writeConfig(next); config.allowed = next.allowed;
  }
  return {
    revision,
    async allowDm(input: { peer: string; accountId: string; accountExternalId: string; channel?: "INSTAGRAM" | "FACEBOOK" }) {
      const channel = input.channel ?? "INSTAGRAM";
      const endpoint = await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel, subscriberId: input.peer,
        accountId: input.accountId, accountExternalId: input.accountExternalId }));
      await allow("dm", channel, endpoint.endpointScopeId); return endpoint;
    },
    async allowPublic(channel: "INSTAGRAM" | "FACEBOOK", resource: string) {
      const stamp = await ensurePublicCommentInstallation(channel, resource);
      if (!stamp) throw new Error("Actual public endpoint scope unavailable");
      await allow("public_comment", channel, stamp.installation.id); return stamp;
    },
    async restore() {
      await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: savedPolicy });
      if (saved.rolloutConfig === null) await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=NULL WHERE "id"='singleton'`;
      else await prisma.$executeRaw`UPDATE "CustomerRuntimePolicy" SET "rolloutConfig"=${JSON.stringify(saved.rolloutConfig)}::jsonb WHERE "id"='singleton'`;
    },
  };
}
