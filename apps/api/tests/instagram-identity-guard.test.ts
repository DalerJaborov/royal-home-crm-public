import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Сторож ников Instagram (10.11.2026). Живой случай: у Arvan Estate ник не
 * сохранили при подключении, и ядро клиентского бота двое суток держало ВСЁ
 * входящее Instagram (HELD own_identity_registry_incomplete) без единой тревоги.
 */
const identity = vi.hoisted(() => ({ value: { ok: true as const, id: "x", messagingId: "", username: "" } as
  { ok: true; id: string; messagingId?: string; username?: string } | { ok: false; error: string } }));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  instagramTokenIdentity: vi.fn(async () => identity.value),
}));

const { prisma } = await import("../src/db.js");
const { encryptSecret } = await import("../src/crypto.js");
const { runInstagramIdentityGuard, reportHeldOwnIdentityTickets, fillMissingInstagramIdentities, OWN_IDENTITY_ALERT_TAG } = await import("../src/lib/instagramIdentityGuard.js");
const { readRecoveryOwnIdentities } = await import("../src/lib/customerIngressClassification.js");

const run = randomUUID().slice(0, 8);
const accountIds: string[] = [];

async function account(username: string | null) {
  const row = await prisma.messengerAccount.create({ data: {
    channel: "INSTAGRAM", externalId: `idguard-${run}-${accountIds.length}-${randomUUID().slice(0, 6)}`, title: `Сторож ${run} ${accountIds.length}`,
    token: encryptSecret("stand-token"), username, enabled: true,
  } });
  accountIds.push(row.id);
  return row;
}

beforeEach(async () => {
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: OWN_IDENTITY_ALERT_TAG } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accountIds } } });
  accountIds.length = 0;
});

afterAll(async () => {
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: OWN_IDENTITY_ALERT_TAG } });
  await prisma.messengerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("сторож ников Instagram", () => {
  it("пустой ник выключает Instagram во всём ядре — поэтому его и сторожим", async () => {
    await account(null);
    expect((await readRecoveryOwnIdentities(prisma)).instagramComplete).toBe(false);
  });

  it("дописывает ник и идентификатор личных сообщений из ответа Meta", async () => {
    const row = await account(null);
    identity.value = { ok: true, id: row.externalId, messagingId: `msg-${run}`, username: "arvan__estate" };
    const result = await runInstagramIdentityGuard();
    expect(result.filled).toBeGreaterThanOrEqual(1);
    const saved = await prisma.messengerAccount.findUniqueOrThrow({ where: { id: row.id } });
    expect(saved.username).toBe("arvan__estate");
    expect(saved.messagingId).toBe(`msg-${run}`);
  });

  it("не может дописать и ядро держит входящие — тревога директору один раз в сутки", async () => {
    const row = await account(null);
    identity.value = { ok: false, error: "Meta ответила 400" };
    // Настоящий HELD-тикет собирает только ядро (строгие CHECK в базе), поэтому
    // подменяем лишь подсчёт; сам запрос проверен тестом «без задержанных» ниже.
    expect((await fillMissingInstagramIdentities()).failed).toBeGreaterThanOrEqual(1);
    const first = await reportHeldOwnIdentityTickets(new Date(), async () => 3);
    expect(first.held).toBe(3);
    expect(first.alerted).toBe(true);
    const alert = await prisma.pendingDirectorAlert.findFirstOrThrow({ where: { tag: OWN_IDENTITY_ALERT_TAG } });
    expect(alert.level).toBe("CRITICAL");
    expect(alert.body).toContain(row.title);
    const second = await reportHeldOwnIdentityTickets(new Date(), async () => 3);
    expect(second.alerted).toBe(false);
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: OWN_IDENTITY_ALERT_TAG } })).toBe(1);
  });

  it("без задержанных входящих тревоги нет", async () => {
    identity.value = { ok: true, id: "x", username: "royal.home.tj" };
    const result = await runInstagramIdentityGuard();
    expect(result.held).toBe(0);
    expect(result.alerted).toBe(false);
  });
});
