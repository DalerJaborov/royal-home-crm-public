import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { ensureConversationId, processMessengerTurn } from "../src/messengers/conversation.js";
import { admitCustomerPropertyInput } from "../src/lib/customerPropertyAdmission.js";
import { loadCustomerTransportForConversation } from "../src/lib/customerConversationScope.js";
import { loadCustomerStateSnapshot, issueCustomerWriteAuthority } from "../src/lib/customerState.js";
import { loadPublicCustomerPrincipal } from "../src/lib/customerPrincipal.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";

const fake = vi.hoisted(() => ({ callAi: vi.fn(), fetch: vi.fn(async () => { throw new Error("External fetch forbidden in archive test"); }) }));
vi.mock("../src/ai/client.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/ai/client.js")>(), callAiText: fake.callAi,
}));
const prefix = `UC_ARCHIVE_${randomUUID()}`, peers: string[] = [];
function peer(suffix: string) { const value = `${prefix}-${suffix}`; peers.push(value); return value; }
beforeAll(() => { vi.stubGlobal("fetch", fake.fetch); });
afterAll(async () => {
  await drainBackgroundTasks(2000);
  const rows = await prisma.botConversation.findMany({ where: { channel: "YOUTUBE", subscriberId: { in: peers } },
    select: { id: true, contactProfileId: true } });
  await prisma.customerInquiry.deleteMany({ where: { conversationId: { in: rows.map(row => row.id) } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: rows.map(row => row.id) } } });
  await prisma.contactProfile.deleteMany({ where: { id: { in: rows.flatMap(row => row.contactProfileId ? [row.contactProfileId] : []) },
    clientId: null, mergedIntoId: null, botConversations: { none: {} }, telegramConversations: { none: {} },
    telegramDirectConversations: { none: {} }, incomingCalls: { none: {} }, jobApplications: { none: {} },
    mergedFrom: { none: {} }, linkCandidatesLeft: { none: {} }, linkCandidatesRight: { none: {} },
    mergesIn: { none: {} }, mergesOut: { none: {} },
  } });
  expect(fake.callAi).not.toHaveBeenCalled(); expect(fake.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("YouTube comment dossier remains archival-only, not a customer transport", () => {
  it("creates the actual YT dossier/identity while all customer authorities stay unavailable", async () => {
    const authorId = peer("create"), id = await ensureConversationId("YOUTUBE", authorId, "synthetic YouTube author");
    const row = await prisma.botConversation.findUniqueOrThrow({ where: { id }, include: { endpointScope: true, customerInquiry: true } });
    expect(row.channel).toBe("YOUTUBE"); expect(row.accountId).toBeNull(); expect(row.clientId).toBeNull();
    expect(row.contactProfileId).toBeTruthy(); expect(row.endpointScope?.kind).toBe("LEGACY_UNKNOWN");
    expect(await prisma.contactIdentity.findFirst({ where: { profileId: row.contactProfileId!, kind: "YT_CHANNEL_ID", value: authorId } })).toBeTruthy();
    expect(row.customerInquiry?.ownerMode).toBe("HOLD");
    expect(await loadCustomerTransportForConversation(id)).toBeNull();
    expect(await loadCustomerStateSnapshot({ conversationId: id })).toBeNull();
    expect(await admitCustomerPropertyInput({ channel: "YOUTUBE", peer: authorId, eventKind: "message", eventId: "synthetic-yt-comment", evidence: [] }))
      .toEqual({ status: "denied", reason: "invalid_input" });
    expect(await loadPublicCustomerPrincipal({ admission: { channel: "YOUTUBE", conversationId: id }, visibility: "private_dm", authenticatedInput: {} }))
      .toEqual({ status: "denied", reason: "invalid_context" });
    expect(await issueCustomerWriteAuthority({} as never, {} as never, "contact", prisma)).toBeNull();
    expect(await prisma.customerPropertyIngressTicket.count({ where: { conversationId: id } })).toBe(0);
    expect(await prisma.customerAction.count({ where: { inquiryId: row.customerInquiry!.id } })).toBe(0);
  });
  it("preserves archival messages/draft and creates only one row on repeated concurrent comments", async () => {
    const authorId = peer("repeat"), id = await ensureConversationId("YOUTUBE", authorId, "first name");
    const messages = [{ role: "user", content: "synthetic archived public comment" }], draft = { stage: "chatting", notes: "ARCHIVE_ONLY" };
    await prisma.botConversation.update({ where: { id }, data: { messages, leadDraft: draft } });
    const ids = await Promise.all([ensureConversationId("YOUTUBE", authorId, "updated name"), ensureConversationId("YOUTUBE", authorId)]);
    expect(ids).toEqual([id, id]);
    const row = await prisma.botConversation.findUniqueOrThrow({ where: { id } });
    expect(row.messages).toEqual(messages); expect(row.leadDraft).toEqual(draft);
    expect(await prisma.botConversation.count({ where: { channel: "YOUTUBE", subscriberId: authorId } })).toBe(1);
  });
  it("does not let a Meta account/guessed binding turn YouTube archival input into authority", async () => {
    const authorId = peer("forged");
    await expect(ensureConversationId("YOUTUBE", authorId, undefined, randomUUID())).rejects.toThrow("scope_unknown");
    await expect(ensureConversationId("YOUTUBE", authorId, undefined, null, true)).rejects.toThrow("scope_unknown");
    await expect(ensureConversationId("YOUTUBE", "")).rejects.toThrow("scope_unknown");
    await expect(ensureConversationId("YOUTUBE", "x".repeat(513))).rejects.toThrow("scope_unknown");
    expect(await prisma.botConversation.count({ where: { channel: "YOUTUBE", subscriberId: authorId } })).toBe(0);
  });
  it("keeps unsupported chat turns and unknown Instagram accounts fail-closed", async () => {
    const authorId = peer("no-chat");
    expect(await processMessengerTurn({ channel: "YOUTUBE", subscriberId: authorId, text: "public comment" }))
      .toMatchObject({ reply: "", ready: false, accepted: false, shouldReply: false, silenced: "held" });
    await expect(ensureConversationId("INSTAGRAM", `${prefix}-unknown-ig`)).rejects.toThrow("account_unknown");
    expect(await prisma.botConversation.count({ where: { subscriberId: { in: [authorId, `${prefix}-unknown-ig`] } } })).toBe(0);
  });
});
