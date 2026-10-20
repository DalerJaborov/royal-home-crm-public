import { prisma } from "../db.js";
import { loadAriCredentials, testAriConnection } from "./telephony/ariClient.js";
import { isWithinDushanbeWindow } from "./dushanbeTime.js";
import { isAlarmDayOff, type DaysOffCalendar } from "./alarmCalendar.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";

/**
 * ПРОСТОЙ ТЕЛЕФОНИИ НЕ ДОЛЖЕН ВЫГЛЯДЕТЬ КАК ЛЕНЬ АГЕНТОВ (дыра 4.2 из
 * docs/karta-resheniy-i-dyr-09-09-2026.md, владелец 09.09.2026).
 *
 * Счётчик тишины («агент не пытался N рабочих дней», lib/clientWorkStalled.ts)
 * считает попытки по ДОКАЗАННЫМ следам, и главный след — звонок через АТС. Станция
 * лежит день: звонков нет ни у кого, попытки не отмечаются, и наутро владелец
 * получает тревогу СРАЗУ ПО ВСЕМ агентам, которые работали как обычно. Одна такая
 * рассылка стоит доверия ко всей системе контроля — а доверие здесь и есть продукт.
 *
 * ТРИ РЕШЕНИЯ, КОТОРЫЕ СТОИТ ЗНАТЬ.
 *
 * 1. ЗОНД, А НЕ ПРИЗНАК В ПАМЯТИ. `isStationConnected()` (lib/telephony/ariEvents.ts)
 *    знает про сокет ТОГО процесса, где живёт. Тревога считает задним числом и из
 *    другого процесса — ей нужна история, поэтому простои пишутся в таблицу.
 *
 * 2. НЕДОСТУПНА = ПРОСТОЙ, ЧЬЯ БЫ ВИНА НИ БЫЛА. Отказ зонда из-за сети контейнера —
 *    для CRM то же самое, что упавшая станция: звонки всё равно не записываются, и
 *    наказывать за них агента нельзя.
 *
 * 3. ЗАЧЁТ ТОЛЬКО В РАБОЧИЕ ЧАСЫ. Ночной простой не отнимает у агента ни одной
 *    возможности позвонить — зачесть его значило бы подарить полдня отсрочки всякому,
 *    включая того, кто правда забросил клиента. Воскресенье и так не идёт в счёт
 *    (календарь тревог), поэтому из зачёта оно тоже исключено.
 */

/** Шаг прохода по простою при подсчёте рабочих минут. 15 минут — это и точность
 *  порядка «четверть часа на сутки», и заведомо дешёвый цикл: простой измеряется
 *  часами, а не месяцами. */
const STEP_MS = 15 * 60 * 1000;

/** Предел прохода — защита от бесконечного цикла на испорченной строке
 *  (startedAt из далёкого прошлого). 60 суток заведомо больше любого реального простоя. */
const MAX_SPAN_MS = 60 * 24 * 3600_000;

export interface OutageWindow {
  startedAt: Date;
  endedAt: Date | null;
}

/**
 * Зонд станции: один дешёвый GET /ari/asterisk/info.
 *
 * Открывает простой на первом отказе и закрывает на первом успехе. Идемпотентен:
 * второй отказ подряд не заводит вторую строку, второй успех подряд ничего не пишет.
 *
 * Никогда не бросает: это служебное измерение, и уронить крон-тик из-за него было бы
 * обменом ценного на служебное.
 */
export async function runStationOutageProbeTick(now: Date = new Date()): Promise<{ down: boolean }> {
  let reachable: boolean;
  let error: string | null = null;
  try {
    const creds = await loadAriCredentials();
    if (!creds) {
      // Телефония не настроена вовсе — это не простой, а другой способ работы.
      // Открытый простой в таком случае закрываем: считать его дальше не по чему.
      await closeOpenOutage(now);
      return { down: false };
    }
    const result = await testAriConnection(creds);
    reachable = result.ok;
    error = result.ok ? null : result.error ?? "неизвестный отказ";
  } catch (err) {
    reachable = false;
    error = describeError(err);
  }

  if (reachable) {
    await closeOpenOutage(now);
    return { down: false };
  }

  const open = await prisma.stationOutage.findFirst({ where: { endedAt: null }, orderBy: { startedAt: "desc" } });
  if (open) {
    // Текст отказа обновляем: в разборе важно, чем простой КОНЧИЛСЯ, а не чем начался.
    await prisma.stationOutage.update({ where: { id: open.id }, data: { lastError: error } });
    return { down: true };
  }

  await prisma.stationOutage.create({ data: { startedAt: now, lastError: error } });
  // В журнал — один раз, на переходе. Дедуп внутри logSystemError не даст
  // повторяться каждым тиком, но и заводить запись на каждом тике незачем.
  void logSystemError("telephony", `Станция недоступна: ${error}`);
  return { down: true };
}

