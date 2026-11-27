/**
 * СКОЛЬКО ПУНКТОВ «ТРЕБУЕТ ВНИМАНИЯ СЕЙЧАС» (27.11.2026, пачка shell2).
 *
 * Метка у «Сегодня» в меню нового вида (макет: «Сегодня 3» — столько решений ждут руководителя)
 * считает те же три пункта, что полоса «Требует внимания сейчас» на главной руководителя
 * (components/look/home/blocks/dashboardHome.tsx → AttentionStrip): клиенты ждут ответа в чатах,
 * пропущенные звонки за сегодня, заявки ждут принятия. Одно правило — здесь; полосе стоит звать
 * его же (файл пачки home2, в этой правке не трогали).
 */
export interface AttentionSources {
  waitingHuman?: number | null;
  missedCallsToday?: number | null;
  unaccepted?: number | null;
}

export function attentionCount({ waitingHuman, missedCallsToday, unaccepted }: AttentionSources): number {
  return [waitingHuman, missedCallsToday, unaccepted].filter((value) => typeof value === "number" && value > 0).length;
}
