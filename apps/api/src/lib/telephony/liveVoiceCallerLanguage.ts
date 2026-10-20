/**
 * НА КАКОМ ЯЗЫКЕ ГОВОРИТ ЗВОНЯЩИЙ — ПО ЕГО РЕПЛИКАМ, С ГИСТЕРЕЗИСОМ (10.10.2026, разбор
 * звонков робота-консультанта; владелец: «таджикский — в приоритете»).
 *
 * Что было. Расшифровка речи звонящего (inputAudioTranscription Gemini Live) в четырёх
 * звонках из пяти приходила не кириллицей: урду и арабица, латиница, испанский, турецкий.
 * Распознавание плохо берёт таджикскую речь по телефону. Робот прыгал между языками
 * (начал по-таджикски, потом по-русски, «плохо слышно»), а промт велел «не знаешь — по-русски».
 *
 * Как теперь (чистая логика без сети и базы — побочные действия делает мост,
 * liveVoiceBridge.ts::handleCallerLanguage):
 *  1. Язык звонка по умолчанию — тот, что выбран до звонка (консультанту незнакомец —
 *     таджикский, liveVoiceConsultant.ts::consultantLanguage).
 *  2. Реплика звонящего НЕ кириллицей — НЕ сигнал языка ни в какую сторону: она «неясная»,
 *     язык по ней не определяется, не меняется, и счёт не сбрасывается. Расшифровка Live
 *     ненадёжна в обе стороны (тестовый звонок владельца 10.10 15:59: он говорил только
 *     по-русски, а она записала «am 20 Uhr», «Não, é para o próximo mês»; в таджикском звонке
 *     того же дня — латиница с ş ğ ı и арабская вязь). Пробовали считать арабицу и ş ğ ı
 *     «вероятно таджикским» — на русской речи владельца это дало бы таджикский. При
 *     неясности язык решает сама модель: она слышит звук (правило в промте).
 *  3. Язык меняется только после ДВУХ уверенных кириллических реплик подряд на другом
 *     языке (неясные между ними не считаются ни за, ни против). Уверенность — тот же
 *     определитель, что у чат-бота (ai/clientLanguage.ts::detectClientLanguage), плюс
 *     не меньше двух слов: одно «квартира» по-таджикски звучит так же, как по-русски.
 *  4. Если за CALLER_LANGUAGE_ASK_AFTER_UNCLEAR реплик язык так и не определился ни разу —
 *     один раз за звонок спросить на обоих языках (таджикский первым) и дальше следовать
 *     ответу. Модель слышит звук сама и могла понять язык и без расшифровки: служебная
 *     реплика разрешает ей не спрашивать, если язык ей ясен.
 *
 * С замком «только русский» трекер не создаётся вовсе (createCallerLanguageTracker): там
 * свой путь — извинение и передача человеку (liveVoiceBridge.ts::handleTajikOnRussianLock).
 */

import { detectClientLanguage } from "../../ai/clientLanguage.js";
import { foreignLetterShare } from "./liveVoiceGuards.js";

export type CallLanguage = "ru" | "tg";
export type CallerUtteranceLanguage = CallLanguage | "unclear";

/** Сколько уверенных реплик подряд на другом языке переключают язык звонка. */
export const CALLER_LANGUAGE_SWITCH_AFTER = 2;
/** Сколько неясных реплик (при ни одной уверенной) — повод один раз спросить язык. */
export const CALLER_LANGUAGE_ASK_AFTER_UNCLEAR = 3;
/** Меньше стольких букв — реплика неясная («Алло», «Да»). */
const MIN_LETTERS = 4;
/** Доля букв НЕ кириллицей, начиная с которой реплика — мусор распознавания, а не язык. */
const MAX_FOREIGN_SHARE = 0.2;
/** Слов (из двух и больше букв) в уверенной реплике не меньше стольких. */
const MIN_WORDS = 2;

function wordCount(text: string): number {
  return text.split(/[^\p{L}]+/u).filter((w) => w.length >= 2).length;
}

/** Язык одной реплики звонящего: «ru», «tg» или «unclear» (мусор, коротко, смесь). */
export function classifyCallerUtterance(text: string): CallerUtteranceLanguage {
  const trimmed = text.trim();
  const { letters, share } = foreignLetterShare(trimmed);
  if (letters < MIN_LETTERS || share > MAX_FOREIGN_SHARE) return "unclear";
  const words = wordCount(trimmed);
  if (words < MIN_WORDS) return "unclear";
  const language = detectClientLanguage(trimmed);
  return language === "ru" || language === "tg" ? language : "unclear";
}

export type CallerLanguageAction =
  /** Звонящий уверенно говорит на другом языке — модели сказать перейти. */
  | { kind: "switch"; to: CallLanguage }
  /** Язык так и не ясен — один раз спросить на обоих языках. */
  | { kind: "ask" };

/** Состояние одного звонка. Без побочных эффектов: решения возвращает наружу. */
export class CallerLanguageTracker {
  private current: CallLanguage;
  /** Хоть одна реплика звонящего была уверенной (на любом из двух языков). */
  private determined = false;
  private otherStreak = 0;
  private unclearTurns = 0;
  private asked = false;
  private turnText = "";
  /** Текущая реплика уже засчитана как уверенная — второй раз её не считаем. */
  private turnCounted = false;

  constructor(initial: CallLanguage) {
    this.current = initial;
  }

  get language(): CallLanguage {
    return this.current;
  }

