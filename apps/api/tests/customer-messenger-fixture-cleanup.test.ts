import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { ensureConversationId } from "../src/messengers/conversation.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

const fetchDenied = vi.fn(async () => { throw new Error("External I/O forbidden in fixture cleanup tests"); });
beforeEach(() => { fetchDenied.mockClear(); vi.stubGlobal("fetch", fetchDenied); });
afterEach(() => { vi.unstubAllGlobals(); });

async function withOwnedProfile(check: (fixture: CustomerMessengerFixture, profileId: string, peer: string,
  registerOwnedIdentity: (id: string) => void) => Promise<void>) {
  const fixture = await createCustomerMessengerFixture("INSTAGRAM");
  const peer = `fixture-cleanup-${randomUUID()}`;
  let profileId: string | null = null;
  const ownedIdentityIds: string[] = [];
  try {
    fixture.turnInput(peer); // Explicit synthetic-peer registration, no native/grant.
    expect(await prisma.contactIdentity.count({ where: { kind: "IG_ID", value: peer } })).toBe(0);
    const nativeId = await ensureConversationId("INSTAGRAM", peer, undefined, fixture.id);
    profileId = (await prisma.botConversation.findUniqueOrThrow({ where: { id: nativeId }, select: { contactProfileId: true } })).contactProfileId;
    expect(profileId).not.toBeNull();
    if (!profileId) throw new Error("Actual IG archive did not create its profile");
    const identities = await prisma.contactIdentity.findMany({ where: { profileId } });
    ownedIdentityIds.push(...identities.map(row => row.id));
    expect(identities.map(row => ({ kind: row.kind, value: row.value }))).toEqual([{ kind: "IG_ID", value: peer }]);
    await check(fixture, profileId, peer, id => ownedIdentityIds.push(id));
    expect(fetchDenied).not.toHaveBeenCalled();
  } finally {
    // Helper must preserve an extra identity. The test may remove only the
    // dossier it actually created, and only after every native reference is gone.
    await fixture.dispose();
    if (profileId) await prisma.contactProfile.deleteMany({ where: { id: profileId, clientId: null, mergedIntoId: null,
      identities: { every: { id: { in: ownedIdentityIds } } },
      botConversations: { none: {} }, telegramConversations: { none: {} }, telegramDirectConversations: { none: {} },
      incomingCalls: { none: {} }, jobApplications: { none: {} }, mergedFrom: { none: {} },
      linkCandidatesLeft: { none: {} }, linkCandidatesRight: { none: {} }, mergesIn: { none: {} }, mergesOut: { none: {} },
    } });
  }
}

describe("configured messenger fixture cleanup ownership", () => {
  it("removes its registered own-only IG profile and identity after native tombstoning", async () => {
    await withOwnedProfile(async (fixture, profileId, peer) => {
      await fixture.cleanupConversations();
      expect(await prisma.botConversation.count({ where: { endpointScopeId: fixture.transport.endpointScopeId } })).toBe(0);
      expect(await prisma.customerInquiry.count({ where: { endpointScopeId: fixture.transport.endpointScopeId } })).toBe(0);
      expect(await prisma.contactProfile.findUnique({ where: { id: profileId } })).toBeNull();
      expect(await prisma.contactIdentity.count({ where: { kind: "IG_ID", value: peer } })).toBe(0);
    });
  });

  it("preserves a captured profile and both identities when another channel identity exists", async () => {
    await withOwnedProfile(async (fixture, profileId, peer, registerOwnedIdentity) => {
      const foreign = await prisma.contactIdentity.create({ data: { profileId, kind: "FB_PSID", value: `foreign-${peer}`, trust: "PROFILE" } });
      registerOwnedIdentity(foreign.id);
      const before = await prisma.contactProfile.findUniqueOrThrow({ where: { id: profileId }, include: { identities: { orderBy: { id: "asc" } } } });
      await fixture.cleanupConversations();
      expect(await prisma.contactProfile.findUnique({ where: { id: profileId }, include: { identities: { orderBy: { id: "asc" } } } })).toEqual(before);
      expect(before.identities).toHaveLength(2);
      expect(await prisma.botConversation.count({ where: { endpointScopeId: fixture.transport.endpointScopeId } })).toBe(0);
      expect(await prisma.customerInquiry.count({ where: { endpointScopeId: fixture.transport.endpointScopeId } })).toBe(0);
    });
  });
});
