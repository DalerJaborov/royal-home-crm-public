import { prisma } from "../../db.js";
import { deliverPushToAgents, handledByQuietHours } from "../../push.js";
import { createNotifications, shouldAlert } from "../notifications.js";
import { publishNotificationNew } from "../livePublish.js";
import { isWithinAlarmHours } from "../workingHours.js";
import { logSystemError } from "../systemError.js";

/**
 * СТОРОЖ: ВХОДЯЩИЕ ПЕРЕСТАЛИ ДОХОДИТЬ (разбор 19.09.2026).
 *
 * Живой случай, ради которого он написан: с 21.08.2026 весь приём агентства был
 * заведён на аппарат, у которого не осталось ни одного живого плеча. Станция
 * отдавала CHANUNAVAIL, правило «если не ответили» клало трубку — звонок клиента
 * умирал примерно за 50 мс. Снаружи это звучало как «занято», а внутри CRM не
 * появлялось НИЧЕГО: ни ошибки (с точки зрения кода ничего не сломалось), ни
 * даже записи звонка. Месяц входящих прошёл мимо агентства, и узнали об этом не
 * от системы, а от владельца.
 *
 * Поэтому сторож смотрит не на причину, а на ФАКТ — тот же приём, что у
 * phoneLeadWatchdog.ts: неважно, какая ветка кода или какая настройка станции
 * сломается в следующий раз, симптом будет один и тот же.
 *
 * ДВА СИМПТОМА, ОДНА ТРЕВОГА:
 *
 *  1. ТИШИНА. За последние SILENCE_HOURS часов ни одного входящего, хотя в такое
 *     же время в предыдущие дни они были. Порог не фиксированный, а взятый из
 *     собственной истории агентства (см. BASELINE_DAYS): «ноль звонков за четыре
 *     часа» — беда там, где обычно их десяток, и обычный вторник там, где их
 *     два в день. Фиксированное число здесь давало бы либо ложные тревоги, либо
 *     молчание — ровно то, от чего сторож и заводится.
 *
 *     ТОТ ЖЕ ДЕНЬ НЕДЕЛИ (глубокая проверка 02.10.2026, E13; решение владельца
 *     «да, по советам»). Среднее за неделю не знает про выходные: в тихий день
 *     или на Навруз звонков нет, а будни недели дают «обычно их десяток» — и
 *     директору летела CRITICAL-тревога о поломке, которой нет. Поэтому ещё одна
 *     сверка: ровно неделю назад, в тот же день недели и те же часы. Было там не
 *     больше SAME_WEEKDAY_QUIET_MAX звонков — это тихий день агентства, молчим;
 *     звонили — тишина сейчас подозрительна, тревога как раньше. Выходного «по
 *     умолчанию» сторож не знает и знать не должен (владелец 11.10.2026: «у нас нет
 *     никаких выходных — робот и телефон всегда в сети»): тихий день он видит только
 *     по живой истории звонков, а не по зашитому воскресенью.
 *
 *  2. НУЛЕВАЯ ДЛИТЕЛЬНОСТЬ. Звонки в журнале есть, но все до одного оборвались
 *     быстрее DEAD_CALL_SECONDS. Это тот случай, когда события станции до CRM
 *     доходят, а разговор не состоится ни разу: плечо мёртвое, транк отвалился,
 *     очередь пустая. Отдельный симптом, потому что первый его не ловит —
 *     записи-то идут.
 *
 * МОЛЧИТ, ПОКА ТЕЛЕФОНИЯ НЕ НАСТРОЕНА: без адреса ARI у CRM нет и источника
 * событий, и «ни одного входящего» — не поломка, а отсутствие телефонии вовсе.
 *
 * Не чаще раза в сутки на симптом (shouldAlert) и только в часы алармов — тот же
 * договор, что у остальных сторожей в lib/*Alarm.ts. Тревога идёт и в журнал
 * ошибок: пуш директор может пропустить, а журнал читает разбор.
 */

/** Сколько часов тишины считаем подозрительными. Меньше — поймаем обеденный
 *  перерыв; больше — узнаем о поломке к вечеру, а не в середине дня. */
export const SILENCE_HOURS = 4;

/** По скольким прошлым дням считаем «сколько звонков тут обычно». Неделя
 *  накрывает и выходные, и будни, и не тянет за собой старую жизнь агентства. */
export const BASELINE_DAYS = 7;

/** Сколько звонков в том же окне прошлых дней должно быть, чтобы тишина сегодня
 *  что-то значила. Один случайный звонок неделю назад поводом не считаем. */
