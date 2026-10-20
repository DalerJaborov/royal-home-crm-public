import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { BotTurnTracePayload } from "@royal-home/shared";

// Complete DB-module replacement is intentional: this is a no-DB transport
// contract test. Importing the original would construct a pool/load dotenv.
const db = vi.hoisted(() => ({ $disconnect: vi.fn(async () => {}), $queryRaw: vi.fn(),
  settings: { findUnique: vi.fn() }, messengerAccount: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  processedMessage: { create: vi.fn() }, systemError: { create: vi.fn(), findFirst: vi.fn() } }));
vi.mock("../src/db.js", () => ({ prisma: db }));
import { parseIncoming, sendMessage, sendLocation, sendReaction, fetchInstagramProfile } from "../src/messengers/meta.js";
import { withCustomerDeliveryTransport } from "../src/lib/customerDeliveryTransport.js";
import * as shield from "../src/lib/outboundShield.js";
import { resetOutgoingMids } from "../src/messengers/outgoingMids.js";
import { withBotTurnTrace, traceOutcome } from "../src/lib/botTurnTrace.js";
import { encryptSecret } from "../src/crypto.js";
import type { CustomerTransportReference } from "../src/lib/customerConversationScope.js";

const KEY = "fictional-trace-key-only-for-unit-tests-0000";
const turn = { channel: "WHATSAPP", peer: "fake-peer", account: "fake-account", event: "fake-event" };
// Fictitious configured routing fixture, not a customer identity/write grant.
// Actual resolve/bind code validates these DB responses before the real POST.
const transport: CustomerTransportReference = { channel: "WHATSAPP", accountId: "fake-account",
  accountExternalId: "configured-trace-wa", endpointScopeId: "trace-scope", transportKey: "messenger-account:fake-account", scopeRevision: "0" };
