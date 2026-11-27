/**
 * ЧТО «ТРЕБУЕТ ВНИМАНИЯ СЕЙЧАС» И СКОЛЬКО ТАКИХ ПУНКТОВ (27.11.2026, пачка shell2; сведено с home2 #504).
 *
 * Одно правило — здесь, и зовут его ОБЕ стороны:
 *  - главная руководителя (components/look/home2/blocks.tsx → PulseTiles): плитки «Ждут ответа» и
 *    «Горит» и строки «Ещё срочно» под ними — какие числа брать и у кого (просрочки агентов — только РОП);
 *  - метка у «Сегодня» в меню нового вида (components/look/shell/useTodayBadge.ts, макет «Сегодня 3») —
 *    сколько из этих пунктов сейчас больше нуля.
 * Так метка не может разойтись с тем, что человек увидит на главной: обе берут числа одной функцией.
 * Пункты: клиенты ждут ответа в чатах, «горит» (первая линия), пропущенные звонки за сегодня, заявки
 * ждут принятия, у РОП — просроченные задачи агентов.
 */
export interface AttentionSources {
  waitingHuman?: number | null;
  burning?: number | null;
  missedCallsToday?: number | null;
  unaccepted?: number | null;
  overdueTasks?: number | null;
}

/** Структурный срез снимка пульта и живой сводки — только поля, которые нужны правилу. */
export interface AttentionInput {
  hero?: { missedCallsToday?: number | null } | null;
  bot?: { attention?: { waitingHuman?: { count?: number | null } | null } | null } | null;
  firstLine?: { totalCount?: number | null } | null;
  team?: { agents?: readonly { overdueTasks?: number | null }[] | null } | null;
  live?: { unacceptedTotal?: number | null } | null;
  /** Просрочки агентов — пункт только у РОП (HEAD_OF_SALES), как на главной. */
  role?: string | null;
}

const numOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Числа пунктов из снимка. Нет источника — null (не «0»): «не знаем» и «всё спокойно» — разные вещи. */
export function attentionSources({ hero, bot, firstLine, team, live, role }: AttentionInput): AttentionSources {
  const agents = role === "HEAD_OF_SALES" && Array.isArray(team?.agents) ? team.agents : null;
  return {
    waitingHuman: numOrNull(bot?.attention?.waitingHuman?.count),
    burning: numOrNull(firstLine?.totalCount),
    missedCallsToday: numOrNull(hero?.missedCallsToday),
    unaccepted: numOrNull(live?.unacceptedTotal),
    overdueTasks: agents ? agents.reduce((sum, agent) => sum + (numOrNull(agent.overdueTasks) ?? 0), 0) : null,
  };
}

/** Сколько пунктов сейчас требуют действия (число больше нуля), а не сумма чисел. */
export function attentionCount(sources: AttentionSources): number {
  const { waitingHuman, burning, missedCallsToday, unaccepted, overdueTasks } = sources;
  return [waitingHuman, burning, missedCallsToday, unaccepted, overdueTasks].filter((value) => typeof value === "number" && value > 0).length;
}
