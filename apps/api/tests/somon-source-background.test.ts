import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ claim: vi.fn(), record: vi.fn() }));
vi.mock("../src/lib/somonLeads/sourceBudgetStore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/somonLeads/sourceBudgetStore.js")>()),
  claimSomonRequest: mocks.claim,
  recordSomonResponse: mocks.record,
}));

import { prisma } from "../src/db.js";
import { fetchSomon } from "../src/lib/somonLeads/sourceClient.js";
import { BACKGROUND_YIELD_MS, isSomonSourceStopped } from "../src/lib/somonLeads/sourceBudgetStore.js";

// vi.mock подменил экспорт; настоящую функцию берём напрямую из оригинала.
const original = await vi.importActual<typeof import("../src/lib/somonLeads/sourceBudgetStore.js")>("../src/lib/somonLeads/sourceBudgetStore.js");

describe("дверь fetchSomon: пути", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claim.mockResolvedValue("lease");
    mocks.record.mockResolvedValue(undefined);
  });
  it("пропускает продажу квартир и домов в Душанбе, фоновый режим доходит до бюджета", async () => {
    const request = vi.fn().mockImplementation(async () => new Response("<html/>"));
    for (const path of ["/nedvizhimost/prodazha-kvartir/dushanbe/", "/nedvizhimost/prodazha-domov/dushanbe/", "/nedvizhimost/prodazha-domov/dushanbe/?page=7"]) {
      await fetchSomon(path, new Date(), request, { background: true });
    }
    expect(request).toHaveBeenCalledTimes(3);
    expect(mocks.claim).toHaveBeenCalledWith(expect.any(Date), 10000, { background: true });
  });
  it.each([
    "/nedvizhimost/arenda-kvartir/dushanbe/",
    "/nedvizhimost/prodazha-uchastkov/dushanbe/",
    "/nedvizhimost/prodazha-domov/dushanbe/?page=1&sort=price",
    "/nedvizhimost/prodazha-domov/khujand/",
    "/nedvizhimost/prodazha-domov/dushanbe",
  ])("не пропускает %s и не трогает бюджет", async (path) => {
    const request = vi.fn();
    await expect(fetchSomon(path, new Date(), request)).rejects.toThrow("Invalid Somon source path");
    expect(request).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});

describe("общий бюджет: фоновый обход уступает лидам", () => {
  let old: Awaited<ReturnType<typeof prisma.somonMonitor.findUnique>> = null;
  const now = new Date("2026-11-02T10:00:00Z");
  const base = { sourceStopped: false, blockedUntil: null, requestLeaseUntil: null, requestLeaseToken: null, scanLeaseUntil: null, scanLeaseToken: null };
  const setState = (data: Record<string, unknown>) =>
    prisma.somonMonitor.upsert({ where: { id: "singleton" }, create: { id: "singleton", ...base, ...data }, update: { ...base, ...data } });

  beforeAll(async () => {
    old = await prisma.somonMonitor.findUnique({ where: { id: "singleton" } });
  });
  afterAll(async () => {
    if (old) await prisma.somonMonitor.update({ where: { id: "singleton" }, data: old });
    else await prisma.somonMonitor.deleteMany({ where: { id: "singleton" } });
  });

  it("лиды выключены: обычный запрос отказан, фоновый получает слот", async () => {
    await setState({ enabled: false });
    expect(await original.claimSomonRequest(now, 10000)).toBeNull();
    expect(await original.claimSomonRequest(now, 10000, { background: true })).toEqual(expect.any(String));
  });

  it("строки бюджета нет вовсе: фоновый создаёт её выключенной", async () => {
    await prisma.somonMonitor.deleteMany({ where: { id: "singleton" } });
    expect(await original.claimSomonRequest(now, 10000, { background: true })).toEqual(expect.any(String));
    expect((await prisma.somonMonitor.findUniqueOrThrow({ where: { id: "singleton" } })).enabled).toBe(false);
  });

  it("идёт скан лидов (аренда) или стартовая разметка — фоновый ждёт", async () => {
    await setState({ enabled: true, baselineAt: new Date(now.getTime() - 3600_000), scanLeaseUntil: new Date(now.getTime() + 60_000) });
    expect(await original.claimSomonRequest(now, 10000, { background: true })).toBeNull();
    await setState({ enabled: true, baselineAt: null });
    expect(await original.claimSomonRequest(now, 10000, { background: true })).toBeNull();
  });

  it("не вклинивается в паузу парсера: слот только через запас после общего интервала", async () => {
    await setState({ enabled: true, baselineAt: new Date(now.getTime() - 3600_000), blockedUntil: new Date(now.getTime() - 1000) });
    expect(await original.claimSomonRequest(now, 10000, { background: true })).toBeNull(); // интервал вышел 1 с назад — ещё в зоне лидов
    expect(await original.claimSomonRequest(now, 10000)).toEqual(expect.any(String)); // а лиды слот получают
    await setState({ enabled: true, baselineAt: new Date(now.getTime() - 3600_000), blockedUntil: new Date(now.getTime() - BACKGROUND_YIELD_MS) });
    expect(await original.claimSomonRequest(now, 10000, { background: true })).toEqual(expect.any(String));
  });

  it("остановленный источник (403) не отдаёт слот и фоновому; isSomonSourceStopped это видит", async () => {
    await setState({ enabled: false, sourceStopped: true });
    expect(await original.claimSomonRequest(now, 10000, { background: true })).toBeNull();
    expect(await isSomonSourceStopped()).toBe(true);
  });
});
