import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ВЕРСИЯ GRAPH ДЛЯ РЕКЛАМЫ (04.10.2026). Marketing API v23 истёк 09.06.2026, v24 истекает
 * 06.10.2026, а общая константа мессенджеров (messengers/meta.ts, «v23.0») обслуживает
 * другое API и менять её нельзя. У рекламных вызовов своя константа ADS_GRAPH_VERSION:
 * по умолчанию «v25.0», переопределяется META_ADS_GRAPH_VERSION, формат проверяется.
 */

const { logSystemError } = vi.hoisted(() => ({ logSystemError: vi.fn(async () => undefined) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));

const ENV_KEY = "META_ADS_GRAPH_VERSION";
const savedEnv = process.env[ENV_KEY];

beforeEach(() => {
  logSystemError.mockClear();
  delete process.env[ENV_KEY];
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

describe("resolveAdsGraphVersion", () => {
  it("без переменной — v25.0, без шума в журнале", async () => {
    const { resolveAdsGraphVersion, DEFAULT_ADS_GRAPH_VERSION } = await import("../src/lib/ads/adsGraphVersion.js");
    expect(DEFAULT_ADS_GRAPH_VERSION).toBe("v25.0");
    expect(resolveAdsGraphVersion(undefined)).toBe("v25.0");
    expect(resolveAdsGraphVersion("   ")).toBe("v25.0");
    expect(logSystemError).not.toHaveBeenCalled();
  });

  it("верное значение из окружения принимается (с пробелами по краям)", async () => {
    const { resolveAdsGraphVersion } = await import("../src/lib/ads/adsGraphVersion.js");
    expect(resolveAdsGraphVersion("v26.0")).toBe("v26.0");
    expect(resolveAdsGraphVersion(" v24.1 ")).toBe("v24.1");
    expect(logSystemError).not.toHaveBeenCalled();
  });

  it.each(["25.0", "v25", "latest", "v25.0.1", "V25.0", "v.0"])(
    "неверный формат «%s» → значение по умолчанию и запись в журнал",
    async (bad) => {
      const { resolveAdsGraphVersion } = await import("../src/lib/ads/adsGraphVersion.js");
      expect(resolveAdsGraphVersion(bad)).toBe("v25.0");
      expect(logSystemError).toHaveBeenCalledTimes(1);
      const [source, message, ctx] = logSystemError.mock.calls[0] as unknown as [string, string, { dedupKey?: string }];
      expect(source).toBe("ads");
      expect(message).toContain("META_ADS_GRAPH_VERSION");
      expect(ctx.dedupKey).toBe("ads-graph-version-invalid");
    }
  );

  it("константа читает окружение при загрузке модуля", async () => {
    process.env[ENV_KEY] = "v26.0";
    const mod = await import("../src/lib/ads/adsGraphVersion.js");
    expect(mod.ADS_GRAPH_VERSION).toBe("v26.0");
  });
});

describe("рекламные запросы идут на ADS_GRAPH_VERSION, мессенджеры остаются на своей", () => {
  function captureUrls(body: unknown): string[] {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      })
    );
    return urls;
  }

  it("по умолчанию: валюта кабинета, группы и объявления — /v25.0/", async () => {
    const urls = captureUrls({ data: [], currency: "USD" });
    const api = await import("../src/lib/ads/metaAdsApi.js");
    const creds = { enabled: true, token: "t", adAccountIds: ["act_1"] };
    await api.fetchAdAccountCurrency(creds, "act_1");
    await api.fetchMetaAdSets(creds, "act_1");
    await api.fetchMetaAds(creds, "act_1");
    expect(urls.length).toBeGreaterThanOrEqual(3);
    for (const u of urls) {
      expect(u).toContain("https://graph.facebook.com/v25.0/");
      expect(u).not.toContain("/v23.0/");
    }
    // Проверка живого кабинета из заметки: GET /{act}?fields=… идёт на ту же версию.
    expect(urls[0]).toEqual(expect.stringContaining("/v25.0/act_1?fields=currency"));
  });

  it("META_ADS_GRAPH_VERSION=v26.0 переводит все рекламные вызовы разом", async () => {
    process.env[ENV_KEY] = "v26.0";
    const urls = captureUrls({ data: [], currency: "USD" });
    const api = await import("../src/lib/ads/metaAdsApi.js");
    const creds = { enabled: true, token: "t", adAccountIds: ["act_1"] };
    await api.fetchAdAccountCurrency(creds, "act_1");
    await api.fetchMetaAdSets(creds, "act_1");
    expect(urls.every((u) => u.includes("/v26.0/"))).toBe(true);
  });

  it("версия мессенджеров не тронута (это другое API)", async () => {
    process.env[ENV_KEY] = "v26.0";
    const meta = await import("../src/messengers/meta.js");
    expect(meta.GRAPH_VERSION).toBe("v23.0");
  });
});
