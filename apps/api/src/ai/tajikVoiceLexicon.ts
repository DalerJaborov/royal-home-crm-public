import { createHash } from "node:crypto";

/**
 * ТАДЖИКСКИЙ СЛОВАРЬ РОБОТА ПО ТЕЛЕФОНУ — ОДИН ИСТОЧНИК (11.11.2026).
 *
 * Два списка, которые CRM сама кладёт в агента ElevenLabs при подготовке
 * (ai/elevenLabsAgentSync.ts, второй PATCH), — руками в кабинете их не ведут:
 *
 *  1. TAJIK_ASR_KEYWORDS — слова, к которым распознавание речи (asr.keywords)
 *     склоняется: районы, города, ориентиры, слова рынка, имя компании.
 *  2. TAJIK_PRONUNCIATION_RULES — словарь произношения (pronunciation
 *     dictionary) для синтеза речи: как голос произносит слово.
 *
 * Что проверено живьём 11.11.2026 (аккаунт ElevenLabs, свой тестовый агент
 * agent_7501…, журнал docs/journal/2026-11-11-voice-tajik-speech.md):
 *  - ФАКТ: правила словаря (и `alias`, и `phoneme` в IPA) работают на
 *    eleven_v4_turbo с языком tg — и в TTS, и в разговоре агента;
 *  - ФАКТ: словарь, заданный на уровне агента (tts.pronunciation_dictionary_locators),
 *    звучит И в русском разговоре; словарь в пресете языка tg
 *    (language_presets.tg.overrides.tts) сохраняется, но в разговоре НЕ применился.
 *    Отсюда правило ниже: в словаре только слова с таджикскими буквами
 *    (ҳ ӯ ӣ қ ғ ҷ) — в русской речи модели их не бывает, она их не заденет;
 *  - ФАКТ: распознавание без заданного языка уводит таджикскую речь в арабский,
 *    турецкий, португальский; с языком tg и этими словами — лучше (таблица в журнале).
 *
 * Пределы: у Scribe v2 Realtime (его ElevenLabs ставит агентам по умолчанию,
 * asr.provider = scribe_realtime) — до 50 слов по 20 знаков
 * (https://elevenlabs.io/docs/overview/capabilities/speech-to-text, «Keyterm
 * prompting»). Предел самого поля агента asr.keywords справочник не называет —
 * держим тот же, его проверяет тест.
 */

/** Предел слов распознавания (Scribe v2 Realtime). */
export const ASR_KEYWORDS_MAX = 50;
/** Предел длины одного слова распознавания (Scribe v2 Realtime). */
export const ASR_KEYWORD_MAX_CHARS = 20;

/**
 * Слова для распознавания. Общие для Душанбе, НЕ подогнаны под записи замера:
 * районы и города — все крупные, ориентиры — самые частые в заявках.
 */
export const TAJIK_ASR_KEYWORDS: readonly string[] = [
  // Компания
  "Роял Хоум", "Royal Home",
  // Районы Душанбе и ближние районы
  "Шоҳмансур", "Фирдавсӣ", "Сино", "Исмоили Сомонӣ", "Рӯдакӣ",
  // Города
  "Душанбе", "Ваҳдат", "Ҳисор", "Турсунзода", "Бохтар", "Кӯлоб", "Хуҷанд",
  // Части города и ориентиры
  "Зарафшон", "Испечак", "Гипрозем", "Қазоқон", "Сомон", "Шотемур", "Айнӣ", "Бухоро",
  "Корвон", "Саховат", "Сирк", "Ватан", "Профсоюз", "Ҳаёти нав", "микрорайон",
  // Жильё и сделка — как говорит рынок
  "ошёна", "этаж", "таъмир", "ремонт", "коробка", "ҳавлӣ", "квартира", "новостройка",
  "бинои нав", "ипотека", "шартнома", "ҳуҷҷат", "соҳибмулк", "сомонӣ", "доллар",
  "квадрат", "метри мураббаъ", "ҳуҷрагӣ", "хонафурӯшӣ", "агентство", "ширкат",
];

/**
 * Слова распознавания агента: сначала слова владельца из кабинета — все, как
 * есть (их не теряем и не режем), затем наши, без повторов, пока общее число не
 * дошло до предела.
 */
export function mergeAsrKeywords(owner: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const word = raw.trim();
    const key = word.toLowerCase();
    if (!word || seen.has(key)) return;
    seen.add(key);
    out.push(word);
  };
  for (const w of owner) add(w);
  for (const w of TAJIK_ASR_KEYWORDS) {
    if (out.length >= ASR_KEYWORDS_MAX) break;
    if (w.length <= ASR_KEYWORD_MAX_CHARS) add(w);
  }
  return out;
}

/** Правило словаря произношения. */
export interface TajikPronunciationRule {
  /** Слово, как его пишет модель (таджикскими буквами). */
  word: string;
  /** Произношение в IPA (ударение — знак ˈ перед слогом). */
  ipa: string;
  /**
   * Владелец послушал «до/после» и подтвердил. Только такие правила уходят в
   * агента: неверное IPA портит слово сильнее, чем его отсутствие (замер 11.11:
   * «Хуҷанд» с IPA распознался хуже, чем без него).
   */
  approved: boolean;
}

