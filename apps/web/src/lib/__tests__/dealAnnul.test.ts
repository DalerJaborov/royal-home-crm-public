import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dealStageText } from "../dealStageText";

/**
 * «Аннулировать» закрытую сделку (глубокая проверка 02.10.2026, C10; решение
 * владельца «да, по советам»): кнопка с вопросом и причиной у тех, кто
 * одобряет сделки, и метка «аннулирована» в списках. Архив сделок общий для
 * телефона и компьютера (Deals.tsx отдаёт его в MobileDeals).
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("аннулированная сделка на экране", () => {
  it("в списках читается как «Аннулирована», а не «Отменена»", () => {
    expect(dealStageText({ stage: "CANCELLED", annulledAt: "2026-10-02T10:00:00.000Z" })).toBe("Аннулирована");
    expect(dealStageText({ stage: "CANCELLED", annulledAt: null })).not.toBe("Аннулирована");
  });

  it("окно спрашивает подтверждение и причину и называет последствия", () => {
    // Окно — шторка через портал, на сервере не рисуется: проверяем его текст.
    const src = read("../../components/DealAnnulDialog.tsx");
    expect(src).toContain('title="Аннулировать сделку?"');
    expect(src).toContain('<span className="lab">Причина</span>');
    expect(src).toContain("Объект вернётся в продажу");
    expect(src).toMatch(/confirmDisabled=\{tooShort \|\| pending\}/);
  });

  it("архив сделок: кнопка «Аннулировать» по праву одобрять и метка «аннулирована»", () => {
    const src = read("../../pages/Deals.tsx");
    expect(src).toMatch(/\{canComplete && \(\s*<button[\s\S]{0,400}Аннулировать\s*<\/button>/);
    expect(src).toMatch(/d\.annulledAt && \(\s*<span className="chip warn"[\s\S]{0,200}аннулирована/);
    expect(src).toContain("<DealAnnulDialog");
  });

  it("карточка сотрудника: подпись стадии через общее правило", () => {
    const src = read("../../pages/TeamMemberDetail.tsx");
    expect(src).not.toContain("DEAL_STAGE_LABELS[d.stage]");
    expect(src).toContain("dealStageText(d)");
  });
});
