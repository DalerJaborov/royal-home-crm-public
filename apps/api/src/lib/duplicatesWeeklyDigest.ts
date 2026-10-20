/**
 * ЕЖЕНЕДЕЛЬНОЕ НАПОМИНАНИЕ О ВЕРОЯТНЫХ ДУБЛИКАТАХ (владелец 06.09.2026, разбор
 * слепых зон п.3).
 *
 * Экран «Клиенты → Дубли» (routes/clients/duplicates.ts) ничего не толкает
 * сам — кнопка появляется только тогда, когда человек уже открыл список
 * клиентов, и только тем, у кого есть право clients.merge. Раньше это
 * означало «зашёл — увидел, не зашёл — не увидел», без единого сигнала со
 * стороны CRM.
 *
 * НЕ аларм на каждую находку — это и есть перегрузка, которую владелец прямо
 * просил не создавать (тот же принцип, что у счётчика пустых комментариев).
 * Вместо этого: раз в неделю ОДНО уведомление тем же людям, что видят экран,
 * с текущим числом групп — если оно больше нуля. Не через тяжёлый «Разбор
 * недели» (problemReport.ts — там своя типизированная схема секций и
 * персистентный отчёт для отдельного экрана), а отдельным лёгким пушем в
 * той же каданс, что и остальные короткие крон-алармы (buyerNoCallAlarm.ts,
 * phoneLeadWatchdog.ts).
 */
import { dushanbeWallClock } from "./dushanbeTime.js";
import { pluralizeRu } from "@royal-home/shared";
import { findDuplicateClientGroups } from "./duplicateClients.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";

/**
 * Ставит еженедельное напоминание в очередь алармов руководству (владелец
 * 07.09.2026, разбор часов алармов) — сама эта функция запускается по крону
 * раз в неделю в ФИКСИРОВАННОЕ время («20 9 * * 1», cron.ts), которое не
 * обязано попадать в текущие часы алармов (Settings.alarmHours*, можно
 * менять); гейтить эту функцию напрямую было бы опасно — единственный шанс
 * на неделю мог бы просто потеряться. Через очередь: посчитано сразу, а
 * доставит её lib/directorAlertQueue.ts::flushDirectorAlertQueue, когда
 * откроются часы алармов (в этот же день или на следующий тик).
 */
export async function runDuplicatesWeeklyDigestTick(now: Date = new Date()): Promise<{ notified: number }> {
  const found = await findDuplicateClientGroups();
  const count = found.overLimit ? 0 : found.groups.length;
  if (count === 0) return { notified: 0 };

  // Тег меняется каждую неделю (дата тика по Душанбе) — чтобы напоминание не
  // схлопнулось с прошлым в ленте по tag и пришло заново, даже если число
  // групп с прошлой недели не изменилось.
  const weekKey = dushanbeWallClock(now).toISOString().slice(0, 10);
  await enqueueDirectorAlert({
    title: "🔁 Вероятные дубли клиентов",
    body: `${count} ${pluralizeRu(count, ["похожая пара", "похожие пары", "похожих пар"])} карточек ждут проверки — Клиенты → Дубли`,
    url: "/clients",
    tag: `duplicates-weekly-${weekKey}`,
    kind: "oversight",
    recipientPermission: "clients.merge",
  });

  return { notified: count };
}
