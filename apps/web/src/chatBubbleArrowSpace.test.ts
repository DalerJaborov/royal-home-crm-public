import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Стрелка «Сведения о сообщении» лежит в правом верхнем углу пузыря (20.11.2026, кадры iPhone). Строка текста,
 * цитата и метка канала держат справа отступ под неё, иначе стрелка с подложкой ложится поверх слов.
 */
describe("пузырь переписки: место под стрелку", () => {
  const css = readFileSync(new URL("./theme-look-royal-chats.css", import.meta.url), "utf8");
  const rule = css.split("\n").find((line) => line.includes(".ry-msg-text") && line.includes("padding-right")) ?? "";
  it("отступ справа 22 px у текста, цитаты (обе разметки) и метки канала", () => {
    expect(rule).toContain("padding-right: 22px");
    for (const part of [".ry-msg-text", ".quote", "span.border-l-2", "[data-message-channel]:not(.sr-only)"]) expect(rule, part).toContain(part);
  });
  it("кнопка стрелки не раздувается до 44 px общим правилом оболочки", () => {
    expect(css).toMatch(/\.ry-msg-more \{[^}]*min-width: 0; min-height: 0/);
  });
});
