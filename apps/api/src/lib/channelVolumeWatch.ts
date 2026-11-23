import { prisma } from "../db.js";
import { automationSwitchOn } from "./automationSwitches.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { CLIENT_WAITING_LEADERSHIP } from "./clientWaitingAlert.js";
import { dushanbeDateString, dushanbeWallClock } from "./dushanbeTime.js";

/**
 * КАНАЛ ЗАТИХ — ТРЕВОГА РУКОВОДСТВУ (24.11.2026).
 *
 * ЗАЧЕМ. Поток обращений в Instagram 22.11 упал с 10–18 новых диалогов в день до 2,
 * Facebook с 5–8 до 0, а Instagram «Royal Home Info» молчал с 10.11. Бот при этом
 * исправен, ответов не ждёт никто: сообщения просто не доходят до CRM (отвалился
 * вебхук, слетела подписка, закрыли доступ). Сторожа «клиент ждёт ответа»
 * (lib/clientWaitingAlert.ts) этого не видят в принципе: им нужна реплика клиента,
 * а её нет. Здесь сравниваем число НОВЫХ диалогов канала за последние 8 часов с
 * тем же окном суток за предыдущие 7 дней.
 *
 * КОГДА ТРЕВОГА. Среднее за 7 дней в этом окне ≥ 3, а сейчас 0; или среднее ≥ 8, а
 * сейчас меньше четверти. Только днём по Душанбе (10:00–22:00): ночью поток
 * пустой всегда. Одна тревога на канал в сутки.
 *
 * РУБИЛЬНИК: тот же `notifyClientWaitingEnabled` (Настройки → автоматика), что у
 * сторожей «клиент ждёт ответа»: это та же семья уведомлений. Сторож только читает
 * базу и пишет руководству, клиентам ничего не шлёт.
 */

export const WATCHED_CHANNELS = ["WHATSAPP", "INSTAGRAM", "FACEBOOK"] as const;
export const WATCH_WINDOW_HOURS = 8;
export const WATCH_BASELINE_DAYS = 7;
const DAY_FROM_HOUR = 10;
const DAY_TO_HOUR = 22;

/** Чистое решение: тревожить ли по каналу. `baselineTotal` — сумма за 7 прошлых суток. */
export function channelVolumeVerdict(current: number, baselineTotal: number): { alert: boolean; average: number } {
  const average = baselineTotal / WATCH_BASELINE_DAYS;
  const alert = (average >= 3 && current === 0) || (average >= 8 && current < average * 0.25);
  return { alert, average };
}

/** Днём по Душанбе: ночью поток пуст всегда, и тревога была бы ложной. */
export function isChannelWatchHour(at: Date = new Date()): boolean {
  const hour = dushanbeWallClock(at).getUTCHours();
  return hour >= DAY_FROM_HOUR && hour < DAY_TO_HOUR;
}

const alertedToday = new Set<string>();

type VolumeRow = { channel: string; cur: bigint | number; past: bigint | number };

export async function runChannelVolumeWatchTick(at: Date = new Date()): Promise<{ alerted: string[] }> {
  if (!isChannelWatchHour(at)) return { alerted: [] };
  if (!(await automationSwitchOn("notifyClientWaitingEnabled"))) return { alerted: [] };
  const windowSec = WATCH_WINDOW_HOURS * 3600;
  const spanSec = WATCH_BASELINE_DAYS * 86400 + windowSec;
  // elapsed — сколько секунд назад создан диалог. Сейчас: elapsed < окна. Прошлые
  // сутки: elapsed от 24 ч до 7 суток + окно, и остаток от деления на сутки < окна.
  const rows = await prisma.$queryRaw<VolumeRow[]>`
    SELECT "channel"::text AS channel,
      COUNT(*) FILTER (WHERE e < ${windowSec}) AS cur,
      COUNT(*) FILTER (WHERE e >= 86400 AND e < ${spanSec} AND (e % 86400) < ${windowSec}) AS past
    FROM (
      SELECT "channel", EXTRACT(EPOCH FROM (${at}::timestamp - "createdAt"))::bigint AS e
      FROM "BotConversation"
      WHERE "createdAt" > ${at}::timestamp - make_interval(secs => ${spanSec})
        AND "channel"::text = ANY(${[...WATCHED_CHANNELS]})
    ) t
    GROUP BY 1`;
  const day = dushanbeDateString(at);
  const alerted: string[] = [];
  for (const channel of WATCHED_CHANNELS) {
    const row = rows.find((r) => r.channel === channel);
    const current = Number(row?.cur ?? 0);
    const { alert, average } = channelVolumeVerdict(current, Number(row?.past ?? 0));
    const key = `${channel}:${day}`;
    if (!alert || alertedToday.has(key)) continue;
    const queued = await enqueueDirectorAlert({
      title: `📉 ${channelName(channel)}: новых обращений почти нет`,
      body:
        `За последние ${WATCH_WINDOW_HOURS} ч пришло ${current} новых диалогов, а обычно в это время около ${average.toFixed(1)}. ` +
        `Бот исправен, но сообщения могли перестать доходить до CRM: проверьте подключение канала и вебхуки Meta.`,
      url: "/settings",
      kind: "system",
      level: "CRITICAL",
      severity: "info",
      tag: `channel-volume-${channel}-${day}`,
      recipientRoles: [...CLIENT_WAITING_LEADERSHIP],
    });
    if (queued) {
      alertedToday.add(key);
      alerted.push(channel);
    }
  }
  return { alerted };
}

function channelName(channel: string): string {
  return channel === "WHATSAPP" ? "WhatsApp" : channel === "INSTAGRAM" ? "Instagram" : "Facebook";
}
