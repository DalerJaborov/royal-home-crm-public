import { describe, expect, it } from "vitest";
import { migrateLegacyTheme, uiPreferencesSchema, THEME_IDS, DEFAULT_THEME } from "@royal-home/shared";

/**
 * Слой 4 миграции темы «Royal Home 2026» (08.09.2026, docs/pult/theme-2026/layer-3-plan.md §4).
 * THEME_IDS сузился до пары royal-home-2026-light/-night — эти тесты проверяют, что старый id,
 * ещё сохранённый в БД или присланный не обновившимся клиентом, разворачивается в одну из двух
 * тем, а не роняет валидацию (400) и не долетает до клиента как есть.
 */
describe("migrateLegacyTheme", () => {
  it("оставляет уже валидный id 2026 без изменений", () => {
    expect(migrateLegacyTheme("royal-home-2026-light")).toBe("royal-home-2026-light");
    expect(migrateLegacyTheme("royal-home-2026-night")).toBe("royal-home-2026-night");
  });

  it("тёмные старые темы уходят в -night", () => {
    expect(migrateLegacyTheme("midnight")).toBe("royal-home-2026-night");
    expect(migrateLegacyTheme("emerald-noir")).toBe("royal-home-2026-night");
    expect(migrateLegacyTheme("violet-aurora")).toBe("royal-home-2026-night");
  });

  it("светлые старые темы уходят в -light", () => {
    expect(migrateLegacyTheme("royal-glass")).toBe("royal-home-2026-light");
    expect(migrateLegacyTheme("emerald-day")).toBe("royal-home-2026-light");
    expect(migrateLegacyTheme("sunset-gold")).toBe("royal-home-2026-light");
  });

  it("неизвестное/пустое значение уходит в дефолт (light)", () => {
    expect(migrateLegacyTheme(undefined)).toBe(DEFAULT_THEME);
    expect(migrateLegacyTheme(null)).toBe(DEFAULT_THEME);
    expect(migrateLegacyTheme("something-nobody-heard-of")).toBe(DEFAULT_THEME);
  });

  it("THEME_IDS содержит ровно пару 2026", () => {
    expect([...THEME_IDS].sort()).toEqual(["royal-home-2026-light", "royal-home-2026-night"]);
  });
});

describe("uiPreferencesSchema — тема", () => {
  it("принимает старый id без 400, разворачивая его через migrateLegacyTheme", () => {
    const parsed = uiPreferencesSchema.safeParse({ theme: "midnight" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.theme).toBe("royal-home-2026-night");
  });

  it("пропускает отсутствие темы (поле необязательное)", () => {
    const parsed = uiPreferencesSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.theme).toBeUndefined();
  });
});
