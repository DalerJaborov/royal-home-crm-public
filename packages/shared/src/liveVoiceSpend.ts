import { dushanbeDayKey } from "./dushanbeDay.js";

/**
 * ПОТОЛОК РАСХОДА РОБОТА: ЧИСТАЯ ЧАСТЬ (П5, 11.11.2026).
 *
 * Владелец 11.11: «сделай так чтобы никаких ошибочных звонков … что бы не было что звонков
 * вдруг не отключиться и у нас деньги пойдут в минус». У аккаунта ElevenLabs включено
 * автопополнение без верхней границы, поэтому предел ставит CRM: минуты робота за сутки и
 * за месяц по Душанбе. Дверь, которая считает минуты по базе и ставит робота на паузу, —
 * `apps/api/src/lib/liveVoiceSpend.ts`; здесь то, что одинаково нужно серверу и экрану.
 *
 * Расчёт умолчаний (ОЦЕНКА, решение владельца по умолчанию — подтвердить):
 *  - ФАКТ (кабинет ElevenLabs, звонок 11.11 ~19:16): 2 мин 4 с разговора = 1816 кредитов,
 *    то есть ≈ 880 кредитов за минуту;
 *  - ФАКТ (кабинет ElevenLabs 11.11): лимит периода 241 000 кредитов;
 *  - в месяц 250 минут ≈ 220 000 кредитов — в пределах лимита периода с запасом на
 *    озвучку объектов и голосовые ответы, которые тратят тот же счёт;
 *  - в сутки 60 минут ≈ 52 800 кредитов (≈ 30 разговоров по 2 минуты) — решение владельца
 *    11.11.2026: «Потолок в сутки можно сделать, в принципе, 60 минут». Робот в цикле за день
 *    съест не больше ~22% лимита; месячный потолок 250 остаётся защитой тарифа (при 60 мин
 *    каждый день лимит кончился бы за ~4–5 дней).
 * Месяц — календарный по Душанбе, а не период подписки ElevenLabs (у того своя дата сброса,
 * next_character_count_reset_unix) — ОЦЕНКА, расхождение до одного периода.
 */

/** Потолок одного разговора в мосте (LIVE_VOICE_MAX_SESSION_MS, liveVoiceBridge.ts).
 *  Незакрытая сессия считается до сейчас, но не дольше этого: дольше её держать мост не умеет.
 *  Совпадение чисел сверяет тест (live-voice-spend-ceiling.test.ts). */
export const LIVE_VOICE_SESSION_BILLING_CAP_MS = 15 * 60_000;

export const LIVE_VOICE_DAILY_MINUTES_CAP_DEFAULT = 60;
export const LIVE_VOICE_MONTHLY_MINUTES_CAP_DEFAULT = 250;
/** Верх поля в Настройках: опечатка в лишний ноль не должна снять защиту совсем. */
export const LIVE_VOICE_MINUTES_CAP_MAX = 50_000;
/** ОЦЕНКА по звонку 11.11 (см. шапку): только для подписи «≈ кредитов» на экране и в тревоге. */
export const ELEVENLABS_CREDITS_PER_MINUTE_ESTIMATE = 880;
/** Пороги тревоги директору: предупреждение и остановка. */
export const LIVE_VOICE_SPEND_ALERT_PERCENTS = [80, 100] as const;
export type LiveVoiceSpendAlertPercent = (typeof LIVE_VOICE_SPEND_ALERT_PERCENTS)[number];

/**
 * Потолок из Настроек: целое ≥ 0; 0 — «без потолка» (явный выбор владельца). Всё прочее
 * (null, дробь, отрицательное) — значение по умолчанию: опечатка не снимает защиту.
 */
export function liveVoiceMinutesCapOrDefault(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= LIVE_VOICE_MINUTES_CAP_MAX ? value : fallback;
}

/** Сколько миллисекунд разговора засчитать сессии: до конца, а идущей — до `now`, не больше потолка. */
export function liveVoiceSessionBilledMs(session: { startedAt: Date; endedAt: Date | null }, now: Date): number {
  const end = (session.endedAt ?? now).getTime();
  const ms = end - session.startedAt.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(ms, LIVE_VOICE_SESSION_BILLING_CAP_MS);
}

export type LiveVoiceSpendPeriodName = "day" | "month";

export interface LiveVoiceSpendPeriod {
  /** Ключ периода по Душанбе: «ГГГГ-ММ-ДД» или «ГГГГ-ММ». */
  key: string;
  usedMinutes: number;
  /** 0 — без потолка. */
  capMinutes: number;
  /** Процент от потолка, целое вниз; null — потолка нет. */
  percent: number | null;
  reached: boolean;
}

export interface LiveVoiceSpendState {
  day: LiveVoiceSpendPeriod;
  month: LiveVoiceSpendPeriod;
  /** Какой потолок держит робота сейчас (месяц важнее суток); null — звонить можно. */
  held: LiveVoiceSpendPeriodName | null;
}

/** Минуты с точностью до десятой: «12.4 из 30» честнее, чем округление вверх или вниз. */
const toMinutes = (ms: number) => Math.round(ms / 6_000) / 10;

function period(key: string, usedMs: number, capMinutes: number): LiveVoiceSpendPeriod {
  const usedMinutes = toMinutes(usedMs);
  if (capMinutes <= 0) return { key, usedMinutes, capMinutes: 0, percent: null, reached: false };
  return { key, usedMinutes, capMinutes, percent: Math.floor((usedMs / (capMinutes * 60_000)) * 100), reached: usedMs >= capMinutes * 60_000 };
}

/** Чистое решение по потолку: сколько наговорено и держит ли потолок робота. */
export function evaluateLiveVoiceSpend(input: { now: Date; dayMs: number; monthMs: number; dailyCap: number; monthlyCap: number }): LiveVoiceSpendState {
  const dayKey = dushanbeDayKey(input.now);
  const day = period(dayKey, input.dayMs, input.dailyCap);
  const month = period(dayKey.slice(0, 7), input.monthMs, input.monthlyCap);
  return { day, month, held: month.reached ? "month" : day.reached ? "day" : null };
}

/** Какие пороги тревоги уже пройдены в периоде (для одной тревоги на порог за период). */
export function liveVoiceSpendThresholdsReached(p: LiveVoiceSpendPeriod): LiveVoiceSpendAlertPercent[] {
  if (p.percent === null) return [];
  return LIVE_VOICE_SPEND_ALERT_PERCENTS.filter((t) => (t === 100 ? p.reached : p.percent! >= t));
}
