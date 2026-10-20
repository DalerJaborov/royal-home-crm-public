/**
 * СТОРОЖА ОТВЕТА РОБОТА-КОНСУЛЬТАНТА НА ЛИНИИ (08.10.2026, расшифровки звонков 03.10).
 *
 * Промт — просьба, а не гарантия (royal-home-prompt-is-not-a-guarantee). На живых
 * звонках 03.10 робот (1) отвечал на испанском/немецком/португальском на мусорную
 * расшифровку русской речи и (2) называл объекты с улицами и ценами, которых никто не
 * докажет из каталога. Здесь — чистая логика сторожей без сети и базы, чтобы её можно
 * было проверить юнит-тестом; побочные действия (журнал, служебная реплика, отбой)
 * делает мост (liveVoiceBridge.ts, wireGeminiEvents), получая от сторожа «находки».
 *
 * ВХОД — расшифровка ответа модели (outputTranscription), которая приходит кусками по
 * ходу реплики. Звук к этому моменту уже ушёл в линию: вырезать сказанное нельзя, поэтому
 * сторож только ЖУРНАЛИРУЕТ и (для языка) поправляет следующую реплику. Это сознательное
 * отличие от чат-бота, у которого текст проходит щит до отправки (ai/priceGuard.ts).
 *
 * ЦЕНЫ — ТОТ ЖЕ ЩИТ, ЧТО У ЧАТ-БОТА. `guardPrices` вызывается как есть (одно правило —
 * одно место, CLAUDE.md), своей второй копии разбора цен здесь нет. Адреса (улицы,
 * проспекты) у чат-бота отдельной сверки не имеют — она написана здесь и покрывает
 * только названия с явным словом «улица/проспект/…» и «около/возле/напротив».
 *
 * ЧИСЛА — И ЦИФРАМИ, И СЛОВАМИ (09.10.2026, аудит перед первым клиентом, P0-1). Функции
 * отдают модели цену, площадь и этаж СЛОВАМИ («сорок пять тысяч долларов»), а расшифровка
 * ответа модели приходит то словами, то цифрами. Раньше сторож видел только цифры: цена
 * из подборки, расшифрованная цифрами, считалась выдумкой, а выдумка словами проходила
 * мимо. Теперь обе стороны сначала приводятся к цифрам (spokenNumbersToDigits из
 * @royal-home/shared — те же словари, которыми числа озвучиваются), а сырые числа
 * объектов функция кладёт в ответ скрытым полем (attachGuardFacts): модель его не видит,
 * сторож — видит.
 *
 * УЛИЦЫ, ПЛОЩАДЬ, ЭТАЖ — ТОЛЬКО ИЗ ПОДБОРКИ ЗВОНКА И СЛОВ КЛИЕНТА. Справочник (карта
 * мест, «про нас») для них не источник: в нём есть Рудаки и Сомони, и «двушка на
 * проспекте Рудаки» из головы модели проходила как законная (случай 03.10). Цена из
 * справочника законна по-прежнему (курс, комиссия).
 *
 * КАЖДАЯ РЕПЛИКА. Находка сообщается один раз на каждое НОВОЕ утверждение за звонок (а
 * не одна находка на весь звонок, после которой сторож молчал). К находке приложена
 * служебная поправка для модели (correction) — отправлять её решает мост.
 */

import { spokenNumbersToDigits } from "@royal-home/shared";
import { guardAvailability } from "../../ai/availabilityGuard.js";
import { findBannedWords } from "../../ai/bannedWordsGuard.js";
import {
  extractAreaClaims,
  extractFloorClaims,
  extractStreetMentions,
  findOffCatalogClaims,
  type OffCatalogClaims,
} from "../../ai/catalogClaimsGuard.js";
import { guardDiscounts } from "../../ai/priceGuard.js";
import { normalizeForRepeatCheck } from "../../ai/replyRepeatGuard.js";

export type GuardLanguage = "ru" | "tg";

/** Меньше стольких букв в реплике — язык не судим («Алло», «Royal Home»). */
export const WRONG_LANGUAGE_MIN_LETTERS = 12;
/** Доля букв не из кириллицы, начиная с которой реплика считается «не на том языке». */
export const WRONG_LANGUAGE_FOREIGN_SHARE = 0.6;
/** Сколько текста результатов функций помним на звонок (хвост). */
const TOOL_RESULTS_CAP = 100_000;

