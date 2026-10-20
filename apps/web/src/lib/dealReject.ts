/**
 * Возврат сделки на доработку: сервер требует причину (routes/deals.ts,
 * `isRejecting && !rejectReason` → 400; схема — от 3 до 500 знаков). Кнопка
 * «Вернуть» слала этап без причины и всегда получала ошибку (аудит 23.09.2026, №35).
 */
export const DEAL_REJECT_REASON_MIN = 3;

export function dealRejectBody(reason: string): { stage: "CONTRACT_SIGNED"; rejectReason: string } | null {
  const text = reason.trim();
  if (text.length < DEAL_REJECT_REASON_MIN) return null;
  return { stage: "CONTRACT_SIGNED", rejectReason: text.slice(0, 500) };
}
