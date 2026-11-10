import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MatchEvidenceLines, MatchSentChip, MatchTierChip } from "./MatchEvidence";

/** Подбор 2.0 (10.11.2026): уровень вместо процента, что именно совпало, честная уступка. */
describe("подбор: уровень и причины", () => {
  it("уровни подписаны словами, без процентов", () => {
    expect(renderToStaticMarkup(<MatchTierChip tier="exact" />)).toContain("🎯 Точно подходит");
    expect(renderToStaticMarkup(<MatchTierChip tier="alternative" />)).toContain("👍 Можно предложить");
    expect(renderToStaticMarkup(<MatchTierChip tier="needs_verification" />)).toContain("❓ Уточнить");
  });

  it("совпало, уступка, не знаем и спросить — отдельными строками", () => {
    const html = renderToStaticMarkup(<MatchEvidenceLines match={{
      tier: "alternative", reasons: ["Нужный район", "В бюджете"], tradeoffs: ["На 1 комнату меньше (просил 3)"],
      unknowns: ["Площадь объекта не указана"], ask: ["Клиент не говорил про этаж (здесь 1 из 9) — спросите"],
    }} />);
    expect(html).toContain("Совпало: Нужный район · В бюджете");
    expect(html).toContain("Уступка: На 1 комнату меньше (просил 3)");
    expect(html).toContain("Не знаем: Площадь объекта не указана");
    expect(html).toContain("Спросить: Клиент не говорил про этаж");
    expect(html).not.toMatch(/\d+%\s*$/u);
  });

  it("«уже отправляли» — только если отправляли", () => {
    expect(renderToStaticMarkup(<MatchSentChip history={{ lastSentAt: null, sentCount: 0 }} />)).toBe("");
    const iso = new Date(Date.now() - 2 * 86_400_000).toISOString();
    expect(renderToStaticMarkup(<MatchSentChip history={{ lastSentAt: iso, sentCount: 1 }} />)).toMatch(/Уже отправляли (?:2 дня назад|вчера)/u);
  });
});
