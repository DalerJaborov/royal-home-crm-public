/**
 * Вид каталога объектов: плитка или строки (владелец 12.11.2026 — плитка по
 * умолчанию). Ссылка `?view=` побеждает, дальше — последний выбор человека в
 * этом браузере. Хранилище может быть недоступно (приватное окно) — тогда
 * просто плитка, экран не падает.
 */
export type PropertiesView = "table" | "cards";

const KEY = "rh.properties.view";

function isView(value: string | null): value is PropertiesView {
  return value === "table" || value === "cards";
}

export function initialPropertiesView(fromUrl: string | null): PropertiesView {
  if (isView(fromUrl)) return fromUrl;
  try {
    const stored = window.localStorage.getItem(KEY);
    if (isView(stored)) return stored;
  } catch {
    /* хранилище недоступно */
  }
  return "cards";
}

export function rememberPropertiesView(value: PropertiesView): void {
  try {
    window.localStorage.setItem(KEY, value);
  } catch {
    /* вид просто не запомнится */
  }
}