const BASELINE_MIN_CALLS = BASELINE_DAYS;

/** Столько звонков или меньше неделю назад в тот же день недели и те же часы —
 *  «почти не было»: выходной, праздник, тихий день. Тишина сегодня тогда не
 *  поломка. Один звонок за четыре часа — случайный, а не рабочий поток. */
export const SAME_WEEKDAY_QUIET_MAX = 1;

/** «Тот же день недели» — ровно неделю назад; входит в окно BASELINE_DAYS
 *  (поэтому BASELINE_DAYS не опускать ниже семи — иначе сверка всегда «тихо»). */
const SAME_WEEKDAY_DAYS_AGO = 7;

/** Короче этого разговор не состоялся ни при каких условиях: это обрыв, а не
 *  звонок. Живой случай давал ~0,05 с, но сетевой обрыв может дать и секунду. */
export const DEAD_CALL_SECONDS = 2;

/** Сколько подряд оборвавшихся звонков считаем не совпадением. */
const DEAD_CALLS_MIN = 5;

/** Окно, на котором ищем сплошные обрывы. */
const DEAD_WINDOW_HOURS = 24;

/** Предел выборки: любой запрос, возвращающий массив, обязан иметь потолок. */
const MAX_CALLS = 500;

const ALERT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface IncomingSilenceResult {
  /** Сколько тревог отправлено этим тиком (0, 1 или 2). */
  alerted: number;
  /** Какие симптомы сработали — для тестов и для журнала задач. */
  symptoms: ("silence" | "dead-calls")[];
}

/**
 * Один проход сторожа. Никогда не бросает: сбой сторожа не должен ронять крон.
 */
export async function runIncomingCallsSilenceTick(now: Date = new Date()): Promise<IncomingSilenceResult> {
  const empty: IncomingSilenceResult = { alerted: 0, symptoms: [] };
  if (!(await isWithinAlarmHours(now))) return empty;

  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { asteriskAriUrl: true },
  });
  if (!settings?.asteriskAriUrl?.trim()) return empty;

  const directorIds = (
    await prisma.agent.findMany({
      where: { role: { in: ["DIRECTOR", "ADMIN"] }, isActive: true },
      select: { id: true },
    })
  ).map((d) => d.id);
  if (directorIds.length === 0) return empty;

  const symptoms: IncomingSilenceResult["symptoms"] = [];
  let alerted = 0;

  const silence = await detectSilence(now);
  if (silence) {
    symptoms.push("silence");
    if (await raise(directorIds, "incoming-calls-silence", silence, now)) alerted++;
  }

  const dead = await detectDeadCalls(now);
  if (dead) {
    symptoms.push("dead-calls");
    if (await raise(directorIds, "incoming-calls-dead", dead, now)) alerted++;
  }

  return { alerted, symptoms };
}

/**
 * Тишина против собственной истории: ноль звонков за окно, которое в предыдущие
 * BASELINE_DAYS дней приносило заметный поток. Возвращает готовый текст тревоги
 * или null, если поводов нет.
 */
async function detectSilence(now: Date): Promise<string | null> {
  const from = new Date(now.getTime() - SILENCE_HOURS * HOUR_MS);
  // Верхняя граница обязательна, а не «всё, что новее»: окно сторожа — ОТРЕЗОК
  // [from, now]. Без неё в счёт попадало бы будущее, а в прогоне тестов — любые
  // записи, лежащие позже заданного времени; тревога тогда не сработает никогда.
  const recent = await prisma.incomingCall.count({ where: { startedAt: { gte: from, lt: now } } });
  if (recent > 0) return null;

  // То же окно суток в предыдущие дни — сравниваем «сегодня днём» с «обычно днём»,
  // а не с круглосуточным средним: ночью нулей хватает и без поломки.
  //
  // Сдвиг ровно на day×24 ч сохраняет и часы, и день недели ПО ДУШАНБЕ: у
  // Таджикистана нет перехода на летнее время (UTC+5 круглый год, см.
  // DUSHANBE_OFFSET_MS в lib/dushanbeTime.ts), поэтому 7×24 ч назад — это тот
  // же душанбинский день недели и те же часы, а не UTC-шный (в 00:00–05:00 по
  // Душанбе UTC ещё показывает вчерашний день).
  let baseline = 0;
  let sameWeekday = 0;
  for (let day = 1; day <= BASELINE_DAYS; day++) {
    const shift = day * 24 * HOUR_MS;
    const n = await prisma.incomingCall.count({
      where: { startedAt: { gte: new Date(from.getTime() - shift), lt: new Date(now.getTime() - shift) } },
    });
    baseline += n;
    if (day === SAME_WEEKDAY_DAYS_AGO) sameWeekday = n;
  }
  if (baseline < BASELINE_MIN_CALLS) return null;
  // Тот же день недели неделю назад был тихим (воскресенье, праздник) — сегодня
  // тишина ожидаема, будить директора не за что (E13).
  if (sameWeekday <= SAME_WEEKDAY_QUIET_MAX) return null;

  const perDay = (baseline / BASELINE_DAYS).toFixed(1);
  return (
    `Входящих звонков нет уже ${SILENCE_HOURS} ч. В это же время в предыдущие дни их было ` +
    `в среднем ${perDay} за такой же промежуток. Неделю назад в этот же день и часы — ${sameWeekday}. ` +
    `Похоже, звонки до CRM не доходят.`
  );
}

