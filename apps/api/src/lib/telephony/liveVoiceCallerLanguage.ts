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
 *     неясности язык решает сама модель по тексту распознавания, помня, что он ошибается
 *     (правило в промте; с 11.11.2026 модель ElevenLabs звука не слышит).
 *  3. Язык меняется после ДВУХ уверенных кириллических реплик подряд на другом
 *     языке (неясные между ними не считаются ни за, ни против); на таджикский — уже после
 *     ОДНОЙ твёрдо таджикской (16.11.2026, isConfidentTajik ниже). Уверенность — тот же
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

import { clientLanguageScores, detectClientLanguage } from "../../ai/clientLanguage.js";
import { foreignLetterShare } from "./liveVoiceGuards.js";

export type CallLanguage = "ru" | "tg";
export type CallerUtteranceLanguage = CallLanguage | "unclear";

/** Сколько уверенных реплик подряд на другом языке переключают язык звонка (на русский — всегда;
 *  на таджикский — когда фраза не «твёрдо таджикская», см. isConfidentTajik). */
export const CALLER_LANGUAGE_SWITCH_AFTER = 2;
/**
 * ПЕРЕХОД НА ТАДЖИКСКИЙ — С ПЕРВОЙ ТВЁРДОЙ ФРАЗЫ (16.11.2026, разбор звонков голоса Anna, п. 4).
 * Пока звонок в ru, распознавание ElevenLabs пишет таджикскую речь русским мусором («Ча-чан смаи?»),
 * и робот переспрашивал: на втором ходе было уже поздно. Владелец: таджикский — в приоритете.
 * Защита от ложного перехода у русскоязычных: «твёрдо» — это не меньше стольких РАЗНЫХ таджикских
 * слов без приветствий и «спасибо» (tajikWordCount ниже). «Рахмат, хорошо»,
 * «Салом, мне двушку», «Да ака, в Сино» — не твёрдо: идут прежним путём, двумя фразами подряд.
 */
export const CALLER_TAJIK_CONFIDENT_WORDS = 2;
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

/**
 * Сколько РАЗНЫХ слов фразы — таджикские, БЕЗ приветствий и «спасибо». Слово за словом через общий
 * определитель (ai/clientLanguage.ts::clientLanguageScores): по всей фразе он считает «мехоҳам» дважды
 * (по букве и по списку), а здесь важно, сколько таджикских слов человек сказал. Сам определитель не
 * трогаем: его байты входят в отпечаток ядра чат-бота (customerAgentRegistration.ts, coreHash).
 */
export function tajikWordCount(text: string): number {
  const words = new Set((text.match(/\p{L}+/gu) ?? []).map((w) => w.toLowerCase()));
  return [...words].filter((w) => {
    if (TAJIK_FILLER_WORDS.test(w)) return false;
    const s = clientLanguageScores(w);
    return s.greetings === 0 && s.tajik > 0;
  }).length;
}

/**
 * Обращения и поддакивания — НЕ таджикская речь (ревью #204, В1): в Душанбе их вставляют и русскоязычные.
 * «Ака хуб, давайте в Сино», «Хуб, ака, майлаш», «Бале, бале, дорам» с ними считались твёрдо таджикскими,
 * и робот уводил русского звонящего на таджикское распознавание.
 */
const TAJIK_FILLER_WORDS =
  /^(?:ака|акаҷон|акачон|апа|апаҷон|апачон|ҷон|чон|хуб|хоп|ҳа|ха|ҳаа|хаа|бале|балеъ|майлаш|майли|майлӣ|нест|не|ок|окей|аҳа|ахаа|ҳм|ҳмм|хм)$/u;

/** Фраза твёрдо таджикская: определитель говорит «tg», содержательных таджикских слов (не приветствий,
 *  не обращений и поддакиваний) не меньше CALLER_TAJIK_CONFIDENT_WORDS и НИ ОДНОГО русского слова.
 *  Такой одной хватает, чтобы перейти на таджикский. */
export function isConfidentTajik(text: string): boolean {
  return (
    classifyCallerUtterance(text) === "tg" &&
    clientLanguageScores(text).russian === 0 &&
    tajikWordCount(text) >= CALLER_TAJIK_CONFIDENT_WORDS
  );
}

/**
 * «ВЫ ГОВОРИТЕ ПО-ТАДЖИКСКИ?» — СМЕНА ЯЗЫКА КОДОМ (ревью #204, В2). Вопрос обычно задают по-русски, трекер
 * слышит русскую фразу и язык звонка не меняет: робот отвечал «Ҳа» и говорил по-таджикски, а распознавание
 * оставалось русским — и таджикские ответы снова становились мусором («Ча-чан смаи?», причина №2 разбора).
 * Теперь такой вопрос на любом языке сразу переключает звонок на таджикский вместе с распознаванием
 * (служебная пометка с language_detection — liveVoiceBridge.ts::handleCallerLanguage). «Я не говорю
 * по-таджикски», «не говорите по-таджикски», «по-таджикски или по-русски?» — не просьба.
 */
