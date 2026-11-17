import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ log: vi.fn(async () => undefined), process: vi.fn(async () => "skipped"), source: vi.fn() }));
vi.mock("../src/lib/telegramPortalPause.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telegramPortalPause.js")>()),
  isTelegramPortalAlertsPaused: async () => false,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: mocks.log,
}));
vi.mock("../src/lib/somonLeads/processPending.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/somonLeads/processPending.js")>()),
  processSomonPending: mocks.process,
}));
vi.mock("../src/lib/somonLeads/sourceClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/somonLeads/sourceClient.js")>()),
  fetchSomon: mocks.source,
}));

import { prisma } from "../src/db.js";
import { pendingDelayed, runSomonMonitorTick, SOMON_PENDING_DELAY_DEDUP_MS, SOMON_PENDING_DELAY_MS } from "../src/lib/somonLeads/monitor.js";
import { somonKeyFingerprint } from "../src/lib/somonLeads/contactIdentity.js";

/**
 * 17.11.2026: после снятия паузы площадок «очередь задерживается» писалась каждые 10 минут
 * (7 строк за час), а добор ставит свои объявления в очередь на двое суток вперёд — без правки
 * тревога шла бы до конца добора. Голова очереди, отложенная вперёд, тревоги не даёт.
 */
const NOW = new Date("2026-11-17T09:00:00Z");
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe("pendingDelayed", () => {
  it("пусто или свежее — тишина", () => {
    expect(pendingDelayed(undefined, NOW)).toBe(false);
    expect(pendingDelayed({ seenAt: minAgo(10), lastCheckedAt: minAgo(10) }, NOW)).toBe(false);
  });
  it("свежее объявление ждёт дольше 15 минут — тревога", () => {
    expect(pendingDelayed({ seenAt: minAgo(16), lastCheckedAt: minAgo(16) }, NOW)).toBe(true);
    expect(pendingDelayed({ seenAt: minAgo(16), lastCheckedAt: null }, NOW)).toBe(true);
  });
  it("голова очереди отложена вперёд (добор) — тревоги нет, как бы давно её ни увидели", () => {
    expect(pendingDelayed({ seenAt: minAgo(600), lastCheckedAt: new Date(NOW.getTime() + 60_000) }, NOW)).toBe(false);
  });
  it("пороги", () => {
    expect(SOMON_PENDING_DELAY_MS).toBe(15 * 60_000);
    expect(SOMON_PENDING_DELAY_DEDUP_MS).toBe(3 * 60 * 60_000);
  });
});

describe("тик монитора: тревога очереди", () => {
  const ids = ["9988771001", "9988771002"];
  let oldMonitor: Awaited<ReturnType<typeof prisma.somonMonitor.findUnique>> = null;
  beforeAll(async () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "3".repeat(64));
    oldMonitor = await prisma.somonMonitor.findUnique({ where: { id: "singleton" } });
    await prisma.somonMonitor.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", enabled: true, activatedAt: minAgo(60 * 24 * 20), baselineAt: minAgo(60 * 24 * 20) },
      update: { enabled: true, activatedAt: minAgo(60 * 24 * 20), baselineAt: minAgo(60 * 24 * 20), sourceStopped: false, blockedUntil: null, scanPage: 1, scanLeaseToken: null, scanLeaseUntil: null, sellerKeyRekeyPage: null },
    });
    // Скан в этот тик не нужен: следующий — в будущем.
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { contactKeyFingerprint: somonKeyFingerprint(), nextScanAt: new Date(Date.now() + 60 * 60_000), sellerKeyRekeyPage: null } });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: ids } } });
    if (oldMonitor) await prisma.somonMonitor.update({ where: { id: "singleton" }, data: oldMonitor });
    else await prisma.somonMonitor.deleteMany({ where: { id: "singleton" } });
  });
  beforeEach(async () => {
    mocks.log.mockClear();
    await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: ids } } });
  });

  it("свежее объявление ждёт час — одна запись с окном дедупа 3 ч", async () => {
    const seenAt = new Date(Date.now() - 60 * 60_000);
    await prisma.somonSeenAdvert.create({ data: { advertId: ids[0], slug: `${ids[0]}_stand`, seenAt, lastCheckedAt: seenAt, status: "PENDING" } });
    await runSomonMonitorTick(async () => {});
    const calls = mocks.log.mock.calls.filter(c => (c[2] as { dedupKey?: string } | undefined)?.dedupKey === "somon-pending-delay");
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toMatchObject({ dedupWindowMs: SOMON_PENDING_DELAY_DEDUP_MS });
  });

  it("в очереди только добор (отложен вперёд) — тревоги нет", async () => {
    // Соседние файлы тоже кладут PENDING в общую базу: проверка — только если наша запись
    // оказалась головой очереди, иначе тест ничего не утверждает о нашей.
    const seenAt = new Date(Date.now() - 10 * 60 * 60_000);
    await prisma.somonSeenAdvert.create({ data: { advertId: ids[1], slug: `${ids[1]}_stand`, seenAt, lastCheckedAt: new Date(Date.now() + 2 * 24 * 60 * 60_000), status: "PENDING" } });
    const head = await prisma.somonSeenAdvert.findFirst({ where: { status: "PENDING", baseline: false }, orderBy: [{ lastCheckedAt: { sort: "asc", nulls: "first" } }, { seenAt: "asc" }], select: { advertId: true } });
    await runSomonMonitorTick(async () => {});
    if (head?.advertId === ids[1]) {
      expect(mocks.log.mock.calls.some(c => (c[2] as { dedupKey?: string } | undefined)?.dedupKey === "somon-pending-delay")).toBe(false);
    }
  });
});
