import type { Interaction } from "../types";

/**
 * Факты истории клиента для кнопок «Завершить сделку» / «Передать» и вкладки
 * звонков. Карточка приносит только последние 200 записей хронологии, а факты
 * «был проведённый показ», «был настоящий разговор» и счёт звонков раньше
 * выводились из них: после 200 новых служебных записей старый показ пропадал и
 * кнопки прятались (аудит 04.10.2026, WEB-PAGES21). Теперь их считает сервер по
 * полной таблице (routes/clients/card.ts); локальный расчёт остаётся для старого
 * ответа без этих полей и для только что добавленной записи, пока карточка не
 * перечитана. Факты монотонны («было»), поэтому серверное и локальное значения
 * объединяются: больше найденного — верно.
 */
export interface HistoryFactsInput {
  interactions?: Interaction[];
  hadConductedShowing?: boolean;
  hadRealCall?: boolean;
  callsCount?: number;
  lastClientMessageAt?: string | null;
}

export interface HistoryFacts {
  hadShowing: boolean;
  hadRealCall: boolean;
  hadRealContact: boolean;
  callsCount: number;
}

export function clientHistoryFacts(client: HistoryFactsInput | undefined, leadCallMinSeconds: number, now: number = Date.now()): HistoryFacts {
  const list = client?.interactions ?? [];
  // «Проведён» — как на сервере (lib/conductedShowing.ts): не отменён и либо отмечен
  // выполненным, либо записан задним числом, либо его время уже прошло.
  const localShowing = list.some(
    (i) =>
      i.type === "SHOWING" &&
      !i.declinedAt &&
      (!!i.completedAt || !i.nextActionDate || new Date(i.nextActionDate).getTime() <= now)
  );
  const localRealCall = list.some((i) => i.type === "CALL" && (i.recordingDurationSec ?? 0) >= leadCallMinSeconds);
  const hadShowing = !!client?.hadConductedShowing || localShowing;
  const hadRealCall = !!client?.hadRealCall || localRealCall;
  return {
    hadShowing,
    hadRealCall,
    // Та же метрика, что у серверного гейта передачи: показ, ответ клиента или звонок с ответом.
    hadRealContact: hadShowing || !!client?.lastClientMessageAt || hadRealCall,
    callsCount: Math.max(client?.callsCount ?? 0, list.filter((i) => i.type === "CALL").length),
  };
}