/**
 * Сплошные обрывы: записи идут, а разговора не случилось ни разу. Именно так
 * выглядел месяц с 21.08.2026 — если бы записи вообще заводились.
 */
async function detectDeadCalls(now: Date): Promise<string | null> {
  const from = new Date(now.getTime() - DEAD_WINDOW_HOURS * HOUR_MS);
  const calls = await prisma.incomingCall.findMany({
    where: { startedAt: { gte: from, lt: now }, endedAt: { not: null } },
    select: { startedAt: true, endedAt: true, answered: true },
    orderBy: { startedAt: "desc" },
    take: MAX_CALLS,
  });
  if (calls.length < DEAD_CALLS_MIN) return null;

  const alive = calls.filter(
    (c) => c.answered || (c.endedAt!.getTime() - c.startedAt.getTime()) / 1000 >= DEAD_CALL_SECONDS
  );
  if (alive.length > 0) return null;

  return (
    `Все ${calls.length} входящих за последние ${DEAD_WINDOW_HOURS} ч оборвались быстрее ` +
    `${DEAD_CALL_SECONDS} с и ни один не был отвечен. Снаружи это звучит как «занято»: ` +
    `скорее всего, аппарату приёма нечем звонить.`
  );
}

/** Отправка одной тревоги. Возвращает false, если её уже слали сегодня. */
async function raise(directorIds: string[], tag: string, body: string, now: Date): Promise<boolean> {
  if (!(await shouldAlert(tag, ALERT_MIN_INTERVAL_MS, now))) return false;
  const payload = {
    kind: "oversight" as const,
    title: "📵 Входящие звонки не доходят",
    body,
    url: "/oversight",
    tag,
    level: "CRITICAL" as const,
  };
  try {
    await createNotifications(directorIds, payload);
    publishNotificationNew(directorIds);
    // НЕ sendPushToAgents: он САМ пишет ту же строку в ленту ещё раз, своим
    // необожидаемым `void createNotifications(...)` (push.ts:259) — с тем же
    // tag, но без гарантии, КОГДА эта запись ляжет. Живой случай 21.09.2026:
    // в тесте вторая, ничем не привязанная запись всплывала уже в СЛЕДУЮЩЕМ
    // прогоне сторожа, после того как beforeEach следующего теста успевал
    // почистить ленту, — `alarmSent` снова видел "true" там, где тик его тика
    // ничего не поднимал. Разбор и системная починка (снять запись в ленте с
    // sendPushToAgents для ВСЕХ алармов) — отдельной правкой, docs/TASKS.md
    // («Счётчик повторов у алармов растёт вдвое быстрее события»); здесь —
    // только доставка на устройство (handledByQuietHours + deliverPushToAgents,
    // как раньше делал sendPushToAgents внутри), без повторной записи в ленту.
    if (!(await handledByQuietHours(directorIds, payload))) {
      void deliverPushToAgents(directorIds, payload).catch((err) =>
        console.error("[alarm] incoming-calls-silence push:", err)
      );
    }
  } catch (err) {
    console.error("[alarm] incoming-calls-silence notification:", err);
  }
  // В журнал — отдельно от пуша: пуш директор может пропустить или отключить,
  // а журнал ошибок читают при каждом разборе. Именно этой записи и не хватило.
  // Здесь запись ДОЖИДАЕМСЯ, в отличие от обычного `void logSystemError`: тик
  // редкий (раз в час) и короткий, а незаписанная тревога — ровно та тишина, от
  // которой этот сторож и заведён.
  await logSystemError("telephony", body).catch((err) =>
    console.error("[alarm] incoming-calls-silence journal:", err)
  );
  return true;
}