/**
 * Доля букв не из кириллицы. И русский, и таджикский пишутся кириллицей, поэтому любая
 * другая письменность (латиница испанского/немецкого/португальского, арабица и т. д.) —
 * чужой язык. Латиница — главный случай (требование задания: ≥ 60 % латиницы); остальное
 * — тот же признак, не отдельное правило.
 */
export function foreignLetterShare(text: string): { letters: number; share: number } {
  let letters = 0;
  let foreign = 0;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    letters += 1;
    if (!/\p{Script=Cyrillic}/u.test(ch)) foreign += 1;
  }
  return { letters, share: letters === 0 ? 0 : foreign / letters };
}

/** Доля букв арабского письма (персидская запись таджикской речи, «урду»). */
export function arabicLetterShare(text: string): number {
  let letters = 0;
  let arabic = 0;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    letters += 1;
    if (/\p{Script=Arabic}/u.test(ch)) arabic += 1;
  }
  return letters === 0 ? 0 : arabic / letters;
}

export function isWrongLanguageReply(text: string): boolean {
  const { letters, share } = foreignLetterShare(text);
  return letters >= WRONG_LANGUAGE_MIN_LETTERS && share >= WRONG_LANGUAGE_FOREIGN_SHARE;
}

/**
 * НА КАКОМ ЯЗЫКЕ ГОВОРИТ САМ ЗВОНЯЩИЙ, ЕСЛИ НЕ ПО-РУССКИ И НЕ ПО-ТАДЖИКСКИ (09.10.2026,
 * исследование П2). Нужен сторожу языка: робот ответил узбеку по-узбекски — это не
 * «мусор распознавания», а клиент, которого раньше сбрасывали. Только латиница (так
 * модель расшифровывает узбекскую и английскую речь) и только по словам-приметам, не
 * меньше двух разных: мусорная расшифровка на случайных языках (56–64 % кусков, замер
 * 09.10) приметы обоих языков сразу почти не даёт. null — не узнали.
 */
