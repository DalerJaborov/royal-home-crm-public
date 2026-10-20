import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { resolveCustomerEndpoint } from "../src/lib/customerConversationScope.js";
import { resolveIncomingAccount, resetAccountsCache } from "../src/messengers/accounts.js";

beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Mixed routing regression forbids external HTTP"); })));
afterEach(() => vi.unstubAllGlobals());
describe("exact Settings resources beside unrelated installed accounts", () => {
  it.each(["WHATSAPP", "FACEBOOK"] as const)("%s selects only exact Settings routing and preserves disabled exact DB priority", async channel => {
    const settings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
      metaWaPhoneId: true, metaWaToken: true, metaPageId: true, metaPageToken: true,
    } });
    const ids: string[] = [], resource = `synthetic-mixed-settings-${randomUUID()}`, token = `synthetic-settings-token-${randomUUID()}`;
    try {
      const unrelated = await prisma.messengerAccount.create({ data: { channel, externalId: `synthetic-unrelated-${randomUUID()}`,
        title: "Synthetic unrelated mixed route", token: encryptSecret("synthetic-unrelated-token"), enabled: true } }); ids.push(unrelated.id);
      await prisma.settings.update({ where: { id: "singleton" }, data: channel === "WHATSAPP"
        ? { metaWaPhoneId: resource, metaWaToken: encryptSecret(token) }
        : { metaPageId: resource, metaPageToken: encryptSecret(token) } });
      resetAccountsCache();
      expect(await resolveIncomingAccount(channel, resource)).toMatchObject({ id: null, token, certain: true });
      const unknownResource = `synthetic-unknown-${randomUUID()}`, unknown = await resolveIncomingAccount(channel, unknownResource);
      expect(unknown.id).not.toBeNull(); expect(unknown.token).not.toBe(token);
      await expect(resolveCustomerEndpoint({ channel, subscriberId: "synthetic-peer", accountId: unknown.id, accountExternalId: unknownResource }))
        .rejects.toMatchObject({ reason: "account_mismatch" });
      const disabled = await prisma.messengerAccount.create({ data: { channel, externalId: resource,
        title: "Synthetic disabled exact mixed route", token: encryptSecret("synthetic-disabled-token"), enabled: false } }); ids.push(disabled.id);
      resetAccountsCache();
      expect(await resolveIncomingAccount(channel, resource)).toMatchObject({ id: disabled.id, token: undefined, certain: true });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      try { await prisma.messengerAccount.deleteMany({ where: { id: { in: ids } } }); }
      finally { try { await prisma.settings.update({ where: { id: "singleton" }, data: settings }); } finally { resetAccountsCache(); } }
    }
  });
});
