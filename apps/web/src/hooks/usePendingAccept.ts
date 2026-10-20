import { useEffect, useMemo, useState } from "react";

/**
 * Просрочка принятия лида: считаем, показывает ли красный тон карточка
 * «N дел на сегодня» (главная агента), и когда пересчитать это без новых
 * данных с сервера.
 *
 * Перенесено из бывшего `useAiFaceMood.ts` (15.09.2026, удаление знака ИИ):
 * логика расчёта не изменилась, но публикация в шину настроения знака и
 * звук «внимание» убраны — они были частью удалённой функции, а не самого
 * расчёта просрочки.
 */

/** Минимум полей лида, нужный для расчёта просрочки принятия. */
export interface PendingAcceptRow {
  assignedAt: string;
  acceptedAt?: string | null;
  escalatedAt?: string | null;
}

/**
 * Тревога по лидам, ждущим принятия, — «дольше `leadAcceptMinutes`».
 *
 * Та же арифметика, что рисует таймер в карточке «Сначала это» на Главной (`PendingTimer`), и
 * тот же признак эскалации: лид, который сервер уже перекинул дальше
 * (`escalatedAt` при пустом `acceptedAt`), просрочен независимо от таймера.
 *
 * `leadAcceptMinutes === null` — настройка не пришла (не у всех ролей она
 * есть в ответе `/settings`). Тогда таймер не считаем и остаётся только
 * признак эскалации: честное «нет данных» вместо подставленного значения по
 * умолчанию, которое дало бы ложную тревогу.
 */
export function pendingAcceptAlert(
  rows: PendingAcceptRow[] | undefined,
  leadAcceptMinutes: number | null,
  now: number
): { alert: boolean; nextDueAt: number | null } {
  let alert = false;
  let nextDueAt = Infinity;
  for (const r of rows ?? []) {
    if (r.acceptedAt) continue;
    if (r.escalatedAt) {
      alert = true;
      continue;
    }
    if (leadAcceptMinutes === null) continue;
    const assigned = Date.parse(r.assignedAt);
    if (Number.isNaN(assigned)) continue;
    const due = assigned + leadAcceptMinutes * 60_000;
    if (due <= now) alert = true;
    else nextDueAt = Math.min(nextDueAt, due);
  }
  return { alert, nextDueAt: Number.isFinite(nextDueAt) ? nextDueAt : null };
}

/**
 * Есть ли лид, просрочивший принятие, + таймер, перезапускающий расчёт ровно
 * к моменту следующего срока.
 *
 * ПОЧЕМУ СВОЙ ТАЙМЕР, А НЕ `Date.now()` НА РЕНДЕРЕ. Просрочка наступает не от
 * прихода новых данных, а от хода часов: лид, назначенный минуту назад, станет
 * просроченным сам собой, без единого запроса. Секундный тик, который рисует
 * обратный отсчёт, живёт ВНУТРИ строки лида (`PendingSection`), и родительский
 * экран от него не перерисовывается — значит `Date.now()`, прочитанный на
 * рендере родителя, застынет до следующего обновления списка, и знак узнает о
 * просрочке с опозданием в целый интервал refetch.
 *
 * Поэтому здесь ровно ОДИН `setTimeout` — на ближайший срок из списка. Не
 * ежесекундный интервал: между двумя сроками пересчитывать нечего, а лишний
 * таймер на каждом открытии главной агента — это батарея телефона.
 */
export function usePendingAcceptAlert(
  rows: PendingAcceptRow[] | undefined,
  leadAcceptMinutes: number | null
): boolean {
  const [now, setNow] = useState(() => Date.now());
  // Список приходит из TanStack Query новым массивом на каждый рендер, поэтому
  // зависимость — его содержимое, а не ссылка: иначе memo пересчитывался бы
  // всегда и таймер пересоздавался бы на каждом рендере.
  const key = (rows ?? []).map((r) => `${r.assignedAt}|${r.acceptedAt ?? ""}|${r.escalatedAt ?? ""}`).join(",");
  const { alert, nextDueAt } = useMemo(
    () => pendingAcceptAlert(rows, leadAcceptMinutes, now),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` заменяет `rows` намеренно, см. выше
    [key, leadAcceptMinutes, now]
  );

  useEffect(() => {
    if (nextDueAt === null) return;
    // Пол в 250 мс: срок мог наступить, пока считали, — без пола получился бы
    // таймер на 0 мс и лишний оборот рендера.
    const id = setTimeout(() => setNow(Date.now()), Math.max(250, nextDueAt - Date.now()));
    return () => clearTimeout(id);
  }, [nextDueAt]);

  return alert;
}
