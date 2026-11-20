import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { commonMatchGaps, MatchCommonGaps, MatchEvidenceLines, MatchSentChip, MatchTierChip } from "./MatchEvidence";

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
      unknowns: ["Площадь объекта не указана"], ask: ["Клиент не говорил про этаж (здесь 1 из 9)"],
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

/** Владелец 20.11.2026: простыня «Не знаем / Спросить» повторялась на КАЖДОЙ карточке подбора. */
describe("подбор: общее «чего не знаем о клиенте» — один раз над списком", () => {
  const base = { tier: "alternative" as const, reasons: [], tradeoffs: [] };
  const common = { unknowns: ["Клиент не назвал район или ориентир", "Клиент не назвал бюджет"], ask: ["Остальное из заметок клиента проверьте перед отправкой"] };
  const items = [
    { match: { ...base, unknowns: [...common.unknowns], ask: [...common.ask, "Клиент не говорил про этаж (здесь 13 из 15)"] } },
    { match: { ...base, unknowns: [...common.unknowns, "Этаж объекта не указан"], ask: [...common.ask] } },
  ];
  it("общее выносится, своё остаётся на карточке", () => {
    const gaps = commonMatchGaps(items);
    expect(gaps.unknowns).toEqual(common.unknowns); expect(gaps.ask).toEqual(common.ask);
    const head = renderToStaticMarkup(<MatchCommonGaps gaps={gaps} />);
    expect(head).toContain("Чего мы не знаем о клиенте: Клиент не назвал район или ориентир · Клиент не назвал бюджет");
    const card = renderToStaticMarkup(<MatchEvidenceLines match={items[0].match} hide={gaps.hide} />);
    expect(card).not.toContain("Клиент не назвал"); expect(card).not.toContain("Остальное из заметок");
    expect(card).toContain("Спросить: Клиент не говорил про этаж (здесь 13 из 15)");
    expect(renderToStaticMarkup(<MatchEvidenceLines match={items[1].match} hide={gaps.hide} />)).toContain("Не знаем: Этаж объекта не указан");
  });
  it("один объект в списке или объект без оценки — выносить нечего, карточка показывает всё как раньше", () => {
    expect(commonMatchGaps([items[0]]).hide.size).toBe(0);
    expect(commonMatchGaps([items[0], { match: undefined }]).hide.size).toBe(0);
    expect(renderToStaticMarkup(<MatchCommonGaps gaps={commonMatchGaps([items[0]])} />)).toBe("");
    expect(renderToStaticMarkup(<MatchEvidenceLines match={items[0].match} />)).toContain("Не знаем: Клиент не назвал район");
  });
});