function recorder(enabled = true) {
  const rows: BotTurnTracePayload[] = [];
  return { rows, config: { enabled, secret: KEY, text: false, write: (row: BotTurnTracePayload) => { rows.push(row); } } };
}
beforeEach(() => {
  vi.resetAllMocks(); resetOutgoingMids();
  db.settings.findUnique.mockResolvedValue(null); db.messengerAccount.findFirst.mockResolvedValue(null);
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "1".repeat(64));
  const account = { id: transport.accountId, channel: "WHATSAPP", externalId: transport.accountExternalId,
    messagingId: null, extraExternalIds: [], token: encryptSecret("fake-test-only"), enabled: true };
  db.messengerAccount.findMany.mockImplementation(async ({ where }: { where: { channel: string; id?: string } }) => {
    expect(where).toEqual({ channel: "WHATSAPP", id: "fake-account" }); return [account];
  });
  db.messengerAccount.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    expect(where).toEqual({ id: "fake-account" }); return account;
  });
  db.$queryRaw.mockImplementation(async (query: TemplateStringsArray, ...values: unknown[]) => {
    const sql = query.join("?");
    if (sql.includes('FROM "Settings" st LEFT JOIN "CustomerEndpointScope"') && sql.includes('st."metaAppSecret"')) {
      expect(values).toEqual(["WHATSAPP", "WHATSAPP", "WHATSAPP", "settings:WHATSAPP:configured-trace-wa"]);
      return [];
    }
    if (sql.includes('FROM "CustomerEndpointScope"') && sql.includes('WHERE "realmKey"')) {
      expect(values).toEqual(["royal-home", "WHATSAPP", transport.transportKey]);
      return [{ id: transport.endpointScopeId, messengerAccountId: transport.accountId, kind: "NORMAL", scopeRevision: 0n }];
    }
    throw new Error("Unexpected SQL in no-DB Meta routing fixture");
  });
  db.processedMessage.create.mockResolvedValue({}); db.systemError.findFirst.mockResolvedValue(null); db.systemError.create.mockResolvedValue({});
  for (const name of ["META_WA_TOKEN", "META_IG_TOKEN", "META_PAGE_TOKEN", "META_APP_SECRET", "META_IG_APP_SECRET", "META_VERIFY_TOKEN"]) vi.stubEnv(name, "fake-test-only");
  vi.stubEnv("META_WA_PHONE_ID", "fake-phone-id"); vi.stubEnv("META_PAGE_ID", "fake-page-id");
  vi.spyOn(shield, "admitOutbound").mockResolvedValue({ allowed: true, kind: "reply" });
  vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify({ messages: [{ id: "fake-mid" }] }), { status: 200 })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("actual Meta transport trace hooks without DB/network", () => {
  it("profile GET refusal retains subcode33 cache and never becomes a delivery attempt", async () => {
    const hooks = { beforePost: vi.fn(async () => {}), accepted: vi.fn(async () => {}), rejected: vi.fn(async () => {}), networkFailure: vi.fn(async () => {}) };
    const peer = `synthetic-profile-get-${randomUUID()}`;
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ error: { error_subcode: 33 } }), { status: 400 }));
    await withCustomerDeliveryTransport(hooks, async () => {
      expect(await fetchInstagramProfile(peer, "fake-test-only")).toEqual({});
      expect(await fetchInstagramProfile(peer, "fake-test-only")).toEqual({});
    });
    // A caught ReferenceError in GET would skip the unavailable-profile cache
    // and perform a second HTTP request, even though both calls return {}.
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const hook of Object.values(hooks)) expect(hook).not.toHaveBeenCalled();
  });
  it("managed POST records explicit refusal before legacy upload retry can start", async () => {
    const hooks = { beforePost: vi.fn(async () => {}), accepted: vi.fn(async () => {}), rejected: vi.fn(async () => {}), networkFailure: vi.fn(async () => {}) };
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ error: { error_subcode: 2018007 } }), { status: 400 }));
    await expect(withCustomerDeliveryTransport(hooks, () => sendMessage("WHATSAPP", "fake-peer", "Ответ", "fake-test-only", { transport })))
      .rejects.toThrow("Graph API HTTP 400: managed delivery rejected");
    expect(hooks.beforePost).toHaveBeenCalledTimes(1); expect(hooks.rejected).toHaveBeenCalledExactlyOnceWith(400);
    expect(hooks.accepted).not.toHaveBeenCalled(); expect(hooks.networkFailure).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("trace off/on leaves the actual send result, shield call and request count identical", async () => {
    for (const enabled of [false, true]) {
      const { rows, config } = recorder(enabled);
      expect(await withBotTurnTrace(turn, () => sendMessage("WHATSAPP", "fake-peer", "Цена?", "fake-test-only", { transport }), config)).toBe("fake-mid");
      expect(rows.at(-1)?.outgoing[0]?.providerOutcome).toBe(enabled ? "accepted" : undefined);
    }
    expect(fetch).toHaveBeenCalledTimes(2); expect(shield.admitOutbound).toHaveBeenCalledTimes(2);
  });
  it("observes HTTP acceptance before the actual remember-MID write throws", async () => {
    db.processedMessage.create.mockRejectedValue(new Error("fake remember failure"));
    const { rows, config } = recorder();
    await withBotTurnTrace(turn, async () => { await sendMessage("WHATSAPP", "fake-peer", "Ответ", "fake-test-only", { transport }).catch(() => {}); }, config);
    expect(rows.at(-1)?.outgoing[0].providerOutcome).toBe("accepted");
    expect(rows.at(-1)?.outgoing[0].midKey).not.toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("a successful Meta response without MID is accepted with a null MID", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200 })); const { rows, config } = recorder();
    expect(await withBotTurnTrace(turn, () => sendMessage("WHATSAPP", "fake-peer", "Ответ", "fake-test-only", { transport }), config)).toBeNull();
    expect(rows.at(-1)?.outgoing[0]).toMatchObject({ providerOutcome: "accepted", midKey: null });
  });
  it("WhatsApp-only location and reaction hooks use their real recipient signature", async () => {
    const { rows, config } = recorder();
    await withBotTurnTrace(turn, async () => { await sendLocation("fake-peer", 38, 69, undefined, undefined, "fake-test-only", transport); await sendReaction("fake-peer", "fake-inbound", "👍", "fake-test-only", transport); }, config);
    expect(rows.at(-1)?.outgoing.map((part) => [part.kind, part.providerOutcome])).toEqual([["location", "accepted"], ["reaction", "accepted"]]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("actual shield block after a successful part remains partial, without an extra request", async () => {
    const { rows, config } = recorder();
    await withBotTurnTrace(turn, async () => {
      await sendMessage("WHATSAPP", "fake-peer", "Первый", "fake-test-only", { transport });
      vi.mocked(shield.admitOutbound).mockResolvedValue({ allowed: false, kind: "reply", reason: "repeat", reasonText: "fake block" });
      await sendMessage("WHATSAPP", "fake-peer", "Второй", "fake-test-only", { transport }).catch(() => traceOutcome("blocked"));
    }, config);
    expect(rows.at(-1)?.outcome).toBe("partially_sent"); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("actual parser shows postback referral loss without changing normalization or retaining payload", () => {
    const body = { object: "instagram", entry: [{ id: "fake-account", messaging: [{ sender: { id: "fake-peer" }, recipient: { id: "fake-account" }, timestamp: 1, postback: { title: "Подробнее", payload: "PRIVATE_PAYLOAD", referral: { ad_id: "PRIVATE_AD" } } }] }] };
    const off = parseIncoming(body, undefined, false); const on = parseIncoming(body, undefined, true);
    expect(on).toHaveLength(1); const { traceIngressShape, ...unchanged } = on[0];
    expect(unchanged).toEqual(off[0]); expect(traceIngressShape).toMatchObject({ postbackReferral: true, normalizedReferral: false });
    expect(JSON.stringify(traceIngressShape)).not.toContain("PRIVATE");
  });
});
