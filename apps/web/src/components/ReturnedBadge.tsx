/**
 * Вынесен из pages/Clients.tsx в отдельный файл (аудит циклов 03.09.2026), чтобы
 * списки клиентов не импортировали друг друга по кругу. Поведение и вид не менялись.
 */
const RETURNED_BADGE_DAYS = 7;

/** Клиент вернулся не раньше, чем неделю назад: решение «показывать ли пометку» в одном месте. */
export function isRecentlyReturned(returnedAt?: string | null): boolean {
  if (!returnedAt) return false;
  return (Date.now() - new Date(returnedAt).getTime()) / 86400000 <= RETURNED_BADGE_DAYS;
}

/** Минимальная точка вместо иконки/эмодзи (владелец 19.08.2026, выбрано из
 *  подборки вариантов) — тот же язык, что у статуса «онлайн»: не отвлекает,
 *  но заметен в периферийном зрении при беглом просмотре списка. */
export function ReturnedBadge({ returnedAt }: { returnedAt?: string | null }) {
  if (!isRecentlyReturned(returnedAt)) return null;
  return (
    <span className="inline-flex items-center gap-[5px] text-[13px] font-medium text-gray-500 whitespace-nowrap">
      <span className="w-[6px] h-[6px] rounded-full bg-green shrink-0 shadow-[0_0_0_2.5px_rgba(34,197,94,0.18)]" />
      Вернулся
    </span>
  );
}
