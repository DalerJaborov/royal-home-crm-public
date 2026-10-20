import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { siteSyncFailureText } from "../siteSyncFeedback";

/** Аудит 04.10.2026, WEB-PAGES20: отказ публикации одного объекта скрывался, а тост говорил «Сохранено». */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("итог публикации на сайт", () => {
  it("всё прошло: нет текста отказа", () => {
    expect(siteSyncFailureText([{ ok: true }, { ok: true }])).toBeNull();
  });

  it("один объект с отказом: показываем причину", () => {
    expect(siteSyncFailureText([{ ok: false, error: "SITE_TIMEOUT" }])).toBe("SITE_TIMEOUT");
  });

  it("пачка: сколько из скольких и первая причина", () => {
    expect(siteSyncFailureText([{ ok: true }, { ok: false, error: "SITE_TIMEOUT" }, { ok: true }])).toBe(
      "1 из 3 объектов не синхронизированы: SITE_TIMEOUT",
    );
  });

  it("отказ без текста получает запасное сообщение", () => {
    expect(siteSyncFailureText([{ ok: false }])).toBe("Не удалось синхронизировать с сайтом");
  });
});

describe("экраны", () => {
  it("хук не даёт общему тосту сказать «Сохранено» при отказе по объекту", () => {
    const src = read("../../hooks/useProperties.ts");
    const hook = src.slice(src.indexOf("export function useSyncToSite"), src.indexOf("Клиент, которому может подойти"));
    expect(hook).toContain("silent: true");
    expect(hook).toContain("siteSyncFailureText(");
  });

  it("сообщение bulkError выводится и без отмеченных галочек", () => {
    const src = read("../../pages/Properties.tsx");
    expect(src).toContain("{bulkError && (");
    // панель выбора закрыта (`</div>` и `)}` после «Снять выбор») РАНЬШЕ, чем блок ошибки,
    // то есть он не вложен в `selectedIds.size > 0`
    expect(src).toMatch(/Снять выбор\s*<\/button>\s*<\/div>\s*\)\}[\s\S]*\{bulkError && \(/);
  });
});