// Глагол — только вопрос ко второму лицу («говорите», «знаете»), не инфинитив: «я не могу говорить по-таджикски»
// — это как раз просьба о русском (повторное ревью #204, Н-2). «Таджикский» без «по-» — только рядом со «знаете /
// понимаете / язык», не с «вариант / договор».
const ASKS_TAJIK_RU =
  /(?:говорите|разговариваете|понимаете|знаете|можете|умеете|сможете)\s+(?:\p{L}+\s+){0,2}(?:по[-\s]?таджикски|на\s+таджикском)|(?:знаете|понимаете)\s+таджикский|таджикский\s+(?:язык\s+)?(?:знаете|понимаете)|(?:по[-\s]?таджикски|на\s+таджикском)[\s,]+(?:\p{L}+\s+)?(?:можно|говорите|сможете|понимаете)|можно\s+(?:по[-\s]?таджикски|на\s+таджикском)/iu;
const ASKS_TAJIK_TG =
  /(?:то[ҷч]ик[ӣи]|забони\s+то[ҷч]ик[ӣи](?:ро)?)\s+(?:медонед|медонетон|мефа[ҳх]мед|гап\s+мезанед|гап\s+зада\s+метавонед)|бо\s+(?:забони\s+)?то[ҷч]ик[ӣи]\s+(?:гап|гуфтугӯ|гуфтугу)/iu;
const MENTIONS_RUSSIAN = /по[-\s]?русски|на\s+русском|рус[ӣи](?!\p{L})|забони\s+рус/iu;
/** Отрицание и неспособность о себе: «я не могу», «мне сложно», «плохо говорю», «ман намедонам» — не просьба о таджикском. */
const SPEAKER_CANNOT = /(?<!\p{L})(?:не|я|мне|ман|нам|мы|сложно|трудно|плохо|нафаҳмам|намедонам)(?!\p{L})/iu;
/** Таджикский ДОКУМЕНТ, а не разговор: «таджикский вариант договора», «перевод на таджикском». */
const ABOUT_DOCUMENT = /вариант|договор|документ|перевод|текст|файл|бумаг|ҳуҷҷат|шартнома/iu;

export function asksToSpeakTajik(text: string): boolean {
  if (!text.trim() || MENTIONS_RUSSIAN.test(text) || SPEAKER_CANNOT.test(text) || ABOUT_DOCUMENT.test(text)) return false;
  return ASKS_TAJIK_RU.test(text) || ASKS_TAJIK_TG.test(text);
}

export type CallerLanguageAction =
  /** Звонящий уверенно говорит на другом языке — модели сказать перейти. askedForTajik — он сам спросил,
   *  говорит ли робот по-таджикски (тогда в пометке — «ответь «Ҳа»»). */
  | { kind: "switch"; to: CallLanguage; askedForTajik?: boolean }
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
    // «Вы говорите по-таджикски?» — сразу таджикский, без счёта фраз (В2).
    if (this.current !== "tg" && asksToSpeakTajik(this.turnText)) {
      this.current = "tg";
      this.determined = true;
      this.turnCounted = true;
      this.otherStreak = 0;
      return { kind: "switch", to: "tg", askedForTajik: true };
    }
    if (this.turnCounted) return null;
    const heard = classifyCallerUtterance(this.turnText);
    if (heard === "unclear") return null;
    this.turnCounted = true;
    // «Хуб, ака», «Бале, майлаш», «Рахмат» — одни поддакивания, обращения и приветствия: не довод ни за один язык
    // (ревью #204, В1). Ни перехода, ни счёта: так говорят и русскоязычные душанбинцы.
    if (heard === "tg" && tajikWordCount(this.turnText) === 0) return null;
    this.determined = true;
    if (heard === this.current) {
      this.otherStreak = 0;
      return null;
    }
    this.otherStreak += 1;
    const needed = heard === "tg" && isConfidentTajik(this.turnText) ? 1 : CALLER_LANGUAGE_SWITCH_AFTER;
    if (this.otherStreak < needed) return null;
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

/**
 * Служебная реплика «звонящий перешёл на другой язык» (текст в скобках не для озвучивания).
 *
 * languageTool — у поставщика есть встроенный language_detection (ElevenLabs, 12.11.2026).
 * Звонок владельца 11.11: модель сама перешла на таджикский текстом, но инструмент не
 * вызвала — язык разговора остался ru, и таджикский читал русский голос с русским
 * распознаванием. Голос и распознавание языка tg (language_presets.tg) включаются только
 * этим инструментом (https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/language-detection).
 */
export function callerLanguageSwitchNote(to: CallLanguage, opts: { languageTool?: boolean; askedForTajik?: boolean } = {}): string {
  const tool = opts.languageTool
    ? ` Если язык разговора ещё не переключён — сразу вызови language_detection с language "${to}", без слов об этом.`
    : "";
  if (to === "tg" && opts.askedForTajik) {
    return `(Служебное: человек спрашивает, говоришь ли ты по-таджикски. Ответь «Ҳа» и дальше говори с ним по-таджикски, живым разговорным языком, пока он сам не перейдёт на русский.${tool} Эту пометку вслух не читай.)`;
  }
  return to === "ru"
    ? `(Служебное: человек говорит по-русски — дальше говори с ним по-русски, пока он сам не перейдёт на таджикский.${tool} Об этом не говори и не извиняйся. Эту пометку вслух не читай.)`
    : `(Служебное: человек говорит по-таджикски — дальше говори с ним по-таджикски, живым разговорным языком, пока он сам не перейдёт на русский.${tool} Об этом не говори и не извиняйся. Эту пометку вслух не читай.)`;
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
