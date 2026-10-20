import { DUSHANBE_OFFSET_MS, dushanbeWallClock } from "./dushanbeTime.js";

/**
 * Когда бот сам напоминает о себе клиенту, который перестал отвечать.
 *
 * Три попытки, и все они обязаны уложиться в СУТКИ с последнего сообщения клиента.
 * Это не пожелание, а правило Meta: писать человеку разрешено только 24 часа после
 * его сообщения. Позже Instagram не доставит письмо вовсе, а WhatsApp примет лишь
 * заранее утверждённый платный шаблон — поэтому «напомню завтра утром» из исходной
 * задумки владельца технически невыполнимо, и цепочка сжата в один день.
 *
 * Внутри суток попытки расставлены с запасом: через час (человек ещё помнит
 * разговор), ближе к вечеру и под конец окна. Разброс считается от идентификатора
 * диалога, а не случайно: расписание должно переживать перезапуск сервера и
 * повторяться в тестах.
 */

/** Часы отправки (по Душанбе) — инициативные сообщения только в это окно. */
export interface FollowUpWindow {
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

/** Базовые задержки от последнего сообщения клиента, часы. */
const BASE_OFFSETS_H = [1, 5, 18];
/** Насколько попытка может «поехать» вперёд, часы: 0 у первой (час — это час). */
const JITTER_H = [0, 2, 2];
/** Дальше письмо не уйдёт: сутки Meta с запасом на очередь и медленный ответ Graph API. */
const MAX_AGE_MS = 23 * 60 * 60 * 1000;

/**
 * Потолок цепочки, дальше которого расписание просто не рассчитано.
 * Сколько напоминаний слать НА САМОМ ДЕЛЕ — решает настройка
 * `followUpMaxAttempts` (по умолчанию одно): молчание на первое письмо это ответ,
 * и второе письмо в ту же тишину только раздражает.
 */
export const MAX_FOLLOW_UPS = BASE_OFFSETS_H.length;

/** Приводит настройку к допустимому диапазону: 0 — напоминаний нет вовсе. */
export function followUpLimit(configured: number | null | undefined): number {
  const n = Math.trunc(configured ?? 1);
  if (!Number.isFinite(n) || n < 0) return 1;
  return Math.min(n, MAX_FOLLOW_UPS);
}

/** Устойчивый разброс из идентификатора диалога: одинаковый при каждом запуске. */
function jitterFraction(conversationId: string): number {
  let hash = 0;
  for (const ch of conversationId) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000;
  return hash / 100_000;
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/** Минуты от полуночи по Душанбе для момента `at`. */
function dushanbeMinutes(at: Date): number {
  const wall = dushanbeWallClock(at);
  return wall.getUTCHours() * 60 + wall.getUTCMinutes();
}

/**
 * Переносит момент в разрешённое окно: раньше начала — на начало того же дня,
 * позже конца — на начало следующего. Внутри окна остаётся как есть.
 */
export function shiftIntoWindow(at: Date, window: FollowUpWindow): Date {
  const startMin = hhmmToMinutes(window.start);
  const endMin = hhmmToMinutes(window.end);
  const min = dushanbeMinutes(at);
  if (min >= startMin && min < endMin) return at;

  const wall = dushanbeWallClock(at);
  const dayStartUtc = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()) - DUSHANBE_OFFSET_MS;
  const sameDayStart = new Date(dayStartUtc + startMin * 60_000);
  if (min < startMin) return sameDayStart;
  return new Date(sameDayStart.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * Когда отправлять попытку номер `attempt` (1..3). null — уже поздно: момент
 * вышел за сутки Meta, и вместо бесполезной отправки цепочка на этом кончается.
 */
export function followUpDueAt(
  conversationId: string,
  lastClientMessageAt: Date,
  attempt: number,
  window: FollowUpWindow
): Date | null {
  const idx = attempt - 1;
  if (idx < 0 || idx >= BASE_OFFSETS_H.length) return null;

  const offsetH = BASE_OFFSETS_H[idx] + JITTER_H[idx] * jitterFraction(conversationId);
  const raw = new Date(lastClientMessageAt.getTime() + offsetH * 60 * 60 * 1000);
  const due = shiftIntoWindow(raw, window);
  if (due.getTime() - lastClientMessageAt.getTime() > MAX_AGE_MS) return null;
  return due;
}

/** Момент `at` внутри окна отправки (по Душанбе, конец не включается). */
function isInsideWindow(at: Date, window: FollowUpWindow): boolean {
  const min = dushanbeMinutes(at);
  return min >= hhmmToMinutes(window.start) && min < hhmmToMinutes(window.end);
}

/** Пора ли отправлять следующую попытку прямо сейчас. */
export function isFollowUpDue(
  conversationId: string,
  lastClientMessageAt: Date,
  alreadySent: number,
  window: FollowUpWindow,
  now: Date = new Date(),
  limit: number = MAX_FOLLOW_UPS
): boolean {
  if (alreadySent >= followUpLimit(limit)) return false;
  // Окно проверяется и на момент ИСПОЛНЕНИЯ, а не только при расчёте due: тик,
  // восстановившийся после простоя канала/ИИ, не должен писать ночью. Диалог
  // остаётся в очереди до утра, если ещё укладывается в сутки Meta (CHANNEL-NEW-01).
  if (!isInsideWindow(now, window)) return false;
  const due = followUpDueAt(conversationId, lastClientMessageAt, alreadySent + 1, window);
  return due !== null && now.getTime() >= due.getTime();
}

/**
 * Клиент прямо попросил не писать ему. Дальше инициативных сообщений быть не
 * должно вовсе — ни напоминаний, ни «а вы ещё ищете?». На прямой вопрос бот
 * по-прежнему отвечает: молчать в ответ на обращение невежливо.
 */
// ВАЖНО: без \b перед кириллицей. В JavaScript граница слова определена через
// [A-Za-z0-9_], русские буквы в это множество не входят — /\bне пиши/ не находит
// «не пишите» вообще. Стоп-слова молча не работали бы, а человек продолжал бы
// получать напоминания после прямой просьбы прекратить.
//
// И ОБРАТНАЯ ОШИБКА, НЕ МЕНЕЕ ДОРОГАЯ. Слишком широкое правило принимает за отказ
// просьбу ОТВЕТИТЬ. «Почему мне никто не пишет?» и «отпишите, пожалуйста, цену» —
// это жалоба и вопрос, а не «отстаньте»; в русском «отпишите» чаще значит «напишите
// в ответ». Приняв их за отказ, бот замолкает навсегда, а в разборе потерянных
// диалогов человек числится как «просил не писать» — ровно наоборот к сказанному.
// Поэтому «не пиш…» ловится только с обращением к нам («не пишите мне»), а «отпишите»
// не ловится вовсе: отказ от рассылки по-русски звучит как «отписаться».
const OPT_OUT_PATTERNS = [
  /не\s*пиш(и|ите)\s*(мне|нам|сюда|больше)/i,
  /не\s*надо\s*(мне\s*)?пис/i,
  /не\s*писать/i,
  // «не беспокойте (меня)», «не беспокоить» — просьба; «не беспокойтесь, я подойду» и «не
  // беспокоит» — вежливая фраза и ответ на вопрос, а не отказ (третий аудит 02.10.2026, С1):
  // отметка `optedOutAt` нигде не снимается, и вежливое слово навсегда выводило человека
  // из опроса и проверки собственника. После «беспокой(те)» не должно идти продолжение слова.
  /не\s*беспоко(й(те)?|ить)(?![\p{L}\p{N}])/iu,
  /отстань/i,
  /отписаться/i,
  /удалите\s+мой\s+номер/i,

  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /нанавис/i, // «нанависед» — «не пишите» по-таджикски
];

/**
 * КОРОТКИЕ ОТКАЗЫ — ТОЛЬКО КОГДА ОНИ И ЕСТЬ ВСЁ СООБЩЕНИЕ (ревизия 02.10.2026).
 * «Лозим нест» и «больше не надо» внутри обычной фразы — это про предмет, а не про
 * нас: «Ипотека лозим нест, нақд мехарам», «больше не надо двушку, ищу трёшку».
 * Принятые за отказ, они навсегда глушили бота у живого покупателя.
 */
const SHORT_OPT_OUT_PATTERNS = [
  /(^|\s)лозим\s+нест(\s|$|[.!?,])/i, // «не нужно»
  /(^|\s)бас(\s|$|[.!?,])/i, // «хватит» — только отдельным словом, иначе поймает «баста»
  /больше\s+не\s+над/i,
];
const SHORT_MESSAGE_MAX = 25;

export function isOptOutMessage(text: string): boolean {
  if (OPT_OUT_PATTERNS.some((p) => p.test(text))) return true;
  return text.trim().length <= SHORT_MESSAGE_MAX && SHORT_OPT_OUT_PATTERNS.some((p) => p.test(text));
}

/**
 * Клиент поблагодарил и закрыл разговор («Да все хорошо, спасибо») — бот
 * вежливо ответил последним, из-за чего формально выглядел «ждущим ответа»
 * и через 18 часов слал напоминание в уже закрытый разговор (18.08.2026,
 * жалоба владельца на скриншоте: агентство «доставало» клиента после его
 * же «всё хорошо, спасибо»). Узкий список благодарностей, а не общее
 * «хорошо»/«ок» — то само по себе значит «продолжайте», не «стоп».
 * Вопрос в том же сообщении («спасибо, а сколько стоит?») отменяет
 * закрытие: человек благодарит И ждёт ответа.
 */
const CLOSING_PATTERNS = [
  /спасибо/i,
  /благодар/i,
  /ташаккур/i, // «спасибо» по-таджикски
  /рахмат/i, // «спасибо» на фарси/тюркских
  // \b-границы работают: слово латиницей. Прежняя пара /thanks?\s*you?/ + /thank\s*you/
  // НЕ ловила голое «thanks»/«thank» (после «thanks» движок требовал «y») — клиент,
  // закрывший разговор одним «thanks», получал напоминание через 18 часов (26.08.2026).
  /\bthanks?\b/i,
];

export function isClosingMessage(text: string): boolean {
  if (/\?/.test(text)) return false;
  return CLOSING_PATTERNS.some((p) => p.test(text));
}
