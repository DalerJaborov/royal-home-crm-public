/**
 * Сделка всё ещё закрыта (и не аннулирована)? Заданиям очереди после закрытия
 * (deal-close-followup, deal-review-ask) это надо проверять на КАЖДОМ запуске:
 * между постановкой (или упавшей попыткой с backoff) и запуском сделку могли
 * аннулировать (lib/dealAnnul.ts переводит её в CANCELLED), а аннулирование
 * задания очереди не отменяет. Без проверки повтор снова «продаёт» объект на
 * сайте или спрашивает клиента о сделке, которой больше нет (аудит Codex 04.10).
 */
export function isDealStillClosed(deal: { stage: string; annulledAt: Date | null }): boolean {
  return deal.stage === "COMPLETED" && !deal.annulledAt;
}
