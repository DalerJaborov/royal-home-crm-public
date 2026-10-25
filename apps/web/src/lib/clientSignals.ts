import { pluralizeRu } from "@royal-home/shared";
import { daysSince } from "./format";
import type { Client, Interaction } from "../types";

/**
 * СИГНАЛЫ КАРТОЧКИ — «что горит» по этому клиенту.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Ровно те же цифры показывает полоса фактов на десктопе
 * (ClientFacts) и полоса сигналов на телефоне (ClientSignals). Если каждая
 * посчитает молчание сама, они разойдутся — не сразу, а когда кто-нибудь поправит
 * порог в одном месте. Правило, записанное в одном экране, не является правилом:
 * тот же урок уже записан в lib/clientPhone.ts и lib/leadLimits.ts.
 */

/**
 * Пороги молчания. Выбраны по живой базе (проверка 20.08.2026): у клиентов в
 * работе тишина обычно 0–2 дня, поэтому три дня — это уже «пора вспомнить», а
 * неделя — «скорее всего теряем». Не выдумка про «правильные» сроки продаж, а
 * граница, на которой поведение реально меняется.
 */
const SILENCE_WARN_DAYS = 3;
const SILENCE_ALERT_DAYS = 7;

export type SignalTone = "normal" | "amber" | "red";

/** Сколько полных суток клиент молчит. */
export function silenceDays(lastContactAt: string): number {
  return daysSince(lastContactAt);
}

/**
 * Подпись молчания. Отдельно от даты последнего контакта: дата отвечает «когда»,
 * а решает — «сколько прошло», и вычитать одно из другого в уме человек не должен
 * (владелец 20.08.2026 про относительное время: «считаешь, пока 4 часа назад,
 * слишком долго» — здесь обратный случай, длительность и есть смысл).
 */
export function silenceLabel(lastContactAt: string): string {
  const days = silenceDays(lastContactAt);
  if (days === 0) return "сегодня на связи";
  return `молчит ${days} ${pluralizeRu(days, ["день", "дня", "дней"])}`;
}

export function silenceTone(lastContactAt: string): SignalTone {
  const days = silenceDays(lastContactAt);
  if (days >= SILENCE_ALERT_DAYS) return "red";
  if (days >= SILENCE_WARN_DAYS) return "amber";
  return "normal";
}

/**
 * Проведённые показы — те же правила, что на сервере (lib/conductedShowing.ts) и
 * на карточке (ClientDetail.tsx, hadShowing): не отменён и либо отмечен
 * выполненным, либо записан задним числом, либо его время уже прошло. Назначенный
 * на следующий месяц показ проведённым не считается.
 */
export function conductedShowings(interactions: Interaction[]): number {
  return interactions.filter(
    (i) =>
      i.type === "SHOWING" &&
      !i.taskCancelledAt &&
      !i.declinedAt &&
      (!!i.completedAt || !i.nextActionDate || new Date(i.nextActionDate).getTime() <= Date.now())
  ).length;
}

/** Ближайший обещанный шаг — то, что агент сам записал после разговора. */
export function nextStepOf(client: Client): { action: string; at: string | null } | null {
  const step = client.nextStep;
  if (!step?.nextAction) return null;
  return { action: step.nextAction, at: step.nextActionDate ?? null };
}
