import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";

/**
 * СТРАЖ КУРСА ДОЛЛАРА (владелец 28.11.2026): скачок не применяется сам, «не обновлялся 36 часов» зовёт руководство,
 * сдвиг больше порога пересылает цены на сайт и предупреждает про подписи, подписи живых постов правятся только кнопкой.
 */

const alerts: Array<{ title: string; body: string; tag?: string | null }> = [];
vi.mock("../src/lib/directorAlertQueue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/directorAlertQueue.js")>()),
  enqueueDirectorAlert: async (p: { title: string; body: string; tag?: string | null }) => {
    alerts.push(p);
    return true;
  },
}));

const { fetchAlifUsdSellRate, refreshUsdToTjsRateFromAlif } = await import("../src/lib/exchangeRate.js");
const { buildPriceDisplay } = await import("../src/lib/reelsCaptionTemplate.js");
const NEW_PRICE = buildPriceDisplay(50000, "USD", { usdToTjs: 9.5 });
const { checkRateFreshness, findStaleRateCaptions, refreshStaleRateCaptions, onUsdRateApplied } = await import("../src/lib/exchangeRateWatch.js");

const originalFetch = globalThis.fetch;
const runId = Date.now();
const created: string[] = [];
let saved: Record<string, unknown> | null = null;
let districtId = "";
let agentId = "";

function alifReturns(sell: string) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ localRates: [{ name: "USD", sellValue: sell }] }),
  })) as unknown as typeof fetch;
}

async function setRate(rate: number, hoursAgo = 1, extra: Record<string, unknown> = {}) {
  const data = {
    usdToTjsRate: rate,
    usdToTjsRateUpdatedAt: new Date(Date.now() - hoursAgo * 3_600_000),
    usdToTjsRateSource: "alif-auto",
    usdRatePendingValue: null,
    usdRatePendingAt: null,
    usdRateSyncedRate: null,
    usdRateStaleAlertedAt: null,
    usdRateAlertPct: 1,
    usdRateSiteResyncEnabled: true,
    usdRateAlertsEnabled: true,
    ...extra,
  };
  await prisma.settings.upsert({ where: { id: "singleton" }, update: data, create: { id: "singleton", ...data } });
}

