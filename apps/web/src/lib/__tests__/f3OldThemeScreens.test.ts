import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Перепись экранов 24.10.2026 нашла окна и страницы вне темы «Royal Home 2026»:
 * на старых Tailwind-классах и без области `.rh2`. Тест закрепляет перенос:
 * разметка живёт в области темы, а прежние классы не возвращаются.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

/** Классы старого облика, которых в перенесённой разметке быть не должно. */
const LEGACY = /className="[^"]*\b(text-gray-\d+|bg-card|text-muted|border-line(?:-soft)?|bg-hover-tint|bg-bg|bg-green|text-amber)\b/;

describe("экраны, перенесённые на тему Royal Home 2026", () => {
  it("NotFound целиком в области темы", () => {
    const src = read("components/NotFound.tsx");
    expect(src).toContain("<Rh2Screen>");
    expect(src).not.toMatch(LEGACY);
  });

  it("форма объекта без классов старого облика", () => {
    expect(read("components/PropertyFormModal.tsx")).not.toMatch(LEGACY);
  });

  it("наборщик в области темы с непрозрачным листом", () => {
    const src = read("components/DialPad.tsx");
    expect(src).toContain("<Rh2Portal>");
    expect(src).not.toMatch(LEGACY);
    const css = read("theme-2026-dialpad.css").replace(/\/\*[\s\S]*?\*\//g, "");
    // Лист — сплошной токен страницы, а не полупрозрачный `--c-bg` (60% альфы).
    expect(css).toMatch(/\.dp\{[^}]*background:var\(--page\)/);
    expect(css).not.toContain("--c-bg");
  });

  it("панель уведомлений шапки в области темы", () => {
    const src = read("components/Topbar.tsx");
    expect(src).toContain("<Rh2Portal>");
    expect(src).not.toContain("sh-notice-item");
    expect(src).not.toContain("glass-notice-enter");
  });

  it("ошибка карточки клиента на Rh2Screen, без прежнего EmptyState", () => {
    const src = read("pages/ClientDetail.tsx");
    expect(src).not.toContain('from "../components/EmptyState"');
    expect(src).toContain('title="Не удалось загрузить карточку"');
    expect(src).toContain('title="Карточка не найдена"');
  });
});
