import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForSettled } from "./helpers/waitFor.js";

/**
 * ОТКАЗ ЛИЧНОГО КЛЮЧА INSTAGRAM — ОДНА ДВЕРЬ (прод 21.11.2026, после #344). Лента аккаунтов
 * (раз в 15 минут), сторож подписки и сверка переписок дёргали закрытый Meta аккаунт Arvan и
 * писали «401 … log in to www.instagram.com» в журнал: 66 строк за сутки. Отметку «Meta закрыла
 * доступ» ставили только отправка и суточная проверка. Здесь: кто бы ни получил этот отказ,
 * отметка ставится сразу, а дальше аккаунт никто не дёргает; мёртвый (не закрытый) ключ в ленте —
 * одна строка в сутки на аккаунт.
 */
const { prisma } = await import("../src/db.js");
const { encryptSecret } = await import("../src/crypto.js");
const eternal = await import("../src/lib/metaEternalTokens.js");
// maxAgeMs = 0 — кэш лент не используется, каждый вызов идёт в Graph.
const { getAllOwnMedia } = await import("../src/messengers/instagramFeed.js");
const { checkInstagramSubscriptions } = await import("../src/lib/instagramWebhookSubscription.js");

const run = randomUUID().slice(0, 8);
const LOCKED = `stand-ig-locked-door-${run}`;
const DEAD = `stand-ig-dead-door-${run}`;
const LOCKED_TEXT = "Error validating access token: You cannot access the app till you log in to www.instagram.com and follow the instructions given.";
const DEAD_TEXT = "Error validating access token: The session has been invalidated because the user changed their password.";
let lockedId = "";
let deadId = "";

const fetchMock = vi.fn();
const carries = (url: string, init: RequestInit | undefined, token: string) =>
  (init?.headers as Record<string, string> | undefined)?.Authorization === `Bearer ${token}` || url.includes(`access_token=${token}`);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const lockedCalls = () => fetchMock.mock.calls.filter(([u, i]) => carries(String(u), i as RequestInit, LOCKED)).length;

beforeAll(async () => {
  // Чужие аккаунты базы (параллельные файлы, сид) тоже попадут в ленту — мок отвечает им пустой лентой.
  lockedId = (await prisma.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId: `178417${run}`, title: `Закрыт ${run}`, token: encryptSecret(LOCKED) } })).id;
  deadId = (await prisma.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId: `178418${run}`, title: `Мёртв ${run}`, token: encryptSecret(DEAD) } })).id;
});

afterAll(async () => {
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { startsWith: `ig-account-locked:${lockedId}` } } });
  await prisma.errorLog.deleteMany({ where: { dedupKey: { startsWith: `ig-feed-failed:${deadId}` } } }).catch(() => {});
  await prisma.messengerAccount.deleteMany({ where: { id: { in: [lockedId, deadId] } } });
  eternal.resetMetaEternalCache();
});

beforeEach(async () => {
  await prisma.messengerAccount.updateMany({ where: { id: { in: [lockedId, deadId] } }, data: { accessLostAt: null, accessLostReason: null } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { startsWith: `ig-account-locked:${lockedId}` } } });
  await prisma.errorLog.deleteMany({ where: { dedupKey: { startsWith: `ig-feed-failed:${deadId}` } } }).catch(() => {});
  eternal.resetMetaEternalCache();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (carries(url, init, LOCKED)) return json({ error: { code: 190, message: LOCKED_TEXT } }, 401);
    if (carries(url, init, DEAD)) return json({ error: { code: 190, message: DEAD_TEXT } }, 401);
    if (url.includes("/subscribed_apps")) return json({ data: [] });
    if (url.includes("/media")) return json({ data: [] });
    return json({ data: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("лента аккаунтов: отказ ключа", () => {
  it("«Meta закрыла доступ» — отметка с первого раза, одна тревога; следующая лента аккаунт не дёргает", async () => {
    await getAllOwnMedia(0);
    const row = await prisma.messengerAccount.findUnique({ where: { id: lockedId }, select: { accessLostAt: true } });
    expect(row?.accessLostAt).not.toBeNull();
    const alerts = await waitForSettled(() => prisma.pendingDirectorAlert.count({ where: { tag: { startsWith: `ig-account-locked:${lockedId}:` } } }));
    expect(alerts).toBe(1);
    const before = lockedCalls();
      await getAllOwnMedia(0);
    expect(lockedCalls()).toBe(before);
  });

  it("ключ просто мёртв (смена пароля) — не «закрыт», и в журнале одна строка на аккаунт в сутки", async () => {
    await getAllOwnMedia(0);
      await getAllOwnMedia(0);
    expect((await prisma.messengerAccount.findUnique({ where: { id: deadId }, select: { accessLostAt: true } }))?.accessLostAt).toBeNull();
    const lines = await waitForSettled(() => prisma.errorLog.count({ where: { dedupKey: `ig-feed-failed:${deadId}:401` } }));
    expect(lines).toBe(1);
  });
});

describe("сторож подписки: отказ ключа", () => {
  it("«Meta закрыла доступ» — отметка через ту же дверь, без строки «не удалось проверить подписку»", async () => {
    await checkInstagramSubscriptions();
    expect((await prisma.messengerAccount.findUnique({ where: { id: lockedId }, select: { accessLostAt: true } }))?.accessLostAt).not.toBeNull();
    const failed = await waitForSettled(() => prisma.errorLog.count({ where: { dedupKey: `ig-subscription-failed:${lockedId}` } }));
    expect(failed).toBe(0);
  });
});
