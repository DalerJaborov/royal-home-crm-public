import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractAssetUrls,
  isAppUpdateReady,
  prepareAppUpdate,
  resetAppUpdatePrefetch,
} from "../appUpdatePrefetch";

/**
 * Фоновая подготовка новой сборки (переехала из удалённого UpdateOverlay.tsx,
 * 10.09.2026). Проверяем разбор index.html и главное свойство: повторный вызов
 * не запускает второй прогрев — иначе каждый сигнал о новой версии тянул бы
 * весь набор файлов заново.
 */
const INDEX_HTML = `<!doctype html><html><head>
<link rel="stylesheet" href="/assets/index-a1b2.css">
<link rel="manifest" href="/manifest.webmanifest">
</head><body><div id="root"></div>
<script type="module" src="/assets/index-c3d4.js"></script>
<script type="module" src="/assets/index-c3d4.js"></script>
<img src="/uploads/photo.jpg">
<img src="https://example.com/assets/other.js">
</body></html>`;

describe("разбор index.html", () => {
  it("берёт только файлы сборки, без повторов", () => {
    expect(extractAssetUrls(INDEX_HTML)).toEqual([
      "/assets/index-a1b2.css",
      "/manifest.webmanifest",
      "/assets/index-c3d4.js",
    ]);
  });

  it("пустая разметка не роняет разбор", () => {
    expect(extractAssetUrls("")).toEqual([]);
  });
});

describe("фоновая подготовка", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetAppUpdatePrefetch();
    fetchMock = vi.fn(async (url: string) =>
      url.startsWith("/index.html")
        ? { ok: true, text: async () => INDEX_HTML }
        : { ok: true, text: async () => "" }
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetAppUpdatePrefetch();
  });

  it("качает index.html и все файлы сборки, потом отмечается готовой", async () => {
    await prepareAppUpdate();
    const requested = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(requested.some((u) => u.startsWith("/index.html"))).toBe(true);
    expect(requested).toContain("/assets/index-a1b2.css");
    expect(requested).toContain("/assets/index-c3d4.js");
    expect(isAppUpdateReady()).toBe(true);
  });

  it("повторный вызов не запускает второй прогрев", async () => {
    await prepareAppUpdate();
    const afterFirst = fetchMock.mock.calls.length;
    await prepareAppUpdate();
    expect(fetchMock.mock.calls.length).toBe(afterFirst);
  });

  it("мёртвая сеть не отклоняет обещание — подмена просто пойдёт по сети", async () => {
    resetAppUpdatePrefetch();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );
    await expect(prepareAppUpdate()).resolves.toBeUndefined();
    expect(isAppUpdateReady()).toBe(true);
  });
});
