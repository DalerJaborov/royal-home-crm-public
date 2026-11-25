import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RegistryBadge } from "../RegistryBadge";

/**
 * Значок реестра строек в списке объектов (25.11.2026): смысл не держится на одном цвете — слово в самом значке,
 * подсказка в title/aria-label; у жёлтого и красного подсказка несёт предупреждение; нет данных — значка нет.
 */
const html = (brief: Parameters<typeof RegistryBadge>[0]["brief"]) => renderToString(<RegistryBadge brief={brief} />);

describe("RegistryBadge", () => {
  it("нет данных — ничего не рисует", () => {
    expect(html(null)).toBe("");
    expect(html(undefined)).toBe("");
  });
  it("зелёный: слово, title и aria-label с оценкой застройщика", () => {
    const out = html({ status: "green", letter: "B" });
    expect(out).toContain("Разрешение есть");
    expect(out).toContain('class="chip ok"');
    expect(out).toMatch(/aria-label="Реестр строек: разрешение есть, оценка застройщика B\."/);
  });
  it("красный: предупреждение в подсказке", () => {
    const out = html({ status: "red", letter: null });
    expect(out).toContain("Разрешения нет");
    expect(out).toContain("chip crit");
    expect(out).toContain("предупредите клиента");
  });
  it("новостройка без связи: «Реестр: проверить»", () => {
    const out = html({ status: "none", letter: null });
    expect(out).toContain("Реестр: проверить");
    expect(out).toContain("проверьте вручную");
  });
  it("без инлайнового размера шрифта (ничего мельче 13 px)", () => {
    expect(html({ status: "yellow", letter: "C" })).not.toMatch(/font-size/);
  });
});