/**
 * Кандидаты словаря. Ударение — на последний слог, как в таджикском; «о» — [o]
 * (у русского голоса безударное «о» уходит в «а»: «Ошёнаи» распознано как
 * «Ашонаи»), «ӯ» — [ɵ], «қ» — [q], «ғ» — [ʁ], «ҷ» — [dʒ], «х» — [χ].
 * ОЦЕНКА: IPA составлено по правилам литературного произношения, носителем не
 * проверено. Пары «до/после» для прослушивания — в журнале правки.
 */
export const TAJIK_PRONUNCIATION_RULES: readonly TajikPronunciationRule[] = [
  { word: "Шоҳмансур", ipa: "ʃohmanˈsur", approved: false },
  { word: "Фирдавсӣ", ipa: "firdavˈsi", approved: false },
  { word: "Сомонӣ", ipa: "somoˈni", approved: false },
  { word: "Рӯдакӣ", ipa: "rɵdaˈki", approved: false },
  { word: "Ваҳдат", ipa: "vahˈdat", approved: false },
  { word: "Ҳисор", ipa: "hiˈsor", approved: false },
  { word: "Қазоқон", ipa: "qazoˈqon", approved: false },
  { word: "Хуҷанд", ipa: "χuˈdʒand", approved: false },
  { word: "Кӯлоб", ipa: "kɵˈlob", approved: false },
  { word: "Наврӯз", ipa: "navˈrɵz", approved: false },
  { word: "ҳуҷрагӣ", ipa: "hudʒraˈgi", approved: false },
  { word: "сеҳуҷрагӣ", ipa: "sehudʒraˈgi", approved: false },
  { word: "таваққуфгоҳ", ipa: "tavaqqufˈgoh", approved: false },
  { word: "ҳавлӣ", ipa: "havˈli", approved: false },
  { word: "масоҳаташ", ipa: "masohaˈtaʃ", approved: false },
  { word: "гӯед", ipa: "gɵˈjed", approved: false },
  { word: "Қарз", ipa: "qarz", approved: false },
  { word: "Ғарби", ipa: "ʁarˈbi", approved: false },
  { word: "ҳамкорам", ipa: "hamkoˈram", approved: false },
];

/** Буквы, которых нет в русском: по ним видно, что слово таджикское. */
export const TAJIK_ONLY_LETTERS = /[ҳӯӣқғҷҲӮӢҚҒҶ]/u;

/** Правила, которые уходят в агента: подтверждённые и только таджикские слова. */
export function approvedTajikPronunciationRules(
  rules: readonly TajikPronunciationRule[] = TAJIK_PRONUNCIATION_RULES
): TajikPronunciationRule[] {
  return rules.filter((r) => r.approved && TAJIK_ONLY_LETTERS.test(r.word) && r.ipa.trim().length > 0);
}

/** Начало имени наших словарей в аккаунте ElevenLabs: по нему старые версии
 *  отличаются от словарей владельца. */
export const TAJIK_DICTIONARY_NAME_PREFIX = "Royal Home CRM · tg";

/** Имя словаря с отпечатком содержимого: правка правил → новый словарь. */
export function tajikDictionaryName(rules: readonly TajikPronunciationRule[]): string {
  const payload = JSON.stringify(rules.map((r) => [r.word, r.ipa]));
  return `${TAJIK_DICTIONARY_NAME_PREFIX} · ${createHash("sha256").update(payload).digest("hex").slice(0, 8)}`;
}

/** Тело POST /v1/pronunciation-dictionaries/add-from-rules. */
export function tajikDictionaryRequest(rules: readonly TajikPronunciationRule[]): Record<string, unknown> {
  return {
    name: tajikDictionaryName(rules),
    description: "Таджикское произношение робота. Ведёт CRM (ai/tajikVoiceLexicon.ts), руками не править.",
    rules: rules.map((r) => ({
      type: "phoneme",
      string_to_replace: r.word,
      phoneme: r.ipa,
      alphabet: "ipa",
      case_sensitive: false,
      word_boundaries: true,
    })),
  };
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Тот же словарь файлом PLS (W3C Pronunciation Lexicon) — для загрузки в кабинет
 * вручную или для прослушивания в «Студии». В агента CRM кладёт правила через API,
 * файл — только запасной путь. По умолчанию — все кандидаты.
 */
export function buildTajikPronunciationPls(rules: readonly TajikPronunciationRule[] = TAJIK_PRONUNCIATION_RULES): string {
  const lexemes = rules
    .map((r) => `  <lexeme>\n    <grapheme>${xml(r.word)}</grapheme>\n    <phoneme>${xml(r.ipa)}</phoneme>\n  </lexeme>`)
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<lexicon version="1.0" xmlns="http://www.w3.org/2005/01/pronunciation-lexicon" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xsi:schemaLocation="http://www.w3.org/2005/01/pronunciation-lexicon http://www.w3.org/TR/2007/CR-pronunciation-lexicon-20071212/pls.xsd" ` +
    `alphabet="ipa" xml:lang="tg">\n${lexemes}\n</lexicon>\n`
  );
}
