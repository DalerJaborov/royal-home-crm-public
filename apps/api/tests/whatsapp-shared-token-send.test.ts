// Two WhatsApp numbers of one business account share one system-user token (Royal Home in Settings, Arvan as a
// MessengerAccount row, 26.11.2026). A legacy send without a captured transport used to fail `account_mismatch` for
// BOTH numbers as soon as the second row existed; now the peer's own conversation names the number.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("../src/crypto.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/crypto.js")>()),
  decryptSecretSafe: (value: string | null) => value?.startsWith("fixture:") ? value.slice(8) : "" }));
import type { TxClient } from "../src/db.js";
import type { MetaCredentials } from "../src/messengers/metaTypes.js";
import { CustomerScopeDenied } from "../src/lib/customerConversationScope.js";
import { resolveLegacyMetaSendTransport } from "../src/lib/customerMetaTransport.js";

const ACCOUNT = randomUUID();
const MAIN_PHONE = "fixture-main-phone", ARVAN_PHONE = "fixture-arvan-phone";
const scopeIds = new Map<string, string>();
const scopeOf = (transportKey: string) => scopeIds.get(transportKey) ?? (scopeIds.set(transportKey, randomUUID()), scopeIds.get(transportKey)!);

/** peer -> its one stored WhatsApp conversation (what the global unique key guarantees). */
function fakeDb(input: { accountToken: string; settingsToken: string; conversations: Record<string, { accountId: string | null; transportKey: string }> }) {
  const db = {
    messengerAccount: { findMany: vi.fn(async (args: { where: { enabled?: boolean; id?: string; OR?: Array<Record<string, unknown>> } }) => {
      const row = { id: ACCOUNT, token: `fixture:${input.accountToken}`, externalId: ARVAN_PHONE, messagingId: null, extraExternalIds: [] as string[] };
      if (args.where.enabled) return [row];
      if (args.where.id) return args.where.id === ACCOUNT ? [row] : [];
      return (args.where.OR ?? []).some(clause => clause.externalId === ARVAN_PHONE) ? [row] : [];
    }) },
    $queryRaw: vi.fn(async (query: TemplateStringsArray, ...values: unknown[]) => {
      const text = query.join("?");
      if (text.includes('FROM "Settings"')) return [{ externalId: MAIN_PHONE, token: `fixture:${input.settingsToken}`, appSecret: null,
        endpointScopeId: scopeOf(`settings:WHATSAPP:${MAIN_PHONE}`), scopeRevision: 1n, policyRevision: 1n }];
      if (text.includes('FROM "BotConversation" c')) {
        const peer = values.find(value => typeof value === "string" && value in input.conversations) as string | undefined;
        return peer ? [input.conversations[peer]] : [];
      }
      if (text.includes('FROM "CustomerEndpointScope"')) {
        const key = values.find(value => typeof value === "string" && /^(settings|messenger-account):/.test(value)) as string;
        return [{ id: scopeOf(key), messengerAccountId: key.startsWith("messenger-account:") ? ACCOUNT : null, kind: "NORMAL", scopeRevision: 2n }];
      }
      return [];
    }),
    $executeRaw: vi.fn(),
  };
  return db as unknown as TxClient;
}
const credentials = (token: string): MetaCredentials => ({ waToken: token, waPhoneId: MAIN_PHONE, pageToken: undefined, pageId: undefined });
const conversations = {
  "992900000001": { accountId: null, transportKey: `settings:WHATSAPP:${MAIN_PHONE}` },
  "992900000002": { accountId: ACCOUNT, transportKey: `messenger-account:${ACCOUNT}` },
};

describe("legacy WhatsApp send with one token for two numbers", () => {
  it("a Royal Home customer is answered from the Settings number, an Arvan customer from the Arvan row", async () => {
    const db = fakeDb({ accountToken: "shared", settingsToken: "shared", conversations });
    const main = await resolveLegacyMetaSendTransport(credentials("shared"), "WHATSAPP", "992900000001", undefined, db);
    expect(main).toMatchObject({ accountId: null, transportKey: `settings:WHATSAPP:${MAIN_PHONE}`, accountExternalId: MAIN_PHONE });
    const arvan = await resolveLegacyMetaSendTransport(credentials("shared"), "WHATSAPP", "992900000002", undefined, db);
    expect(arvan).toMatchObject({ accountId: ACCOUNT, transportKey: `messenger-account:${ACCOUNT}`, accountExternalId: ARVAN_PHONE });
  });

  it("a peer without a chat is refused, never sent from a guessed number", async () => {
    const db = fakeDb({ accountToken: "shared", settingsToken: "shared", conversations });
    await expect(resolveLegacyMetaSendTransport(credentials("shared"), "WHATSAPP", "992900000009", undefined, db))
      .rejects.toMatchObject({ reason: "account_mismatch" });
  });

  it("a chat on a namespace the token does not serve is refused", async () => {
    const db = fakeDb({ accountToken: "shared", settingsToken: "shared",
      conversations: { "992900000003": { accountId: randomUUID(), transportKey: "messenger-account:other" } } });
    await expect(resolveLegacyMetaSendTransport(credentials("shared"), "WHATSAPP", "992900000003", undefined, db))
      .rejects.toBeInstanceOf(CustomerScopeDenied);
  });

  it("different tokens keep the old exact routing (no conversation read needed)", async () => {
    const db = fakeDb({ accountToken: "arvan-token", settingsToken: "main-token", conversations: {} });
    expect(await resolveLegacyMetaSendTransport(credentials("main-token"), "WHATSAPP", "992900000004", undefined, db))
      .toMatchObject({ accountId: null, transportKey: `settings:WHATSAPP:${MAIN_PHONE}` });
    expect(await resolveLegacyMetaSendTransport(credentials("main-token"), "WHATSAPP", "992900000004", "arvan-token", db))
      .toMatchObject({ accountId: ACCOUNT, transportKey: `messenger-account:${ACCOUNT}` });
  });
});
