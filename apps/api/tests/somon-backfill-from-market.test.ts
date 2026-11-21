import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ paused: false }));
vi.mock("../src/lib/telegramPortalPause.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telegramPortalPause.js")>()),
  isTelegramPortalAlertsPaused: async () => flags.paused,
}));

import { prisma } from "../src/db.js";
import { parseBackfillArgs, runSomonBackfill } from "../src/lib/somonLeads/backfillFromMarket.js";
import { somonKeyFingerprint, somonSellerKey } from "../src/lib/somonLeads/contactIdentity.js";

/**
 * Добор 17.11.2026: кандидаты — из рыночного каталога, в очередь монитора — штатной
 * дверью, без своих запросов к Somon и без своей отправки. Номера объявлений — десятизначные,
 * больше всех, что пишут соседние файлы, чтобы «новее всего увиденного» было про наши.
 */
const NOW = new Date();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);
const ID = (n: number) => String(9_988_770_000 + n);
const AGENT = "stand-somon-backfill-agent";
const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(ID);
let oldMonitor: Awaited<ReturnType<typeof prisma.somonMonitor.findUnique>> = null;

function listing(n: number, patch: Partial<{ sellerId: string | null; isAgency: boolean; firstSeenAt: Date; isActive: boolean; raw: object }> = {}) {
  const id = ID(n);
  return {
    source: "somon.tj", sourceId: id, sourceUrl: `https://somon.tj/adv/${id}_kvartira-stand/`, dealType: "SALE", propertyType: "APARTMENT",
    city: "Душанбе", currency: "TJS", title: "Квартира", raw: { rubric: { id: 2831 } }, sellerId: `77100${n}`, isAgency: false, firstSeenAt: daysAgo(1), isActive: true, ...patch,
  };
}

