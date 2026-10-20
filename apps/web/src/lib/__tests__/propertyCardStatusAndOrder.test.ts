import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Разбор карточки объекта 24.09.2026: пункты 5 (статус из просмотра) и 12 (порядок блоков).
 *  С 06.10.2026 карточка одна на ПК и телефон (контракт, раздел 6): порядок задаёт разметка
 *  `.rh-pcard`, а не две ветки `useMobileUx`. */
const src = readFileSync(join(__dirname, "../../pages/PropertyDetail.tsx"), "utf8");
const css = readFileSync(join(__dirname, "../../theme-royal-home-2026.css"), "utf8");
const view = src.slice(src.indexOf("function PropertyViewCard("), src.indexOf("function TrashedBanner("));

describe("карточка объекта: статус, порядок, одна раскладка", () => {
  it("в просмотре «Решить сейчас» даёт сменить статус тем, кому открыта правка", () => {
    const solve = view.slice(view.indexOf("const viewSolve = ("), view.indexOf("// Ролик одной строкой"));
    expect(solve).toContain("{canChangeStatus && (");
    expect(solve).toContain("<StatusRow");
    expect(src).toContain("const canChangeStatus = canEditAny && !isTrashed && !isDealDriven && statusOptions.length > 1;");
  });

  it("блок «Решить сейчас» набран один раз и показан один раз", () => {
    expect(src.match(/\{showSolve && viewSolve\}/g)).toHaveLength(1);
    expect(src.match(/<h2>Решить сейчас<\/h2>/g)).toHaveLength(1);
  });

  it("legacy телефона изолирован: только AGENT <820, desktop сохраняет одну раскладку", () => {
    expect(src).toContain('const legacyAgentMobile = useLegacyAgentMobile();');
    expect(src).toContain('if (legacyAgentMobile) {');
    expect(src).toContain('<LegacyAgentPropertyView');
    const selector = readFileSync(join(__dirname, "../../hooks/useLegacyAgentMobile.ts"), "utf8");
    expect(selector).toContain('return narrow && role === "AGENT" && !clean;');
    expect(src).not.toContain("isEditMode");
    expect(src).not.toContain('from "../hooks/useMobileUx"');
    expect(src).not.toContain("if (mobileUx)");
    expect(src).not.toContain("PropertyMobileBlocks");
    expect(src.match(/<PropertyGallery /g)).toHaveLength(1);
    expect(src.match(/<PropertyPriceCard/g)).toHaveLength(1);
  });

  it("одна шапка: заголовок и «Назад» идут через оболочку, своя «‹ Объекты» только на ПК", () => {
    expect(view).toContain('<Rh2Screen title={`Объект №${property.shortId}`} back="/properties"');
    expect(view).toContain('<div className="only-wide">');
    expect(view).not.toContain("useGoBack");
  });

  it("порядок: фото, цена с действиями, кто ведёт, ролик, что решить, сделка, затем вкладки", () => {
    const order = [
      "<PropertyGallery",
      "<PropertyPriceCard",
      "{fieldsBlock}",
      'data-testid="property-video-stage"',
      "{showSolve && viewSolve}",
      "{dealSlot}",
      'id="rh-pcard-tabs"',
    ].map((tag) => view.indexOf(tag));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("описание на телефоне уходит за главные блоки, на ПК стоит под фото", () => {
    expect(view).toContain('className="rh-pcard-desc"');
    expect(css).toContain(".rh2 .scr .rh-pcard-desc {\n  order: 2;\n}");
    expect(css).toContain("@media (min-width: 1180px)");
  });

  it("вкладок три для всех, «Статистика» и «Голос рынка» только ведущему объект", () => {
    expect(view).toContain('{ id: "short", label: "Коротко" }');
    expect(view).toContain('{ id: "media", label: "Фото и видео" }');
    expect(view).toContain('{ id: "hist", label: "История" }');
    expect(view).toContain("...(isResponsibleForProperty");
    expect(view).toContain('tab === "stats" && isResponsibleForProperty');
    expect(view).toContain('tab === "voice" && isResponsibleForProperty');
  });
});