async function makeUsdProperty(caption: string | null, opts: { site?: boolean; channels?: string[] } = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Курс-тест ${runId}`,
      type: "APARTMENT",
      price: 50000,
      currency: "USD",
      areaSqm: 60,
      condition: "GOOD",
      rooms: 2,
      districtId,
      createdById: agentId,
      publishedOnSite: opts.site ?? false,
      publishedChannels: opts.channels ?? [],
      publishedPostIds: opts.channels?.includes("TELEGRAM") ? { TELEGRAM: "123" } : {},
      reelsCaption: caption,
    },
  });
  created.push(p.id);
  return p;
}

beforeAll(async () => {
  saved = (await prisma.settings.findUnique({ where: { id: "singleton" } })) as Record<string, unknown> | null;
  const district = await prisma.district.findFirst();
  districtId = district?.id ?? (await prisma.district.create({ data: { name: `Район-${runId}`, city: "Душанбе" } })).id;
  agentId = (await prisma.agent.create({ data: { fullName: `Курс-тест ${runId}`, phone: `+9929${String(runId).slice(-8)}`, role: "AGENT", passwordHash: "x" } })).id;
});

beforeEach(() => {
  alerts.length = 0;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await prisma.property.deleteMany({ where: { id: { in: created.splice(0) } } });
  await prisma.backgroundJob.deleteMany({ where: { type: "site-resync", dedupeKey: { startsWith: "site-resync:" }, payload: { path: ["context"], string_contains: "курс" } } }).catch(() => {});
});

afterAll(async () => {
  if (saved) {
    const { id, ...rest } = saved as { id: string } & Record<string, unknown>;
    await prisma.settings.update({ where: { id }, data: rest as never }).catch(() => {});
  }
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("обновление курса: защита от мусора", () => {
  it("нулевой, отрицательный и абсурдный курс отбрасывается", async () => {
    for (const bad of ["0", "-3", "abc", "119", "2"]) {
      alifReturns(bad);
      expect(await fetchAlifUsdSellRate()).toBeNull();
    }
  });

  it("alif.tj недоступен — прежний курс остаётся, отказ возвращается", async () => {
    await setRate(9.31);
    globalThis.fetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await refreshUsdToTjsRateFromAlif();
    expect(r.ok).toBe(false);
    const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
    expect(Number(s?.usdToTjsRate)).toBe(9.31);
  });

  it("обычное колебание применяется и обновляет время", async () => {
    await setRate(9.31, 30);
    alifReturns("9.35");
    const r = await refreshUsdToTjsRateFromAlif();
    expect(r).toMatchObject({ ok: true, rate: 9.35 });
    const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
    expect(Number(s?.usdToTjsRate)).toBe(9.35);
    expect(Date.now() - (s?.usdToTjsRateUpdatedAt?.getTime() ?? 0)).toBeLessThan(60_000);
  });

  it("скачок больше 5 %: курс НЕ применяется, ждёт подтверждения, руководству одно сообщение", async () => {
    await setRate(9.31);
    alifReturns("10.20");
    const r = await refreshUsdToTjsRateFromAlif();
    expect(r).toMatchObject({ ok: true, held: true, rate: 9.31, pendingRate: 10.2 });
    const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
    expect(Number(s?.usdToTjsRate)).toBe(9.31);
    expect(Number(s?.usdRatePendingValue)).toBe(10.2);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toContain("скакнул");
    // Следующая ночь с тем же значением — второго сообщения нет.
    await refreshUsdToTjsRateFromAlif();
    expect(alerts).toHaveLength(1);
  });

  it("подтверждённый скачок применяется и снимает ожидание", async () => {
    await setRate(9.31);
    alifReturns("10.20");
    const r = await refreshUsdToTjsRateFromAlif({ confirmJump: true });
    expect(r).toMatchObject({ ok: true, rate: 10.2 });
    const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
    expect(Number(s?.usdToTjsRate)).toBe(10.2);
    expect(s?.usdRatePendingValue).toBeNull();
  });
});

describe("сторож свежести", () => {
  it("свежий курс — тишина", async () => {
    await makeUsdProperty(null);
    await setRate(9.31, 5);
    expect(await checkRateFreshness()).toBe(false);
    expect(alerts).toHaveLength(0);
  });

  it("не обновлялся 40 часов — одно сообщение, повтор в тот же день молчит", async () => {
    await makeUsdProperty(null);
    await setRate(9.31, 40);
    expect(await checkRateFreshness()).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toContain("40");
    expect(await checkRateFreshness()).toBe(false);
    expect(alerts).toHaveLength(1);
  });

  it("рубильник ВЫКЛ — молчит", async () => {
    await makeUsdProperty(null);
    await setRate(9.31, 80, { usdRateAlertsEnabled: false });
    expect(await checkRateFreshness()).toBe(false);
    expect(alerts).toHaveLength(0);
  });
});

describe("смена курса", () => {
  it("меньше порога — ничего не пересылается и не пишется", async () => {
    const p = await makeUsdProperty("Цена: 465 500 сомони ($50 000)", { site: true, channels: ["TELEGRAM"] });
    await setRate(9.31, 1, { usdRateSyncedRate: 9.31 });
    await onUsdRateApplied(9.31, 9.35, "alif-auto");
    expect(alerts).toHaveLength(0);
    const jobs = await prisma.backgroundJob.count({ where: { type: "site-resync", dedupeKey: `site-resync:${p.id}` } });
    expect(jobs).toBe(0);
  });

  it("больше порога — цены на сайте на пересчёт, предупреждение про подписи", async () => {
    const p = await makeUsdProperty("Цена: 465 500 сомони ($50 000)", { site: true, channels: ["TELEGRAM"] });
    await setRate(9.5, 1, { usdRateSyncedRate: 9.31 });
    await onUsdRateApplied(9.31, 9.5, "alif-auto");
    const jobs = await prisma.backgroundJob.count({ where: { type: "site-resync", dedupeKey: `site-resync:${p.id}` } });
    expect(jobs).toBe(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toContain("со старой ценой");
    const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
    expect(Number(s?.usdRateSyncedRate)).toBe(9.5);
    // Живой пост сам не тронут: подпись прежняя.
    const after = await prisma.property.findUnique({ where: { id: p.id } });
    expect(after?.reelsCaption).toBe("Цена: 465 500 сомони ($50 000)");
  });

  it("рубильник пересчёта сайта ВЫКЛ — сайт не трогается, предупреждение остаётся", async () => {
    const p = await makeUsdProperty("Цена: 465 500 сомони ($50 000)", { site: true });
    await setRate(9.5, 1, { usdRateSyncedRate: 9.31, usdRateSiteResyncEnabled: false });
    await onUsdRateApplied(9.31, 9.5, "manual");
    expect(await prisma.backgroundJob.count({ where: { type: "site-resync", dedupeKey: `site-resync:${p.id}` } })).toBe(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toContain("не пересчитывались");
  });
});

describe("подписи в соцсетях: только кнопкой", () => {
  it("находит устаревшую подпись и не считает устаревшей свежую", async () => {
    await setRate(9.5);
    const stale = await makeUsdProperty("Квартира\nЦена: 465 500 сомони ($50 000)\nЗвоните", { channels: ["TELEGRAM"] });
    const fresh = await makeUsdProperty(`Квартира\nЦена: ${NEW_PRICE}`, { channels: ["TELEGRAM"] });
    const noPrice = await makeUsdProperty("Квартира без цены в тексте", { channels: ["TELEGRAM"] });
    const ids = (await findStaleRateCaptions()).map((c) => c.id);
    expect(ids).toContain(stale.id);
    expect(ids).not.toContain(fresh.id);
    expect(ids).not.toContain(noPrice.id);
  });

  it("кнопка переписывает только строку цены и ставит правку поста в очередь; Instagram — в «руками»", async () => {
    await setRate(9.5, 1, { telegramChannelId: "-1001234567890" });
    const p = await makeUsdProperty("Квартира\nЦена: 465 500 сомони ($50 000)\nЗвоните", { channels: ["TELEGRAM", "INSTAGRAM"] });
    await prisma.property.update({ where: { id: p.id }, data: { publishedPostIds: { TELEGRAM: "123", INSTAGRAM: "ig1" } } });
    const summary = await refreshStaleRateCaptions();
    expect(summary.queued).toBeGreaterThanOrEqual(1);
    const after = await prisma.property.findUnique({ where: { id: p.id } });
    expect(after?.reelsCaption).toBe(`Квартира\nЦена: ${NEW_PRICE}\nЗвоните`);
    expect(after!.version).toBeGreaterThan(p.version);
    const rows = await prisma.publicationMetadataSync.findMany({ where: { propertyId: p.id, executionMode: "PRICE_CHANGE" } });
    expect(rows.some((r) => r.channel === "TELEGRAM" && r.status === "PENDING")).toBe(true);
    expect(summary.manual.some((m) => m.channels.includes("INSTAGRAM"))).toBe(true);
    // Второе нажатие: уже свежо — нечего менять.
    expect((await findStaleRateCaptions()).map((c) => c.id)).not.toContain(p.id);
  });
});
