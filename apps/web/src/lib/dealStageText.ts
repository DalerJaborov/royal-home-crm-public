import { DEAL_STAGE_LABELS, type DealStage } from "@royal-home/shared";

/**
 * Подпись стадии сделки в списках. Аннулированная сделка (C10, 02.10.2026)
 * лежит в стадии «Отменена», но в списке читается как «Аннулирована» — это не
 * сорвавшиеся переговоры, а закрытая сделка, которую руководство признало
 * недействительной.
 */
export function dealStageText(deal: { stage: DealStage; annulledAt?: string | null }): string {
  return deal.annulledAt ? "Аннулирована" : DEAL_STAGE_LABELS[deal.stage];
}
