import { createHmac, randomUUID } from "node:crypto";
import { prisma } from "../../src/db.js";
import { encryptSecret } from "../../src/crypto.js";
import { resetAccountsCache } from "../../src/messengers/accounts.js";
import { resetMetaAccountCredsCache } from "../../src/messengers/meta.js";
import { ensureCustomerEndpoint, ensureScopedBotConversation } from "../../src/lib/customerConversationScope.js";
import { drainBackgroundTasks } from "../../src/lib/shutdownState.js";

/** Actual configured routing only, never customer proof/private permissions.
 * A scope is created without a native conversation so first-IN tests stay real. */
export async function createCustomerMessengerFixture(channel: "INSTAGRAM" | "FACEBOOK" | "WHATSAPP") {
  const id = randomUUID(), externalId = `test-${channel}-${id}`, token = `synthetic-token-${id}`, appSecret = `synthetic-app-secret-${id}`;
  await prisma.messengerAccount.create({ data: {
    id, channel, externalId, title: `Fixture ${id}`, token: encryptSecret(token), appSecret: encryptSecret(appSecret), enabled: true,
  } });
  resetAccountsCache();
  resetMetaAccountCredsCache();
  const endpoint = await prisma.$transaction(tx => ensureCustomerEndpoint(tx, {
    channel, subscriberId: `scope-probe-${id}`, accountId: id, accountExternalId: externalId,
  }));
  const { subscriberId: _probe, ...transport } = endpoint;
  const peers = new Set<string>(), profileIds = new Set<string>();
  const identityKind = channel === "INSTAGRAM" ? "IG_ID" : channel === "FACEBOOK" ? "FB_PSID" : "WA_ID";
  async function cleanupConversations() {
    await drainBackgroundTasks(2000);
    const natives = await prisma.botConversation.findMany({ where: { endpointScopeId: transport.endpointScopeId },
      select: { id: true, contactProfileId: true } });
    const nativeIds = natives.map(row => row.id);
    for (const row of natives) if (row.contactProfileId) profileIds.add(row.contactProfileId);
    await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: nativeIds.map(nativeId => `ai-reply-retry:${nativeId}`) } } });
    await prisma.botConversation.deleteMany({ where: { id: { in: nativeIds } } });
    // Native deletion tombstones Inquiry instead of deleting it.
    await prisma.customerInquiry.deleteMany({ where: { endpointScopeId: transport.endpointScopeId } });
    await prisma.outboundShieldState.deleteMany({ where: { endpointScopeId: transport.endpointScopeId } });
    // A pointer from our native is not ownership of a shared dossier. Only an
    // explicitly captured channel/peer identity set qualifies; extra PHONE or
    // other-channel identities preserve the profile even after Client unlink.
    const ownedIdentity = { kind: identityKind, value: { in: [...peers] } };
    await prisma.contactProfile.deleteMany({ where: { id: { in: [...profileIds] }, clientId: null, mergedIntoId: null,
      identities: { some: ownedIdentity, every: ownedIdentity },
      botConversations: { none: {} }, telegramConversations: { none: {} }, telegramDirectConversations: { none: {} },
      incomingCalls: { none: {} }, jobApplications: { none: {} }, mergedFrom: { none: {} },
      linkCandidatesLeft: { none: {} }, linkCandidatesRight: { none: {} }, mergesIn: { none: {} }, mergesOut: { none: {} },
    } });
  }
  return {
    id, externalId, token, transport,
    sign(body: unknown) {
      return `sha256=${createHmac("sha256", appSecret).update(Buffer.from(JSON.stringify(body))).digest("hex")}`;
    },
    turnInput(subscriberId: string) {
      peers.add(subscriberId);
      return { channel, subscriberId, accountExternalId: externalId, customerTransport: transport };
    },
    async ensureConversation(subscriberId: string) {
      peers.add(subscriberId);
      return prisma.$transaction(tx => ensureScopedBotConversation(tx, { channel, subscriberId, transport }));
    },
    cleanupConversations,
    async dispose() {
      await cleanupConversations();
      // Dedicated UUID-account scope created by this fixture, never a shared
      // WEBSITE/Settings namespace. P11 intentionally retains native tombstones.
      await prisma.customerPropertyIngressTicket.deleteMany({ where: { endpointScopeId: transport.endpointScopeId } });
      await prisma.propertyExposure.deleteMany({ where: { endpointScopeId: transport.endpointScopeId } });
      await prisma.shownProperty.deleteMany({ where: { endpointScopeId: transport.endpointScopeId } });
      await prisma.customerEndpointScope.delete({ where: { id: transport.endpointScopeId } });
      await prisma.messengerAccount.delete({ where: { id } });
      resetAccountsCache();
      resetMetaAccountCredsCache();
    },
  };
}

export type CustomerMessengerFixture = Awaited<ReturnType<typeof createCustomerMessengerFixture>>;