describe("Somon: разовый добор из каталога рынка", () => {
  beforeAll(async () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "2".repeat(64));
    oldMonitor = await prisma.somonMonitor.findUnique({ where: { id: "singleton" } });
    await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: ids } } });
    await prisma.marketListing.deleteMany({ where: { source: "somon.tj", sourceId: { in: ids } } });
    await prisma.somonRecipient.deleteMany({ where: { agentId: AGENT } });
    await prisma.agent.deleteMany({ where: { id: AGENT } });
    await prisma.agent.create({ data: { id: AGENT, fullName: "Тестагент Добора", phone: "stand-somon-backfill-1", telegramChatId: "stand-backfill-chat", role: "AGENT" } });
    await prisma.somonRecipient.create({ data: { agentId: AGENT, position: 47000, enabled: true } });
    await prisma.somonMonitor.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", enabled: true, activatedAt: daysAgo(20), baselineAt: daysAgo(20) },
      update: { enabled: true, activatedAt: daysAgo(20), baselineAt: daysAgo(20), sourceStopped: false },
    });
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { contactKeyFingerprint: somonKeyFingerprint() } });
    await prisma.marketListing.createMany({ data: [
      listing(1),                                         // одно объявление автора → пройдёт локальный счёт
      listing(2, { sellerId: "7710099" }),                // два объявления одного автора → «проверить»
      listing(3, { sellerId: "7710099" }),
      listing(4, { isAgency: true }),                     // бизнес-аккаунт в каталоге — не берём
      listing(5, { firstSeenAt: daysAgo(9) }),            // вне окна
      listing(6, { sellerId: null }),                     // автора нет — монитор отложит
      listing(7, { isActive: false }),                    // исчезло из выдачи
      listing(8, { raw: { rubric: { id: 99999 } } }),     // чужая рубрика (общая лента) — не каталог
    ] });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: ids } } });
    await prisma.marketListing.deleteMany({ where: { source: "somon.tj", sourceId: { in: ids } } });
    await prisma.somonRecipient.deleteMany({ where: { agentId: AGENT } });
    await prisma.agent.deleteMany({ where: { id: AGENT } });
    if (oldMonitor) await prisma.somonMonitor.update({ where: { id: "singleton" }, data: oldMonitor });
    else await prisma.somonMonitor.deleteMany({ where: { id: "singleton" } });
  });
  beforeEach(() => { flags.paused = false; });

  it("объявление вне рубрик каталога в добор не попадает даже кандидатом", async () => {
    await runSomonBackfill({ days: 5, max: 150, apply: true, now: new Date(NOW.getTime() - 1) }).catch(() => undefined);
    // запись ниже проверяет отдельный тест; здесь — только что 8-го нет нигде
    expect(await prisma.somonSeenAdvert.count({ where: { advertId: ID(8) } })).toBe(0);
    await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: ids } } });
  });

  it("пробный прогон ничего не пишет и считает фильтры по нашим объявлениям", async () => {
    const report = await runSomonBackfill({ days: 5, max: 150, apply: false, now: NOW });
    expect(report.mode).toBe("dry-run");
    expect(report.blocked).toBeNull();
    expect(await prisma.somonSeenAdvert.count({ where: { advertId: { in: ids } } })).toBe(0);
    expect(report.skippedAgencyFlag).toBeGreaterThanOrEqual(1);
    expect(report.passLocalOwnerCount).toBeGreaterThanOrEqual(1);
    expect(report.goToReviewByCount).toBeGreaterThanOrEqual(2);
    expect(report.noSellerId).toBeGreaterThanOrEqual(1);
    expect(report.somonRequestsMax).toBe(report.passLocalOwnerCount * 3);
    expect(report.recipients.some(r => r.name === "Тестагент")).toBe(true);
  });

  it("пауза площадок блокирует запись", async () => {
    flags.paused = true;
    const report = await runSomonBackfill({ days: 5, max: 150, apply: true, now: NOW });
    expect(report.blocked).toContain("пауза");
    expect(report.inserted).toBe(0);
    expect(await prisma.somonSeenAdvert.count({ where: { advertId: { in: ids } } })).toBe(0);
  });

  it("запись — штатной дверью монитора, свежие вперёд, повтор без дублей", async () => {
    const report = await runSomonBackfill({ days: 5, max: 150, apply: true, now: NOW });
    expect(report.blocked).toBeNull();
    const rows = await prisma.somonSeenAdvert.findMany({ where: { advertId: { in: ids } } });
    expect(rows.map(r => r.advertId).sort()).toEqual([ID(1), ID(2), ID(3), ID(6)].sort());
    for (const r of rows) {
      expect(r.status).toBe("PENDING");
      expect(r.baseline).toBe(false);
      expect(r.slug).toBe(`${r.advertId}_kvartira-stand`);
      expect(r.lastCheckedAt!.getTime()).toBeGreaterThan(NOW.getTime() + 24 * 60 * 60 * 1000);
    }
    expect(rows.find(r => r.advertId === ID(1))?.sellerKey).toBe(somonSellerKey("771001"));
    expect(rows.find(r => r.advertId === ID(6))?.sellerKey).toBeNull();
    const again = await runSomonBackfill({ days: 5, max: 150, apply: true, now: new Date(NOW.getTime() + 1000) });
    expect(again.inserted).toBe(0);
    expect(await prisma.somonSeenAdvert.count({ where: { advertId: { in: ids } } })).toBe(4);
  });

  it("параметры: окно не больше 5 дней, предел штук, по умолчанию — пробный прогон", () => {
    expect(parseBackfillArgs([])).toEqual({ days: 5, max: 150, apply: false });
    expect(parseBackfillArgs(["--apply", "--days=3", "--max=40"])).toEqual({ days: 3, max: 40, apply: true });
    expect(() => parseBackfillArgs(["--days=14"])).toThrow();
    expect(() => parseBackfillArgs(["--max=1001"])).toThrow();
    expect(parseBackfillArgs(["--max=1000"]).max).toBe(1000);
    expect(() => parseBackfillArgs(["--force"])).toThrow();
  });

  it("монитор уже ушёл вперёд после паузы, а пропуск остался позади — пропуск добирается", async () => {
    // Живой случай 17.11: после снятия паузы монитор увидел СЕГОДНЯШНЕЕ объявление с самым
    // большим номером; пропущенные за дни паузы — ниже него и в SomonSeenAdvert их нет.
    await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: ids } } });
    await prisma.somonSeenAdvert.create({ data: { advertId: ID(9), slug: `${ID(9)}_kvartira-stand`, seenAt: NOW, lastCheckedAt: NOW, status: "DISPATCHED" } });
    const report = await runSomonBackfill({ days: 5, max: 1000, apply: true, now: new Date(NOW.getTime() + 2000) });
    expect(report.blocked).toBeNull();
    expect(BigInt(report.newerThanAdvertId ?? "0")).toBeLessThan(BigInt(ID(1)));
    const rows = await prisma.somonSeenAdvert.findMany({ where: { advertId: { in: [ID(1), ID(2), ID(3), ID(6)] } }, select: { advertId: true, status: true } });
    expect(rows.map(r => r.advertId).sort()).toEqual([ID(1), ID(2), ID(3), ID(6)].sort());
    await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: ids } } });
  });
});
