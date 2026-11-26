import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectSiteStats } from "../src/lib/siteStats.js";

/**
 * Клик-аудит 26.11.2026: директор по нажатию «Опубликовать» читал «…не настроена
 * (SITE_SYNC_URL/SITE_SYNC_API_KEY)» — названия переменных окружения человеку ни к чему.
 * Ответы API про ненастроенный сайт говорят простыми словами; имена — только в журнале сервера.
 */
afterEach(() => vi.unstubAllEnvs());

const SRC = join(__dirname, "..", "src");

describe("ненастроенный сайт — без имён переменных в ответе", () => {
  it("collectSiteStats: понятный текст, без SITE_SYNC", async () => {
    vi.stubEnv("SITE_SYNC_URL", "");
    const res = await collectSiteStats();
    expect(res).toMatchObject({ ok: false, notConfigured: true });
    expect((res as { error: string }).error).not.toMatch(/SITE_SYNC/);
    expect((res as { error: string }).error).toMatch(/администратор/);
  });

  for (const file of ["lib/siteSync.ts", "lib/siteStats.ts", "routes/settings.ts"]) {
    it(`${file}: строки ответа (error: "…") не содержат SITE_SYNC`, () => {
      const bad = readFileSync(join(SRC, file), "utf8")
        .split(/\r?\n/)
        .filter((l) => /error:\s*["'`]/.test(l) && /SITE_SYNC/.test(l));
      expect(bad).toEqual([]);
    });
  }
});