async function closeOpenOutage(at: Date): Promise<void> {
  await prisma.stationOutage.updateMany({ where: { endedAt: null }, data: { endedAt: at } });
}

/**
 * Простои, пересекающиеся с окном [from, to]. Незакрытый простой считается идущим
 * до `to` — станция может лежать прямо сейчас, и ждать её возвращения, чтобы
 * перестать обвинять агентов, поздно.
 */
export async function outagesBetween(from: Date, to: Date): Promise<OutageWindow[]> {
  if (to <= from) return [];
  const rows = await prisma.stationOutage.findMany({
    where: { startedAt: { lt: to }, OR: [{ endedAt: null }, { endedAt: { gt: from } }] },
    select: { startedAt: true, endedAt: true },
    orderBy: { startedAt: "asc" },
  });
  return rows;
}

/**
 * Сколько РАБОЧИХ миллисекунд окна [from, to] пришлось на простой станции.
 *
 * Чистая функция — простои передаются снаружи, в базу не ходит: её зовут и крон по
 * списку клиентов (один запрос на весь тик, а не по клиенту — то же правило, что у
 * money в propertyMatchFilter), и тесты.
 */
export function workingOutageMs(
  from: Date,
  to: Date,
  outages: readonly OutageWindow[],
  window: { start: string; end: string },
  /** Выходные (общие и агента) — те же, что у счётчика, к которому идёт поправка
   *  (11.10.2026). Не передан — выходных нет. */
  cal?: DaysOffCalendar
): number {
  if (to <= from || outages.length === 0) return 0;
  let total = 0;
  for (const outage of outages) {
    const start = outage.startedAt > from ? outage.startedAt : from;
    const end = (outage.endedAt ?? to) < to ? (outage.endedAt ?? to) : to;
    if (end <= start) continue;
    if (end.getTime() - start.getTime() > MAX_SPAN_MS) continue;
    for (let t = start.getTime(); t < end.getTime(); t += STEP_MS) {
      // Шаг засчитывается по СЕРЕДИНЕ: так граница рабочего дня не даёт ни лишней
      // четверти часа, ни потерянной, и результат не зависит от того, с какой
      // минуты простой начался.
      const mid = new Date(Math.min(t + STEP_MS / 2, end.getTime()));
      if (isAlarmDayOff(mid, cal)) continue;
      if (!isWithinDushanbeWindow(window.start, window.end, mid)) continue;
      total += Math.min(STEP_MS, end.getTime() - t);
    }
  }
  return total;
}

/**
 * Сколько миллисекунд окна [from, to] станция лежала — по часам, без рабочего окна.
 *
 * Для коротких сроков, которые тикают в реальном времени («первый звонок за 15
 * минут», firstCall.ts): 23.09.2026 станция лежала 11:57–13:06, агенты жали
 * «Позвонить» и получали «Нет связи», а срок шёл — и в 12:50 крон снял у двух
 * агентов клиентов «за то, что не позвонили». Срок обязан стоять, пока звонить
 * физически нельзя: к нему прибавляется ровно время простоя.
 *
 * Чистая функция — простои передаются снаружи (один запрос на тик).
 */
export function outageOverlapMs(from: Date, to: Date, outages: readonly OutageWindow[]): number {
  if (to <= from) return 0;
  let total = 0;
  for (const outage of outages) {
    const start = Math.max(outage.startedAt.getTime(), from.getTime());
    const end = Math.min((outage.endedAt ?? to).getTime(), to.getTime());
    if (end > start) total += end - start;
  }
  return total;
}

/** Рабочее окно из Настроек — одним запросом на тик, а не на клиента. */
export async function loadWorkWindow(): Promise<{ start: string; end: string }> {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { workHoursStart: true, workHoursEnd: true },
    });
    return { start: settings?.workHoursStart ?? "09:30", end: settings?.workHoursEnd ?? "18:00" };
  } catch {
    return { start: "09:30", end: "18:00" };
  }
}
