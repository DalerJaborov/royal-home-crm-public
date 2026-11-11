import {
  ELEVENLABS_CREDITS_PER_MINUTE_ESTIMATE,
  LIVE_VOICE_DAILY_MINUTES_CAP_DEFAULT,
  LIVE_VOICE_MONTHLY_MINUTES_CAP_DEFAULT,
  evaluateLiveVoiceSpend,
  liveVoiceMinutesCapOrDefault,
  liveVoiceSessionBilledMs,
  liveVoiceSpendThresholdsReached,
  type LiveVoiceSpendAlertPercent,
  type LiveVoiceSpendPeriod,
  type LiveVoiceSpendPeriodName,
  type LiveVoiceSpendState,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { dushanbeDayRange, dushanbeStartOfMonth, dushanbeWallClock } from "./dushanbeTime.js";
import { setLiveVoiceSpendHold } from "./liveVoiceSpendHold.js";
import { shouldAlert } from "./notifications.js";
import { logSystemError } from "./systemError.js";

/**
 * ПОТОЛОК МИНУТ РОБОТА — ОДНА ДВЕРЬ (П5, 11.11.2026).
 *
 * Владелец 11.11 дословно: «сделай так чтобы никаких ошибочных звонков ещё что бы не было
 * что звонков вдруг не отключиться и у нас деньги пойдут в минус». У одного звонка потолок
 * уже был (15 минут, LIVE_VOICE_MAX_SESSION_MS в мосте); не было предела на сутки и месяц,
 * а у аккаунта ElevenLabs автопополнение без верхней границы.
 *
 * Учёт — по строкам LiveVoiceSession поставщика elevenlabs (схема не менялась): длительность
 * от startedAt до endedAt, у незакрытой — до сейчас, но не больше потолка одного звонка.
 * Сутки и месяц — по Душанбе (lib/dushanbeTime.ts). Сессия, начатая до полуночи, целиком
 * засчитывается суткам начала (разговор не длиннее 15 минут — ошибка не больше одного звонка).
 *
 * Что делает потолок:
 *  - исходящие: дверь «можно ли звонить роботом» (lib/robotCallPolicy.ts) отвечает «перенести»
 *    с причиной minutes_cap_day / minutes_cap_month — сценарий не тратит попытку;
 *  - входящие: удержание в памяти (liveVoiceSpendHold.ts) читает та же проверка «у ElevenLabs
 *    нет минут», что и мост (elevenLabsQuotaExhausted) — звонок сразу уходит станции на
 *    автоответчик, как при кончившихся кредитах;
 *  - идущий разговор не рвётся: потолок проверяется только перед новым звонком;
 *  - проверочный звонок владельца из Настроек потолок не держит (это проба, одна и вручную);
 *  - тревога директору на 80% и 100% — одна на порог за период (тег с ключом периода).
 * Выбран голос Google — потолок ElevenLabs робота не держит (минуты считаются для экрана).
 */

const SPEND_PROVIDER = "elevenlabs";
/** Предел выборки за месяц: одна линия робота — сотни сессий; упёрлись — пишем в журнал. */
const MONTH_ROWS_LIMIT = 50_000;
/** Тег тревоги уникален на период, поэтому окно shouldAlert — просто «больше месяца». */
const ALERT_DEDUP_WINDOW_MS = 40 * 24 * 3600_000;

export interface LiveVoiceSpendReading extends LiveVoiceSpendState {
  /** Выбранный голос робота; потолок держит только ElevenLabs. */
  provider: string;
  /** Когда снова можно звонить, если потолок держит. */
  retryAt: Date | null;
}

/** Конец периода по Душанбе — когда потолок отпустит сам. */
export function liveVoiceSpendPeriodEnd(period: LiveVoiceSpendPeriodName, now: Date): Date {
  if (period === "day") return dushanbeDayRange(now).end;
  // Месяц — по часам Душанбе (начало месяца в UTC лежит ещё в прошлом месяце: 1-е 00:00
  // по Душанбе = последнее число 19:00 UTC). 15-е следующего месяца и его начало по Душанбе.
  const wall = dushanbeWallClock(now);
  return dushanbeStartOfMonth(new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 15)));
}

/** Прочитать расход и решение по потолку. Ничего не меняет (для экрана Настроек). */
export async function readLiveVoiceSpend(now: Date = new Date()): Promise<LiveVoiceSpendReading> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { liveVoiceProvider: true, liveVoiceDailyMinutesCap: true, liveVoiceMonthlyMinutesCap: true },
  });
  const monthStart = dushanbeStartOfMonth(now);
  const dayStart = dushanbeDayRange(now).start;
  const rows = await prisma.liveVoiceSession.findMany({
    where: { provider: SPEND_PROVIDER, startedAt: { gte: monthStart, lte: now } },
    select: { startedAt: true, endedAt: true },
    take: MONTH_ROWS_LIMIT,
  });
  if (rows.length >= MONTH_ROWS_LIMIT) {
    void logSystemError("telephony", `Потолок минут робота: за месяц больше ${MONTH_ROWS_LIMIT} разговоров — счёт неполный, проверьте журнал звонков.`, {
      dedupKey: "live-voice-spend-rows-limit",
    });
  }
  let monthMs = 0;
  let dayMs = 0;
  for (const row of rows) {
    const ms = liveVoiceSessionBilledMs(row, now);
    monthMs += ms;
    if (row.startedAt.getTime() >= dayStart.getTime()) dayMs += ms;
  }
  const provider = settings?.liveVoiceProvider ?? "google";
  const state = evaluateLiveVoiceSpend({
    now,
    dayMs,
    monthMs,
    dailyCap: liveVoiceMinutesCapOrDefault(settings?.liveVoiceDailyMinutesCap, LIVE_VOICE_DAILY_MINUTES_CAP_DEFAULT),
    monthlyCap: liveVoiceMinutesCapOrDefault(settings?.liveVoiceMonthlyMinutesCap, LIVE_VOICE_MONTHLY_MINUTES_CAP_DEFAULT),
  });
  const held = provider === SPEND_PROVIDER ? state.held : null;
  return { ...state, held, provider, retryAt: held ? liveVoiceSpendPeriodEnd(held, now) : null };
}

