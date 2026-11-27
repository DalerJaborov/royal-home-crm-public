import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Сторож чистки мусора (владелец 28.11.2026): на экране уведомлений во ВСЕХ трёх видах (ПК, телефон, новый вид)
 * есть «Скрыть» у строки, «Скрыть прочитанное» и «Очистить»; кнопка очистки доступна только с правом
 * «Менять настройки CRM»; удаление не уходит без подтверждения с числом строк.
 */
const src = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("экран уведомлений: скрыть и очистить в каждом виде", () => {
  const page = src("pages/Notifications.tsx");
  it("«Скрыть» у строки — в трёх разметках (ПК, телефон, новый вид)", () => {
    expect(page.match(/hide\.mutate\(n\.id\)/g)?.length).toBe(3);
  });
  it("«Скрыть прочитанное» и «Очистить» — в трёх заголовках", () => {
    expect(page.match(/hideRead\.mutate\(\)/g)?.length).toBe(3);
    expect(page.match(/<CleanupButton target="notifications" scope="mine"/g)?.length).toBe(3);
  });
});

describe("кнопка «Очистить»", () => {
  const button = src("components/CleanupButton.tsx");
  it("только с правом settings.manage", () => {
    expect(button).toContain('can("settings.manage")');
  });
  it("перед удалением спрашивает число строк и подтверждение", () => {
    expect(button).toContain("useCleanupPreview");
    expect(button).toContain("<ConfirmDialog");
    expect(button).toContain("Вернуть их будет нельзя");
    expect(button).toMatch(/confirmDisabled=\{[^}]*!count/);
  });
  it("экран настроек: очистка и журнал ошибок подключены", () => {
    expect(src("components/settings/SettingsTabContent.tsx").match(/<DataCleanupSection \/>/g)?.length).toBe(2);
    expect(src("pages/settings/SystemTab.tsx")).toContain('<CleanupButton target="errorLog"');
    expect(src("pages/settings/DataCleanupSection.tsx")).toContain('target="directorAlerts"');
  });
});