  /** Язык, если звонящий хоть раз говорил уверенно; null — так и не ясен. */
  get knownLanguage(): CallLanguage | null {
    return this.determined ? this.current : null;
  }

  /**
   * Очередной кусок расшифровки речи звонящего. Уверенная реплика засчитывается сразу,
   * как только стала уверенной (а не в конце хода): поправка «перейди на русский» должна
   * успеть к ответу на эту же реплику.
   */
  onCallerText(chunk: string): CallerLanguageAction | null {
    if (this.turnText.length < 2_000) this.turnText += chunk;
    if (this.turnCounted) return null;
    const heard = classifyCallerUtterance(this.turnText);
    if (heard === "unclear") return null;
    this.turnCounted = true;
    this.determined = true;
    if (heard === this.current) {
      this.otherStreak = 0;
      return null;
    }
    this.otherStreak += 1;
    if (this.otherStreak < CALLER_LANGUAGE_SWITCH_AFTER) return null;
    this.current = heard;
    this.otherStreak = 0;
    return { kind: "switch", to: heard };
  }

  /** Язык уже спросили другим путём (разрыв петли «плохо слышно», liveVoicePoorLine.ts). */
  markAsked(): void {
    this.asked = true;
  }

  /** Модель закончила ход — реплика звонящего перед ним закончилась тоже. */
  onModelTurnComplete(): CallerLanguageAction | null {
    const hadText = this.turnText.trim().length > 0;
    const counted = this.turnCounted;
    this.turnText = "";
    this.turnCounted = false;
    // Тишина (ход модели без реплики звонящего — приветствие, поправка) — не реплика.
    if (!hadText || counted || this.determined) return null;
    this.unclearTurns += 1;
    if (this.asked || this.unclearTurns < CALLER_LANGUAGE_ASK_AFTER_UNCLEAR) return null;
    this.asked = true;
    return { kind: "ask" };
  }
}

/** Трекер на звонок: с замком «только русский» его нет. */
export function createCallerLanguageTracker(forceRussianOnly: boolean, initial: CallLanguage): CallerLanguageTracker | null {
  return forceRussianOnly ? null : new CallerLanguageTracker(initial);
}

/** Служебная реплика «звонящий перешёл на другой язык» (текст в скобках не для озвучивания). */
export function callerLanguageSwitchNote(to: CallLanguage): string {
  return to === "ru"
    ? "(Служебное: человек говорит по-русски — дальше говори с ним по-русски, пока он сам не перейдёт на таджикский. Об этом не говори и не извиняйся. Эту пометку вслух не читай.)"
    : "(Служебное: человек говорит по-таджикски — дальше говори с ним по-таджикски, живым разговорным языком, пока он сам не перейдёт на русский. Об этом не говори и не извиняйся. Эту пометку вслух не читай.)";
}

/** Сам вопрос — таджикский первым (решение владельца 10.10.2026). */
export const CALLER_LANGUAGE_QUESTION = "Тоҷикӣ ё русӣ — бо кадом забон гап занем? На каком языке вам удобнее — таджикском или русском?";

/** Служебная реплика «спроси язык» после двух переспросов подряд: здесь спросить обязательно. */
export function callerLanguageAskAfterRepromptsNote(): string {
  return (
    "(Служебное: ты уже дважды переспросил — третий раз повторить НЕ проси и «плохо слышно» не говори. " +
    `Одной короткой фразой спроси на двух языках, сначала по-таджикски: «${CALLER_LANGUAGE_QUESTION}» — и дальше говори на том, который он выберет. ` +
    "Эту пометку вслух не читай.)"
  );
}

/** Служебная реплика «спроси язык». */
export function callerLanguageAskNote(): string {
  return (
    "(Служебное: на каком языке говорит человек, по расшифровке не понять. Если ты сам его ясно понимаешь — не спрашивай, просто продолжай на его языке. " +
    `Иначе одной короткой фразой спроси на двух языках, сначала по-таджикски: «${CALLER_LANGUAGE_QUESTION}» — и дальше говори на том, который он выберет. ` +
    "Не говори, что плохо слышно. Эту пометку вслух не читай.)"
  );
}

/**
 * РАСШИФРОВКА LIVE НЕНАДЁЖНА (10.10.2026). Хоть одна реплика звонящего в расшифровке —
 * мусор не кириллицей: итог звонка (заметка, задача) не должен строиться на ней как на
 * факте. Строки — в формате расшифровки сессии («Клиент: …»).
 */
export function liveTranscriptUnreliable(transcript: readonly string[]): boolean {
  return transcript.some((line) => {
    if (!line.startsWith("Клиент:")) return false;
    const { letters, share } = foreignLetterShare(line.slice("Клиент:".length));
    return letters >= MIN_LETTERS && share > MAX_FOREIGN_SHARE;
  });
}

/** Только реплики звонящего на нормальной кириллице — для языка в досье. */
export function reliableCallerText(transcript: readonly string[]): string {
  return transcript
    .filter((line) => line.startsWith("Клиент:"))
    .map((line) => line.slice("Клиент:".length).trim())
    .filter((text) => foreignLetterShare(text).share <= MAX_FOREIGN_SHARE)
    .join(" ");
}

export const LIVE_TRANSCRIPT_UNRELIABLE_NOTE =
  "Расшифровка Live ненадёжна (реплики клиента записаны не кириллицей) — сверить основным распознаванием по записи звонка.";