const PERIOD_WORDS: Record<LiveVoiceSpendPeriodName, { of: string; until: string }> = {
  day: { of: "за сегодня", until: "до завтра" },
  month: { of: "за этот месяц", until: "до следующего месяца" },
};

function credits(minutes: number): string {
  return Math.round(minutes * ELEVENLABS_CREDITS_PER_MINUTE_ESTIMATE).toLocaleString("ru-RU");
}

/** Текст тревоги директору: что случилось, что делает робот, где поднять потолок. */
export function liveVoiceSpendAlertText(name: LiveVoiceSpendPeriodName, p: LiveVoiceSpendPeriod, threshold: LiveVoiceSpendAlertPercent): { title: string; body: string } {
  const w = PERIOD_WORDS[name];
  const used = `${p.usedMinutes} из ${p.capMinutes} мин`;
  if (threshold === 100) {
    return {
      title: `Робот остановлен ${w.until}: потолок минут`,
      body:
        `Робот наговорил ${w.of} ${used} (≈ ${credits(p.usedMinutes)} кредитов ElevenLabs). Новые звонки робота на паузе ${w.until}: ` +
        "исходящие переносятся, входящие уходят на автоответчик станции, идущий разговор не прерывается. " +
        "Поднять потолок — Настройки → Бот → «Живой голос по телефону».",
    };
  }
  return {
    title: `Робот израсходовал ${threshold}% минут ${w.of.replace("за ", "на ")}`,
    body:
      `Робот наговорил ${w.of} ${used} (${p.percent}%, ≈ ${credits(p.usedMinutes)} кредитов ElevenLabs). ` +
      `На 100% новые звонки робота встанут на паузу ${w.until}. Потолок — Настройки → Бот → «Живой голос по телефону».`,
  };
}

/** Тревоги, уже поставленные этим процессом (тег уникален на период): без второго похода в базу. */
const alerted = new Set<string>();

async function alertOnce(tag: string, text: { title: string; body: string }, threshold: LiveVoiceSpendAlertPercent): Promise<void> {
  if (alerted.has(tag)) return;
  alerted.add(tag);
  try {
    // Между процессами и после перезапуска повтор гасит сама очередь: тег уже есть в
    // PendingDirectorAlert/Notification — второй раз не ставим.
    if (!(await shouldAlert(tag, ALERT_DEDUP_WINDOW_MS))) return;
    const queued = await enqueueDirectorAlert({
      title: text.title,
      body: text.body,
      url: "/settings?tab=bot",
      kind: "oversight",
      // «Теряем клиента или деньги»: и 80% (успеть поднять потолок), и 100% (робот встал).
      level: "CRITICAL",
      tag,
      recipientRoles: ["DIRECTOR", "ADMIN"],
    });
    // Не встала в очередь (сбой базы) — метку снимаем: следующий тик поставит снова (ревью 12.11).
    if (!queued) {
      alerted.delete(tag);
      return;
    }
    // В журнал — для утреннего отчёта и «Здоровья системы», без второго пуша.
    void logSystemError("telephony", `${text.title}. ${text.body}`, { dedupKey: tag, silent: true });
  } catch (err) {
    alerted.delete(tag);
    throw err;
  }
}

/** Тег тревоги: вид периода, порог и ключ периода — одна тревога на порог за сутки/месяц. */
export function liveVoiceSpendAlertTag(name: LiveVoiceSpendPeriodName, p: LiveVoiceSpendPeriod, threshold: LiveVoiceSpendAlertPercent): string {
  return `live-voice-spend:${name}:${threshold}:${p.key}`;
}

/**
 * Перечитать расход, обновить удержание робота и поставить тревоги. Зовут тик
 * `live-voice-spend-ceiling` (раз в минуту, процесс api), дверь перед каждым набором и
 * сохранение Настроек. Бросает, если база не ответила: удержание тогда остаётся прежним
 * (вызывающий решает — дверь отказывает «попробуйте позже», тик пишет сбой).
 */
export async function refreshLiveVoiceSpend(now: Date = new Date()): Promise<LiveVoiceSpendReading> {
  const reading = await readLiveVoiceSpend(now);
  setLiveVoiceSpendHold(reading.held && reading.retryAt ? { period: reading.held, until: reading.retryAt.getTime() } : null);
  if (reading.provider === SPEND_PROVIDER) {
    for (const name of ["day", "month"] as const) {
      const p = reading[name];
      // Только старший пройденный порог: перескочили 80% разом до 100% — одна тревога
      // «остановлен», а не две подряд (правило владельца «редко беспокоить»).
      const threshold = liveVoiceSpendThresholdsReached(p).at(-1);
      if (!threshold) continue;
      await alertOnce(liveVoiceSpendAlertTag(name, p, threshold), liveVoiceSpendAlertText(name, p, threshold), threshold).catch((err) =>
        console.error("[live-voice-spend] тревога не поставлена:", err instanceof Error ? err.message : err)
      );
    }
  }
  return reading;
}

/** Только для тестов: забыть, какие тревоги процесс уже ставил. */
export function resetLiveVoiceSpendAlertsForTests(): void {
  alerted.clear();
  setLiveVoiceSpendHold(null);
}