export type ForeignCallerLanguage = "uz" | "en";
/** Сколько последних символов речи звонящего смотрит определитель. */
const CALLER_LANGUAGE_WINDOW = 600;
const UZBEK_MARKERS =
  /(?<![\p{L}'ʻʼ])(salom|assalomu|rahmat|kerak|qancha|qayerda|bormi|yo['ʻʼ]q|uy|uyi|xonadon|xona|kvartira|narxi|men|siz|sizga|bilan|emas|yaxshi|xop|xo['ʻʼ]p|ha|ijara|sotib|olmoqchi|qilmoqchi|gaplashing|o['ʻʼ]zbek(?:cha|ча)?)(?![\p{L}'ʻʼ])/giu;
const ENGLISH_MARKERS =
  /(?<![\p{L}'])(hello|hi|the|is|are|you|your|want|need|looking|apartment|flat|house|rent|buy|price|how|much|please|english|speak|do|can|i|i'm|my|for|sale|room|rooms)(?![\p{L}'])/giu;

export function detectForeignCallerLanguage(text: string): ForeignCallerLanguage | null {
  const { letters, share } = foreignLetterShare(text);
  if (letters < WRONG_LANGUAGE_MIN_LETTERS || share < WRONG_LANGUAGE_FOREIGN_SHARE) return null;
  const distinct = (re: RegExp) => new Set([...text.matchAll(re)].map((m) => m[1].toLowerCase().replace(/[ʻʼ]/g, "'"))).size;
  const uz = distinct(UZBEK_MARKERS);
  const en = distinct(ENGLISH_MARKERS);
  if (uz >= 2 && uz > en) return "uz";
  if (en >= 2 && en > uz) return "en";
  return null;
}

/** Прощание на языке звонящего с передачей человеку (служебное, не для озвучивания). */
export function foreignLanguageFarewellTrigger(language: ForeignCallerLanguage): string {
  const name = language === "uz" ? "по-узбекски" : "по-английски";
  return (
    `(Собеседник говорит ${name}. Скажи ОДНОЙ короткой фразой ${name.toUpperCase()}, что коллега перезвонит ему и ` +
    "поговорит с ним, и попрощайся. Функции не вызывай — звонок завершится сам.)"
  );
}

/** Служебная поправка модели, один раз (текст в скобках — не для озвучивания). */
export function languageCorrectionText(language: GuardLanguage): string {
  return language === "tg"
    ? "(Служебное: твоя последняя реплика была не на языке разговора. Продолжай по-таджикски (или по-русски, если человек говорит по-русски) и только на этих языках. " +
        // 10.10.2026: «коротко переспроси» здесь кормило петлю «плохо слышно» — речь, похожая на
        // персидский или турецкий, у нас почти всегда таджикская.
        "Речь человека, похожая на персидский, турецкий или узбекский, — это таджикский: отвечай по-таджикски и не переспрашивай из-за этого. Эту пометку вслух не читай.)"
    : "(Служебное: твоя последняя реплика была не по-русски. Ответь по-русски и только по-русски. " +
        "Непонятная расшифровка — это помехи, а не другой язык: коротко переспроси по-русски. Эту пометку вслух не читай.)";
}

/** Сторож «вне подборки» живёт в ai/catalogClaimsGuard.ts (общий с чатом, 10.10.2026). */
export { extractAreaClaims, extractFloorClaims, extractStreetMentions, findOffCatalogClaims, type OffCatalogClaims };

// ── сырые числа объектов в ответе функции ─────────────────────────────────────

/**
 * Скрытое поле ответа функции с сырыми числами объектов (09.10.2026, P0-1). Ключ —
 * Symbol, свойство неперечисляемое: JSON.stringify (отправка ответа модели) и
 * разворот `{...}` его не видят, модель цифр не получает. Сторож читает его прямо с
 * объекта ответа, который мост передаёт в addToolResult.
 */
export const LIVE_VOICE_GUARD_FACTS: unique symbol = Symbol("liveVoiceGuardFacts");

export interface GuardPropertyFacts {
  price: number | null;
  currency: string | null;
  areaSqm: number | null;
  floor: number | null;
  totalFloors: number | null;
}

/** Приложить к ответу функции сырые числа объектов, о которых в нём рассказано. */
export function attachGuardFacts<T extends object>(response: T, facts: GuardPropertyFacts[]): T {
  Object.defineProperty(response, LIVE_VOICE_GUARD_FACTS, { value: facts, enumerable: false });
  return response;
}

/**
 * СТРОКА РАСШИФРОВКИ О ДЕЙСТВИИ ФУНКЦИИ (09.10.2026, робот-консультант: показ, перезвон,
 * отправка в мессенджер). Что робот СДЕЛАЛ в CRM, должно быть видно в расшифровке звонка
 * рядом с репликами — руководитель проверяет по ней, записал ли робот показ, на когда
 * поставил перезвон, что и куда отправил. Тем же приёмом, что сырые числа выше: Symbol,
 * неперечисляемое свойство — модель строки не видит, мост берёт её через
 * toolResultTranscriptLine. Без телефонов и имён клиентов.
 */
export const LIVE_VOICE_TRANSCRIPT_LINE: unique symbol = Symbol("liveVoiceTranscriptLine");

export function attachTranscriptLine<T extends object>(response: T, line: string): T {
  Object.defineProperty(response, LIVE_VOICE_TRANSCRIPT_LINE, { value: line, enumerable: false });
  return response;
}

function guardFactsOf(response: unknown): GuardPropertyFacts[] {
  if (!response || typeof response !== "object") return [];
  const facts = (response as { [LIVE_VOICE_GUARD_FACTS]?: unknown })[LIVE_VOICE_GUARD_FACTS];
  return Array.isArray(facts) ? (facts as GuardPropertyFacts[]) : [];
}

/** Сырые числа — строкой, которую понимают те же разборы, что и речь модели. */
function factsAsText(facts: GuardPropertyFacts[]): string {
  return facts
    .map((f) =>
      [
        f.price !== null && f.price > 0 ? `${Math.round(f.price)} ${f.currency === "USD" ? "долларов" : "сомони"}` : "",
        f.areaSqm !== null && f.areaSqm > 0 ? `${f.areaSqm} кв.м` : "",
        f.floor !== null ? `${f.floor} этаж` : "",
        f.totalFloors !== null ? `${f.totalFloors} этаж` : "",
      ]
        .filter(Boolean)
        .join("; ")
    )
    .join("\n");
}

/**
 * Служебная поправка модели на находку «вне подборки» (P0-1, п.5). Звук уже ушёл в
 * линию, вырезать сказанное нельзя, — модель одной фразой поправляется сама. Без
 * рода («назвал/назвала»): правило рода вешает мост от имени голоса.
 */
export function offCatalogCorrectionText(what: {
  catalog: boolean;
  noOptions: boolean;
  discount: boolean;
  /** Запрещённые слова таджикского (ai/bannedWordsGuard.ts — тот же список, что у чата). */
  bannedWords?: string[];
  /** Реплика дословно повторила предыдущую (тот же признак, что у чата). */
  repeated?: boolean;
}): string {
  const parts: string[] = [];
  if (what.catalog) {
    parts.push(
      "в твоей последней реплике прозвучали адрес, цена, площадь или этаж, которых нет в ответах функций этого звонка. Одной фразой поправься: точные данные по этому варианту скажет агент; дальше называй только то, что вернули search_properties и get_property"
    );
  }
  if (what.noOptions) {
    parts.push(
      "варианты ещё не просмотрены через search_properties — не говори, что они есть или что их много; одной фразой поправься и посмотри через search_properties"
    );
  }
  if (what.discount) {
    parts.push("размер скидки не называй никогда — торг обсуждает агент с собственником, так и скажи одной фразой");
  }
  if (what.bannedWords && what.bannedWords.length > 0) {
    parts.push(`слова «${what.bannedWords.join("», «")}» не говори — их в агентстве не используют, говори проще`);
  }
  if (what.repeated) {
    parts.push("ты слово в слово повторил свою прошлую реплику — не повторяйся, ответь на то, что человек сказал сейчас, другими словами");
  }
  return `(Служебное: ${parts.join("; ")}. Эту пометку вслух не читай.)`;
}

export type ReplyGuardFinding =
  | {
      kind: "wrong_language";
      /** Сколько реплик подряд ушло не на том языке (1 — первая). */
      streak: number;
      share: number;
      sample: string;
      /** Писать ли в журнал (один раз за звонок). */
      logIt: boolean;
      /** Отправить модели поправку (один раз за звонок, на первой плохой реплике). */
      sendCorrection: boolean;
      /** Вторая плохая реплика подряд — завершить разговор. */
      endCall: boolean;
      /** Звонящий сам говорит по-узбекски/по-английски (detectForeignCallerLanguage) —
       *  при endCall прощание на его языке и передача человеку, а не «мусор распознавания». */
      callerLanguage: ForeignCallerLanguage | null;
    }
  | {
      kind: "off_catalog";
      prices: number[];
      streets: string[];
      areas: number[];
      floors: number[];
      /** «Есть хорошие варианты», а search_properties ещё ничего не вернул (P1-7). */
      noOptionsClaim: boolean;
      /** Проценты скидки, названные роботом (P1-7, тот же guardDiscounts, что у чат-бота). */
      discounts: number[];
      /** Запрещённые слова таджикского — тот же список, что у чата (10.10.2026, P1-6). */
      bannedWords: string[];
      /** Реплика дословно повторила предыдущую — тот же признак, что у чата (P1-6). */
      repeated: boolean;
      sample: string;
      /** Человеческое описание для журнала и расшифровки. */
      summary: string;
      /** Служебная реплика модели — отправляет мост (gemini.sendText). */
      correction: string;
    };

export interface ReplyGuardOptions {
  language: GuardLanguage;
  /**
   * Таджикский в звонке разрешён (замок «только русский» снят). Тогда реплика робота,
   * расшифрованная АРАБСКИМ письмом, по-прежнему находка (в журнал и одна поправка —
   * сторож пропускает только русский и таджикский кириллицей), но трубку из-за неё не
   * кладём: таджикская речь — тот же персидский язык, и распознавание пишет её персидским
   * письмом («урду») так же, как речь звонящего (10.10.2026, разбор звонков).
   */
  tajikAllowed?: boolean;
  /** Системная инструкция звонка: справочник агентства — законный источник цен (не улиц). */
  knowledgeText?: string;
  usdToTjs?: number;
}

/** Описание находки «вне подборки» — для журнала и строки расшифровки. */
function offCatalogSummary(
  f: Pick<Extract<ReplyGuardFinding, { kind: "off_catalog" }>, "prices" | "streets" | "areas" | "floors" | "noOptionsClaim" | "discounts" | "bannedWords" | "repeated">
): string {
  return [
    f.prices.length > 0 ? `цены ${f.prices.join(", ")}` : "",
    f.streets.length > 0 ? `улицы/ориентиры ${f.streets.join(", ")}` : "",
    f.areas.length > 0 ? `площадь ${f.areas.join(", ")} м²` : "",
    f.floors.length > 0 ? `этаж ${f.floors.join(", ")}` : "",
    f.noOptionsClaim ? "«есть варианты» до поиска" : "",
    f.discounts.length > 0 ? `скидка ${f.discounts.join(", ")} %` : "",
    f.bannedWords.length > 0 ? `запрещённые слова ${f.bannedWords.join(", ")}` : "",
    f.repeated ? "дословный повтор прошлой реплики" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/** Есть ли в ответе функции хоть один объект: после этого «есть варианты» — правда. */
function responseHasOptions(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  const r = response as { found?: unknown; options?: unknown; candidates?: unknown; sold?: unknown };
  if (typeof r.found === "number") return r.found > 0;
  if (r.found === true && r.sold !== true) return true;
  return (Array.isArray(r.options) && r.options.length > 0) || (Array.isArray(r.candidates) && r.candidates.length > 0);
}

/** Состояние сторожей одного звонка. Без побочных эффектов: решения возвращает наружу. */
export class LiveVoiceReplyGuard {
  /** Язык разговора. Меняется, когда звонящий уверенно перешёл на другой язык
   *  (liveVoiceCallerLanguage.ts, setLanguage) — поправка сторожа зовёт на текущий. */
  language: GuardLanguage;
  private readonly tajikAllowed: boolean;
  usdToTjs: number | undefined;
  private readonly knowledgeText: string;
  private toolResults = "";
  private clientText = "";
  private turnText = "";
  private turnBad = false;
  private streak = 0;
  private languageLogged = false;
  private correctionSent = false;
  /** Что уже сообщено «вне подборки» за звонок: повтор того же — не новая находка. */
  private readonly reportedClaims = new Set<string>();
  /** search_properties/get_property уже вернули хоть один объект. */
  private optionsShown = false;
  /** Прошлая законченная реплика робота — для сторожа дословного повтора (общий с чатом признак). */
  private lastTurnText = "";
  private repeatReported = false;
  /** В прошлой реплике уже была находка: её повтор не новая находка (та же поправка уже ушла). */
  private lastTurnHadFinding = false;
  private turnHadFinding = false;

  constructor(opts: ReplyGuardOptions) {
    this.language = opts.language;
    this.tajikAllowed = opts.tajikAllowed === true;
    this.knowledgeText = opts.knowledgeText ?? "";
    this.usdToTjs = opts.usdToTjs;
  }

  /** Звонящий уверенно перешёл на другой язык (liveVoiceCallerLanguage.ts). */
  setLanguage(language: GuardLanguage): void {
    this.language = language;
  }

  /** Ответ функции (search_properties, get_property…) — законный источник адресов и цен. */
  addToolResult(response: unknown): void {
    let text: string;
    try {
      text = JSON.stringify(response) ?? "";
    } catch {
      return;
    }
    const facts = factsAsText(guardFactsOf(response));
    if (responseHasOptions(response)) this.optionsShown = true;
    this.toolResults = (this.toolResults + "\n" + text + (facts ? `\n${facts}` : "")).slice(-TOOL_RESULTS_CAP);
  }

  /** Слова клиента: названное им робот вправе повторить. */
  addClientText(text: string): void {
    this.clientText = (this.clientText + "\n" + text).slice(-TOOL_RESULTS_CAP);
  }

  /** Очередной кусок расшифровки ответа модели. Возвращает НОВЫЕ находки. */
  onModelText(chunk: string): ReplyGuardFinding[] {
    this.turnText += chunk;
    const findings: ReplyGuardFinding[] = [];

    if (!this.turnBad && isWrongLanguageReply(this.turnText)) {
      this.turnBad = true;
      this.streak += 1;
      findings.push({
        kind: "wrong_language",
        streak: this.streak,
        share: foreignLetterShare(this.turnText).share,
        sample: this.turnText.slice(0, 160),
        logIt: !this.languageLogged,
        sendCorrection: !this.correctionSent && this.streak === 1,
        // Арабица при разрешённом таджикском — вероятно, таджикская речь робота в персидской
        // записи: журнал и поправка да, отбой нет (класть трубку из-за расшифровки нельзя).
        endCall: this.streak >= 2 && !(this.tajikAllowed && arabicLetterShare(this.turnText) >= 0.5),
        // Последние реплики звонящего, а не весь звонок: язык решают свежие слова.
        callerLanguage: detectForeignCallerLanguage(this.clientText.slice(-CALLER_LANGUAGE_WINDOW)),
      });
      this.languageLogged = true;
      if (this.streak === 1) this.correctionSent = true;
    }

    const offCatalog = this.checkCatalog();
    if (offCatalog) findings.push(offCatalog);
    return findings;
  }

  /**
   * Сверка реплики с подборкой звонка. Каждое утверждение сообщается один раз за звонок:
   * куски одной реплики и повтор того же в следующей не плодят находок, а новое
   * утверждение в любой следующей реплике — новая находка (раньше сторож замолкал
   * после первой находки до конца звонка).
   */
  private checkCatalog(): ReplyGuardFinding | null {
    const claims = findOffCatalogClaims({
      text: this.turnText,
      allowedText: `${this.knowledgeText}\n${this.toolResults}\n${this.clientText}`,
      catalogText: this.toolResults,
      clientText: this.clientText,
      usdToTjs: this.usdToTjs,
    });
    const digitized = spokenNumbersToDigits(this.turnText);
    const noOptions = !this.optionsShown && guardAvailability([this.turnText], false).removed.length > 0;
    const discounts = guardDiscounts([digitized]).invented;
    // Запрещённые слова и дословный повтор — те же признаки, что у чата (ai/bannedWordsGuard.ts,
    // ai/replyRepeatGuard.ts; аудит 10.10.2026, P1-6). Звук уже в линии: только находка и поправка.
    const bannedWords = findBannedWords(this.turnText);
    const repeated = !this.repeatReported && !this.lastTurnHadFinding && isVerbatimRepeat(this.turnText, this.lastTurnText);
    const fresh = <T>(prefix: string, items: T[]) => items.filter((v) => !this.reportedClaims.has(`${prefix}:${String(v).toLowerCase()}`));
    const found = {
      prices: fresh("p", claims.prices),
      streets: fresh("s", claims.streets),
      areas: fresh("a", claims.areas),
      floors: fresh("f", claims.floors),
      noOptionsClaim: noOptions && !this.reportedClaims.has("avail"),
      discounts: fresh("d", discounts),
      bannedWords: fresh("b", bannedWords),
      repeated,
    };
    const catalog = found.prices.length + found.streets.length + found.areas.length + found.floors.length > 0;
    if (!catalog && !found.noOptionsClaim && found.discounts.length === 0 && found.bannedWords.length === 0 && !found.repeated) return null;
    const mark = (prefix: string, items: unknown[]) => items.forEach((v) => this.reportedClaims.add(`${prefix}:${String(v).toLowerCase()}`));
    mark("p", found.prices);
    mark("s", found.streets);
    mark("a", found.areas);
    mark("f", found.floors);
    mark("d", found.discounts);
    mark("b", found.bannedWords);
    this.turnHadFinding = true;
    if (found.repeated) this.repeatReported = true;
    if (found.noOptionsClaim) this.reportedClaims.add("avail");
    return {
      kind: "off_catalog",
      ...found,
      sample: this.turnText.slice(0, 200),
      summary: offCatalogSummary(found),
      correction: offCatalogCorrectionText({
        catalog,
        noOptions: found.noOptionsClaim,
        discount: found.discounts.length > 0,
        bannedWords: found.bannedWords,
        repeated: found.repeated,
      }),
    };
  }

  /** Модель закончила реплику. Хорошая достаточно длинная реплика сбрасывает счёт «подряд». */
  onTurnComplete(): void {
    if (!this.turnBad && foreignLetterShare(this.turnText).letters >= WRONG_LANGUAGE_MIN_LETTERS) this.streak = 0;
    if (this.turnText.trim()) {
      this.lastTurnText = this.turnText;
      this.lastTurnHadFinding = this.turnHadFinding;
    }
    this.turnHadFinding = false;
    this.repeatReported = false;
    this.turnText = "";
    this.turnBad = false;
  }

  /** Клиент перебил — недоговорённая реплика не считается ни хорошей, ни плохой. */
  onInterrupted(): void {
    this.turnText = "";
    this.turnBad = false;
    this.turnHadFinding = false;
  }
}

/** Слишком короткие реплики («Ага», «Да-да») повторяются законно — тот же порог, что у чата
 *  (ai/leadQualifier.ts::isRepeatOfLastReply, REPEAT_MIN_CHARS). */
const VERBATIM_REPEAT_MIN_CHARS = 25;

/** Реплика слово в слово повторяет прошлую (нормализация — общая с чатом, replyRepeatGuard.ts). */
export function isVerbatimRepeat(text: string, previous: string): boolean {
  if (!previous) return false;
  const now = normalizeForRepeatCheck(text);
  return now.length >= VERBATIM_REPEAT_MIN_CHARS && now === normalizeForRepeatCheck(previous);
}

// ── видимость для разбора звонка (P1-1) ──────────────────────────────────────

/** Ключ журнала для находок «вне подборки». Звонок различает dedupScope (systemError.ts). */
export const OFF_CATALOG_DEDUP_KEY = "live-voice-off-catalog-claim";

/** Строка журнала ошибок о находке «вне подборки» — одна формулировка для моста и тестов. */
export function offCatalogLogMessage(channelId: string, f: Extract<ReplyGuardFinding, { kind: "off_catalog" }>): string {
  const catalog =
    f.prices.length + f.streets.length + f.areas.length + f.floors.length + f.discounts.length > 0 || f.noOptionsClaim;
  if (!catalog) {
    return (
      `Робот нарушил правила речи: ${f.summary} — звонок ${channelId}. ` +
      `Фраза: «${f.sample}». Реплика уже озвучена; проверьте запись звонка.`
    );
  }
  return (
    `Робот назвал вне подборки: ${f.summary} — этого нет в ответах функций поиска за звонок ${channelId}. ` +
    `Фраза: «${f.sample}». Реплика уже озвучена; проверьте запись звонка.`
  );
}

/** Строка расшифровки сессии о находке сторожа: «[сторож: вне подборки: …]». */
export function offCatalogTranscriptLine(f: Extract<ReplyGuardFinding, { kind: "off_catalog" }>): string {
  return `[сторож: вне подборки: ${f.summary}]`;
}

/**
 * Строка расшифровки сессии о вызове функции (P1-1): по расшифровке видно, откуда робот
 * взял цену. Объекты — номерами, без адресов и цен; телефонов и имён клиентов здесь нет.
 * null — функция не из тех, что стоит показывать (save_contact, end_call).
 */
export function toolResultTranscriptLine(name: string, response: unknown): string | null {
  // Функция сама сказала, что сделала (запись на показ, перезвон, отправка): строка
  // приложена к ответу скрытым полем (attachTranscriptLine) и модель её не видит.
  const own = response && typeof response === "object" ? (response as { [LIVE_VOICE_TRANSCRIPT_LINE]?: unknown })[LIVE_VOICE_TRANSCRIPT_LINE] : undefined;
  if (typeof own === "string" && own.trim()) return own;
  const r = (response && typeof response === "object" ? response : {}) as Record<string, unknown>;
  const fail = r.ok === false ? `отказ: ${String(r.error ?? "").slice(0, 120)}` : null;
  if (name === "search_properties") {
    if (fail) return `[функция search_properties: ${fail}]`;
    const options = Array.isArray(r.options) ? (r.options as { number?: unknown }[]) : [];
    const numbers = options.map((o) => o.number).filter((n) => typeof n === "number");
    return `[функция search_properties: найдено ${typeof r.found === "number" ? r.found : options.length}${numbers.length ? `, номера ${numbers.join(", ")}` : ""}]`;
  }
  if (name === "get_property") {
    if (fail) return `[функция get_property: ${fail}]`;
    if (r.found !== true) {
      const candidates = Array.isArray(r.candidates) ? r.candidates.length : 0;
      return `[функция get_property: не найден${candidates ? `, кандидатов ${candidates}` : ""}]`;
    }
    const state = r.sold === true ? "продан" : r.closed === true ? "закрытый" : "найден";
    return `[функция get_property: ${state}${typeof r.number === "number" ? `, номер ${r.number}` : ""}]`;
  }
  if (name === "transfer_to_agent") {
    if (fail) return `[перевод: ${fail}]`;
    return `[перевод: → ${typeof r.transferred_to === "string" ? r.transferred_to : "звонок ушёл"}]`;
  }
  if (name === "send_property_sms") {
    return fail ? `[СМС: ${fail}]` : `[СМС: отправлено ${typeof r.sent === "number" ? r.sent : "?"}]`;
  }
  return null;
}
