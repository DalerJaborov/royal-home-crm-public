import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ claim: vi.fn(), record: vi.fn() }));
vi.mock("../src/lib/somonLeads/sourceBudgetStore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/somonLeads/sourceBudgetStore.js")>()),
  claimSomonRequest: mocks.claim,
  recordSomonResponse: mocks.record,
}));

import { prisma } from "../src/db.js";
import { fetchSomon } from "../src/lib/somonLeads/sourceClient.js";
import { fetchSomonPhoneInteractive } from "../src/lib/somonLeads/phone.js";
import { BACKGROUND_YIELD_MS, LEAD_QUIET_MS, isSomonSourceStopped } from "../src/lib/somonLeads/sourceBudgetStore.js";

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
  it("номер по клику идёт в режиме interactive и только на разрешённый адрес", async () => {
    const request = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ phone: "+992900000000" })));
    expect(await fetchSomonPhoneInteractive("123", request as never)).toBe("+992900000000");
    expect(mocks.claim).toHaveBeenCalledWith(expect.any(Date), 10000, { interactive: true });
    expect(request.mock.calls[0][0]).toBe("https://somon.tj/api/items/get_phone/123/");
    await expect(fetchSomonPhoneInteractive("../x", request as never)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
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

  const leadsOn = { enabled: true, baselineAt: new Date(now.getTime() - 3600_000) };
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("не вклинивается в паузу парсера: слот только через запас после общего интервала", async () => {
    await setState({ ...leadsOn, blockedUntil: ago(1000) });
    expect(await original.claimSomonRequest(now, 10000, { background: true })).toBeNull(); // интервал вышел 1 с назад — ещё в зоне лидов
    expect(await original.claimSomonRequest(now, 10000)).toEqual(expect.any(String)); // а лиды слот получают
  });

  it("после запроса ЛИДОВ обход ждёт 25 с тишины: пауза обработки (страница автора -> номер, 20,4 с) не прерывается", async () => {
    // Последний запрос лидов был 21 с назад (blockedUntil = запрос + 10 с интервала): запас в 3 с давно вышел,
    // но парсер ещё в своей 20-секундной паузе перед номером.
    await setState({ ...leadsOn, blockedUntil: ago(LEAD_QUIET_MS - 2 * 10000 + 6000) });
    expect(await original.claimSomonRequest(now, 10000, { background: true })).toBeNull();
    await setState({ ...leadsOn, blockedUntil: ago(LEAD_QUIET_MS - 10000) });
    expect(await original.claimSomonRequest(now, 10000, { background: true })).toEqual(expect.any(String));
  });

  it("лид получает слот, как прежде, без тишины и меток", async () => {
    await setState({ ...leadsOn, blockedUntil: ago(500), requestLeaseToken: null });
    expect(await original.claimSomonRequest(now, 10000)).toEqual(expect.any(String));
  });

  it("свои последовательные запросы обход тишиной не задерживает: токен с меткой bg: переживает ответ", async () => {
    await setState({ ...leadsOn, blockedUntil: ago(LEAD_QUIET_MS - 10000) });
    const token = await original.claimSomonRequest(now, 10000, { background: true });
    expect(token).toMatch(/^bg:/);
    await original.recordSomonResponse(token!, 200, now);
    expect((await prisma.somonMonitor.findUniqueOrThrow({ where: { id: "singleton" } })).requestLeaseToken).toBe(token);
    // следующий запрос обхода: достаточно запаса после его собственного интервала
    const later = new Date(now.getTime() + 10000 + BACKGROUND_YIELD_MS);
    expect(await original.claimSomonRequest(later, 10000, { background: true })).toMatch(/^bg:/);
    // а лиды перетирают метку: после их запроса тишина снова обязательна
    const lead = await original.claimSomonRequest(new Date(later.getTime() + 20000), 10000);
    expect(lead).not.toMatch(/^bg:/);
    await original.recordSomonResponse(lead!, 200, later);
    expect((await prisma.somonMonitor.findUniqueOrThrow({ where: { id: "singleton" } })).requestLeaseToken).toBeNull();
  });

  it("лиды выключены: тишина не нужна, обход идёт по общему интервалу", async () => {
    await setState({ enabled: false, blockedUntil: ago(BACKGROUND_YIELD_MS) });
    expect(await original.claimSomonRequest(now, 10000, { background: true })).toEqual(expect.any(String));
  });

  it("обход не берёт слот в последние секунды минуты (старт тика лидов), клик — берёт", async () => {
    const late = new Date("2026-11-02T10:00:52Z");
    await setState({ ...leadsOn, blockedUntil: ago(60_000) });
    expect(await original.claimSomonRequest(late, 10000, { background: true })).toBeNull();
    expect(await original.claimSomonRequest(late, 10000, { interactive: true })).toMatch(/^bg:/);
  });

  describe("клик агента (interactive)", () => {
    it("лиды выключены: слот есть (иначе кнопка номера всегда отвечала бы 429), общий интервал соблюдается", async () => {
      await setState({ enabled: false });
      expect(await original.claimSomonRequest(now, 10000, { interactive: true })).toEqual(expect.any(String));
      expect(await original.claimSomonRequest(now, 10000, { interactive: true })).toBeNull(); // интервал ещё не вышел
    });
    it("источник остановлен (403) — слота нет", async () => {
      await setState({ enabled: false, sourceStopped: true });
      expect(await original.claimSomonRequest(now, 10000, { interactive: true })).toBeNull();
    });
    it("уступает скану, стартовой разметке и свежему запросу лидов", async () => {
      await setState({ ...leadsOn, scanLeaseUntil: new Date(now.getTime() + 60_000) });
      expect(await original.claimSomonRequest(now, 10000, { interactive: true })).toBeNull();
      await setState({ enabled: true, baselineAt: null });
      expect(await original.claimSomonRequest(now, 10000, { interactive: true })).toBeNull();
      await setState({ ...leadsOn, blockedUntil: ago(14_000) });
      expect(await original.claimSomonRequest(now, 10000, { interactive: true })).toBeNull();
      await setState({ ...leadsOn, blockedUntil: ago(15_000) });
      expect(await original.claimSomonRequest(now, 10000, { interactive: true })).toEqual(expect.any(String));
    });
  });

  it("остановленный источник (403) не отдаёт слот и фоновому; isSomonSourceStopped это видит", async () => {
    await setState({ enabled: false, sourceStopped: true });
    expect(await original.claimSomonRequest(now, 10000, { background: true })).toBeNull();
    expect(await isSomonSourceStopped()).toBe(true);
  });
});
