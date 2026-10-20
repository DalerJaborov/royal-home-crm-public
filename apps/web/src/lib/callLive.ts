/**
 * Подписи живого звонка для «Телефонии» (pages/Telephony.tsx, один экран на оба
 * размера с 14.09). Вынесены из страницы, чтобы их могли использовать другие
 * экраны звонка без копирования строк.
 */

/** Стадии исходящего звонка — теми же словами, что и на экране вызова у агента. */
export const OUTGOING_STATE: Record<string, string> = {
  ringing_agent: "звоним сотруднику",
  ringing_client: "звоним клиенту",
  talking: "разговор",
  ended: "завершён",
};

/** Таймер эфира «м:сс» — тикает каждую секунду, поэтому показывается только
 *  моноширинными цифрами (tabular-nums у вызывающего кода). */
export function formatLiveSeconds(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
