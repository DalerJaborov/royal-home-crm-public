import { THEME_IDS, type ThemeId } from "@royal-home/shared";

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  hint: string;
  /** Цвет для <meta name="theme-color"> — строка браузера/PWA в тон темы. */
  metaColor: string;
  /** Цвета мини-превью в переключателе (Профиль → Оформление). Держать в тон
   * переменным темы в index.css — компилятор эту связь не проверяет. */
  preview: { page: string; card: string; accent: string; text: string };
  /** Тёмная тема или светлая — определяет иконку и направление быстрого
   * переключателя в шапке (ThemeQuickSwitch). */
  isDark: boolean;
  /** Тема-пара для быстрого переключателя в шапке: одно нажатие меняет
   * ТОЛЬКО светлая/тёмная, оставляя цветовую семью прежней. Полный выбор
   * темы — в Профиле → Оформление (AppearanceSettings). */
  pairId: ThemeId;
}

export const DEFAULT_THEME: ThemeId = "royal-home-2026-light";

/** Used only before a personal choice has been loaded; never follows OS changes mid-session. */
export function initialDeviceTheme(): ThemeId {
  try {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "royal-home-2026-night" : DEFAULT_THEME;
  } catch { return DEFAULT_THEME; }
}

/** Record по ThemeId: добавление темы в shared THEME_IDS без метаданных здесь — ошибка компиляции.
 *  Слой 4 миграции «Royal Home 2026» (08.09.2026, docs/pult/theme-2026/layer-3-plan.md §4):
 *  шесть старых тем удалены из реестра — остаётся только пара 2026. */
const THEME_META: Record<ThemeId, Omit<ThemeMeta, "id">> = {
  "royal-home-2026-light": {
    label: "Royal Home 2026 · светлая",
    hint: "Светлая · золото",
    metaColor: "#f4f6f9",
    preview: { page: "#f4f6f9", card: "#ffffff", accent: "#8a6a22", text: "#14161a" },
    isDark: false,
    pairId: "royal-home-2026-night",
  },
  "royal-home-2026-night": {
    label: "Royal Home 2026 · тёмная",
    hint: "Тёмная · золото",
    metaColor: "#141619",
    preview: { page: "#141619", card: "#1c1f24", accent: "#d8b45c", text: "#eef0f3" },
    isDark: true,
    pairId: "royal-home-2026-light",
  },
};

export const THEMES: ThemeMeta[] = THEME_IDS.map((id) => ({ id, ...THEME_META[id] }));
