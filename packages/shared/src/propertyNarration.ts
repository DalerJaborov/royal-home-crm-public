import { z } from "zod";
import { tajikCardinal, tajikOrdinal, tajikSpeechNumbers } from "./tajikSpeechNumbers.js";

/**
 * ОЗВУЧКА РОЛИКА ОБЪЕКТА — ОДИН ИСТОЧНИК ПРАВИЛ ТЕКСТА (11.11.2026).
 *
 * Мастер CRM (StepReview), мастер Шабнам (assistantPropertyDraft) и сервер
 * (автоозвучка после создания и после правки данных) собирают текст ОДНОЙ
 * функцией `narrationDraftText`. Сами шаблоны — текст владельца: живут в
 * Settings.propertyNarrationConfig.templates и правятся в Настройках; первый
 * набор положила миграция `narration_flow_11_11`, в коде их нет.
 *
 * ЦЕНУ ГОВОРИМ (решение владельца 11.11.2026: «Да, говорить цену»): слово `{цена}`
 * произносит цену словами с валютой карточки, без цены — «договорная». Поэтому
 * цена входит в факты озвучки: смена цены даёт новую версию и новое одобрение.
 */

export const NARRATION_LANGS = ["tg", "ru"] as const;
export type NarrationLang = (typeof NARRATION_LANGS)[number];

export const narrationTemplateSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9-]{1,40}$/, "Код шаблона: латиница, цифры и дефис"),
  name: z.string().trim().min(1).max(60),
  lang: z.enum(NARRATION_LANGS),
  text: z.string().trim().min(10).max(2000),
});
export type NarrationTemplate = z.infer<typeof narrationTemplateSchema>;

/**
 * НАСТРОЙКИ СИНТЕЗА (12.11.2026, задел под значения владельца после разбора документации v4).
 * Все поля необязательны: не задано — в запрос ElevenLabs не уходит ничего, звучит умолчание
 * сервиса. Голос может переопределить общий набор конфига по каждому полю отдельно.
 * Имена полей запроса — narrationTtsOptions ниже (одно место).
 */
export const narrationVoiceSettingsSchema = z.object({
  stability: z.number().min(0).max(1).optional(),
  similarityBoost: z.number().min(0).max(1).optional(),
  style: z.number().min(0).max(1).optional(),
  speed: z.number().min(0.5).max(1.5).optional(),
  useSpeakerBoost: z.boolean().optional(),
}).strict();
export type NarrationVoiceSettings = z.infer<typeof narrationVoiceSettingsSchema>;

export const narrationVoiceSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,100}$/),
  name: z.string().trim().min(1).max(80),
  gender: z.enum(["male", "female"]).optional(),
  /** Свой набор синтеза для этого голоса (поверх общего voiceSettings). */
  settings: narrationVoiceSettingsSchema.optional(),
});
/** Словарь произношения ElevenLabs (таджикские ударения): id и, по желанию, версия. */
export const narrationPronunciationDictionarySchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,100}$/),
  versionId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
}).strict();

const narrationConfigBase = z.object({
  ownerReportPreviewEnabled: z.boolean().optional(),
  modelId: z.string().trim().max(100).default(""),
  voices: z.array(narrationVoiceSchema).max(50).default([]),
  /** Рубильник: озвучка сама готовится после создания объекта и после правки его данных. */
  autoGenerate: z.boolean().optional(),
  /** Пауза после последней правки, прежде чем платить за новую озвучку. */
  debounceMinutes: z.number().int().min(0).max(120).optional(),
  /** Потолок расхода ElevenLabs за сутки по Душанбе: 0 — генерация остановлена. */
  dailyCharLimit: z.number().int().min(0).max(1_000_000).optional(),
  dailyGenerationLimit: z.number().int().min(0).max(1000).optional(),
  templates: z.array(narrationTemplateSchema).max(20).optional(),
  defaultTemplateId: z.string().trim().max(40).optional(),
  defaultVoiceId: z.string().trim().max(100).optional(),
  /** Рубильник: озвучку на ролик накладывает CRM — монтажёр присылает только ролик без голоса.
   *  С 12.11.2026 по умолчанию ВЫКЛЮЧЕН (решение владельца: «там же музыка есть и громкость»):
   *  монтажёр получает mp3 и вклеивает голос сам, а к готовому ролику присылает тот же ролик
   *  без голоса — из него CRM меняет голос при смене цены. true — прежний порядок 11.11. */
  mixByCrm: z.boolean().optional(),
  /** Рубильник (12.11.2026): озвучка к роликам, которые уже стоят в монтаже, на одобрение владельцу.
   *  По умолчанию ВЫКЛЮЧЕН и сам с автоозвучкой не включается (решение владельца — завтра). */
  backfillMontageQueue: z.boolean().optional(),
  /** Словарь произношения: «слово → как читать» (alias; phoneme — если модель его понимает). Правит
   *  владелец; синхронизация с ElevenLabs — только для моделей из NARRATION_PRONUNCIATION_MODELS. */
  pronunciationRules: z.array(z.object({
    word: z.string().trim().min(1).max(80),
    alias: z.string().trim().max(160).optional(),
    phoneme: z.string().trim().max(160).optional(),
    /** «Проверить носителем»: чтение собрано механически и на слух не проверено (видно в Настройках). */
    needsNative: z.boolean().optional(),
  }).strict()).max(300).optional(),
  /** Общий набор синтеза для всех голосов (12.11.2026). По умолчанию пусто. */
  voiceSettings: narrationVoiceSettingsSchema.optional(),
  /** language_code запроса синтеза по языку шаблона, например { tg: "tg" }. По умолчанию пусто. */
  languageCodes: z.object({ tg: z.string().trim().regex(/^[a-z]{2,3}$/).optional(), ru: z.string().trim().regex(/^[a-z]{2,3}$/).optional() }).strict().optional(),
  /** Словари произношения ElevenLabs (pronunciation_dictionary_locators), до трёх. По умолчанию пусто. */
  pronunciationDictionaries: z.array(narrationPronunciationDictionarySchema).max(3).optional(),
});
const uniqueVoices = (v: { voices: { id: string }[] }) => new Set(v.voices.map((voice) => voice.id)).size === v.voices.length;
const uniqueTemplates = (v: { templates?: { id: string }[] }) => !v.templates || new Set(v.templates.map((t) => t.id)).size === v.templates.length;
export const narrationConfigSchema = narrationConfigBase
  .refine(uniqueVoices, "Голоса не должны повторяться")
  .refine(uniqueTemplates, "Коды шаблонов не должны повторяться");
/** PUT настроек: поле, которого нет в запросе, остаётся прежним (старый экран не стирает шаблоны). */
export const narrationConfigPatchSchema = narrationConfigBase.partial();
export type NarrationConfig = z.infer<typeof narrationConfigSchema>;

/**
 * ДОБАВКИ К ЗАПРОСУ СИНТЕЗА ElevenLabs — ОДНО МЕСТО (12.11.2026): озвучка объекта и образцы голосов.
 * Имена полей запроса по документации POST /v1/text-to-speech/{voice_id}: voice_settings
 * (stability, similarity_boost, style, speed, use_speaker_boost), language_code,
 * pronunciation_dictionary_locators (pronunciation_dictionary_id, version_id) — сверить с
 * документацией v4 перед тем, как задавать значения. Пустой конфиг — пустой объект: запрос
 * остаётся прежним.
 */
/**
 * Модели, для которых словарь произношения ElevenLabs подтверждён: eleven_v4 — ФАКТ, проверено
 * на API 12.11.2026 (alias и IPA-phoneme подействовали). Других моделей здесь нет, пока не проверены.
 */
export const NARRATION_PRONUNCIATION_MODELS: readonly string[] = ["eleven_v4"];
/** У этих моделей GET /v1/models отдаёт can_use_style=false и can_use_speaker_boost=false
 *  (ФАКТ для eleven_v4, 12.11.2026; v4 Turbo — та же семья, не проверено): поля не отправляем. */
const NARRATION_MODELS_WITHOUT_STYLE: readonly string[] = ["eleven_v4", "eleven_v4_turbo"];
export function narrationPronunciationSupported(modelId: string | null | undefined): boolean {
  return !!modelId && NARRATION_PRONUNCIATION_MODELS.includes(modelId);
}

export function narrationTtsOptions(config: Pick<NarrationConfig, "voices" | "voiceSettings" | "languageCodes" | "pronunciationDictionaries"> & { modelId?: string }, voiceId: string, lang: NarrationLang | null | undefined): Record<string, unknown> {
  const merged: NarrationVoiceSettings = { ...(config.voiceSettings ?? {}), ...(config.voices.find((v) => v.id === voiceId)?.settings ?? {}) };
  const noStyle = NARRATION_MODELS_WITHOUT_STYLE.includes(config.modelId ?? "");
  const voiceSettings = Object.fromEntries(Object.entries({
    stability: merged.stability, similarity_boost: merged.similarityBoost, style: noStyle ? undefined : merged.style, speed: merged.speed,
    use_speaker_boost: noStyle ? undefined : merged.useSpeakerBoost,
  }).filter(([, v]) => v !== undefined));
  const out: Record<string, unknown> = {};
  if (Object.keys(voiceSettings).length) out.voice_settings = voiceSettings;
  // Язык текста — «tg» или «ru» по шаблону (ФАКТ 12.11.2026: v4 принимает оба); можно переопределить.
  const languageCode = lang ? config.languageCodes?.[lang] ?? lang : undefined;
  if (languageCode) out.language_code = languageCode;
  const dictionaries = narrationPronunciationSupported((config as { modelId?: string }).modelId) ? config.pronunciationDictionaries ?? [] : [];
  if (dictionaries.length) out.pronunciation_dictionary_locators = dictionaries.map((d) => ({ pronunciation_dictionary_id: d.id, ...(d.versionId ? { version_id: d.versionId } : {}) }));
  return out;
}

/** Первичный голос накладывает CRM, только если руководство включило это в настройках озвучки
 *  (12.11.2026: по умолчанию голос вклеивает монтажёр). */
export function narrationMixByCrm(config: Pick<NarrationConfig, "mixByCrm">): boolean {
  return config.mixByCrm === true;
}

/**
 * ФРАЗА ОБРАЗЦА ГОЛОСА (11.11.2026, владелец): агент слушает несколько голосов одной и той же
 * фразой и выбирает. Одна константа на язык шаблона; поменяли текст — образцы готовятся заново
 * (кэш по голосу, модели и тексту фразы), старые просто перестают отдаваться.
 */
export const NARRATION_VOICE_SAMPLE_TEXT: Record<NarrationLang, string> = {
  tg: "Ассалому алайкум! Хонаи се ҳуҷра дар ноҳияи Сино. Масоҳаташ ҳаштод метри мураббаъ, ошёнаи панҷум аз нӯҳ. Бо таъмир ва мебел. Наздик мактаб ва бозор ҳаст. Нархаш шаст ҳазор доллар. Фардо ҳам омада дидан мумкин аст. Нависед ё занг занед, хонаро ба шумо нишон медиҳем.",
  ru: "Здравствуйте! Трёхкомнатная квартира в Сино, восемьдесят квадратных метров, пятый этаж из девяти. Ремонт сделан, мебель остаётся. Рядом школа и рынок. Цена шестьдесят тысяч долларов. Посмотреть можно хоть завтра. Пишите или звоните, мы вам всё покажем.",
};
/** Образец, который можно прослушать: голос и язык фразы. */
export type NarrationVoiceSampleRef = { voiceId: string; lang: NarrationLang };

/** Умолчания чисел — не текст владельца, а осторожные пределы до первой настройки. */
/**
 * Модели ElevenLabs с таджикским (tg) — ФАКТ по elevenlabs.io/docs/overview/models и API, 11.11.2026.
 * У eleven_multilingual_v2 и eleven_flash_v2_5 таджикского нет: таджикский шаблон с ними не сохраняется.
 */
export const NARRATION_TAJIK_MODELS = [
  { id: "eleven_v4", label: "Eleven v4: лучше звучит, 0,08 $ за 1000 знаков" },
  { id: "eleven_v4_turbo", label: "Eleven v4 Turbo: быстрее и вдвое дешевле, 0,04 $ за 1000 знаков" },
] as const;
export function narrationModelSupportsTajik(modelId: string | null | undefined): boolean {
  return NARRATION_TAJIK_MODELS.some((m) => m.id === modelId);
}
/** Таджикский шаблон и модель без таджикского не сочетаются. */
export function narrationModelError(config: Pick<NarrationConfig, "modelId" | "templates">): string | null {
  if (!config.modelId || narrationModelSupportsTajik(config.modelId)) return null;
  if (!(config.templates ?? []).some((t) => t.lang === "tg")) return null;
  return `Модель ${config.modelId} не знает таджикского. Выберите ${NARRATION_TAJIK_MODELS.map((m) => m.id).join(" или ")}.`;
}

export const NARRATION_LIMIT_DEFAULTS = { debounceMinutes: 3, dailyCharLimit: 20_000, dailyGenerationLimit: 40 } as const;
export function narrationLimits(config: Pick<NarrationConfig, "debounceMinutes" | "dailyCharLimit" | "dailyGenerationLimit">) {
  return {
    debounceMs: (config.debounceMinutes ?? NARRATION_LIMIT_DEFAULTS.debounceMinutes) * 60_000,
    dailyChars: config.dailyCharLimit ?? NARRATION_LIMIT_DEFAULTS.dailyCharLimit,
    dailyGenerations: config.dailyGenerationLimit ?? NARRATION_LIMIT_DEFAULTS.dailyGenerationLimit,
  };
}

export type NarrationFacts = {
  type: string; rooms: number | null; areaSqm: string; floor: number | null; totalFloors: number | null; district: string | null;
  /** Цена как хранится в карточке (строка десятичного числа) и её валюта: TJS или USD. */
  price?: string | null; currency?: string | null;
};

/** Прежний текст по фактам — остаётся, пока владелец не завёл ни одного шаблона. */
export function suggestedNarration(facts: NarrationFacts): string {
  const types: Record<string, string> = { APARTMENT: "Квартира", HOUSE: "Дом", LAND: "Участок", COMMERCIAL: "Коммерческое помещение" };
  return [types[facts.type] ?? "Объект недвижимости", facts.rooms ? `${facts.rooms} комнат.` : "", `Площадь ${facts.areaSqm} квадратных метров.`,
    facts.floor ? `Этаж ${facts.floor}${facts.totalFloors ? ` из ${facts.totalFloors}` : ""}.` : "",
    facts.district ? `Район: ${facts.district}.` : "",
    "Цена и номер телефона указаны в описании под видео. Поделитесь этим видео с теми, кто ищет недвижимость.",
  ].filter(Boolean).join(" ");
}

/** Слова, которые владелец может ставить в шаблон; квадратные скобки — «если есть». */
export const NARRATION_PLACEHOLDERS = ["вид", "комнаты", "площадь", "этаж", "этаж_пор", "этажей", "район", "цена"] as const;

/** Русское «доллар / доллара / долларов» по числу. */
function rubPlural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
/** Цена для озвучки: словами по-таджикски, цифрами по-русски, валюта из карточки; нет цены — «договорная». */
export function narrationPriceWords(price: string | null | undefined, currency: string | null | undefined, lang: NarrationLang): string {
  const value = Math.round(Number(price));
  if (!price || !Number.isFinite(value) || value <= 0) return lang === "tg" ? "бо мувофиқа" : "договорная";
  const usd = currency === "USD";
  if (lang === "tg") return `${tajikCardinal(value)} ${usd ? "доллар" : "сомонӣ"}`;
  return `${value} ${usd ? rubPlural(value, "доллар", "доллара", "долларов") : "сомони"}`;
}
const TYPE_WORDS: Record<NarrationLang, Record<string, string>> = {
  tg: { APARTMENT: "квартира", HOUSE: "ҳавлӣ", LAND: "замин", COMMERCIAL: "ҷои тиҷоратӣ" },
  ru: { APARTMENT: "квартира", HOUSE: "дом", LAND: "участок", COMMERCIAL: "коммерческое помещение" },
};

function spokenNumber(value: number | null, lang: NarrationLang, ordinal = false): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return "";
  const whole = Math.round(value);
  if (lang === "ru") return String(whole);
  return ordinal ? tajikOrdinal(whole) : tajikCardinal(whole);
}

function placeholderValues(facts: NarrationFacts, lang: NarrationLang): Record<string, string> {
  const area = Number(facts.areaSqm);
  return {
    вид: TYPE_WORDS[lang][facts.type] ?? (lang === "tg" ? "объект" : "объект"),
    комнаты: spokenNumber(facts.rooms, lang),
    площадь: spokenNumber(Number.isFinite(area) ? area : null, lang),
    этаж: spokenNumber(facts.floor, lang),
    этаж_пор: spokenNumber(facts.floor, lang, true),
    этажей: spokenNumber(facts.totalFloors, lang),
    район: facts.district?.trim() ?? "",
    // Цена есть всегда: без неё — «договорная», поэтому фрагмент с {цена} не выпадает.
    цена: narrationPriceWords(facts.price, facts.currency, lang),
  };
}

/** Неизвестные слова в фигурных скобках и непарные скобки — ошибка шаблона. */
export function narrationTemplateError(text: string): string | null {
  for (const match of text.matchAll(/\{([^{}]*)\}/gu)) {
    if (!(NARRATION_PLACEHOLDERS as readonly string[]).includes(match[1])) return `Неизвестное слово {${match[1]}}. Можно: ${NARRATION_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}`;
  }
  let depth = 0;
  for (const ch of text) {
    if (ch === "[") depth++;
    if (ch === "]" && --depth < 0) return "Лишняя закрывающая скобка ]";
  }
  if (depth !== 0) return "Не закрыта квадратная скобка [";
  if (/[—–]/u.test(text)) return "Уберите длинное тире: в тексте для клиентов его не пишем";
  return null;
}

/**
 * Тег голоса v4 вроде «[excited]» (12.11.2026): латиница в квадратных скобках остаётся в тексте
 * как есть, а не считается фрагментом «если есть». В стартовые шаблоны теги не ставим — в
 * таджикском не проверены; владелец может вписать сам.
 */
const VOICE_TAG = /^\[[a-z][a-z ]{0,30}\]/u;
export function isNarrationVoiceTagAt(text: string, index: number): number {
  const m = VOICE_TAG.exec(text.slice(index, index + 34));
  return m ? m[0].length : 0;
}

/** Фрагмент `[ ... ]` выпадает целиком, если в нём есть пустое слово. Скобки вкладываются. */
function renderSegment(text: string, values: Record<string, string>): { out: string; missing: boolean } {
  let out = "", missing = false, i = 0;
  while (i < text.length) {
    const ch = text[i];
    const tag = ch === "[" ? isNarrationVoiceTagAt(text, i) : 0;
    if (tag) { out += text.slice(i, i + tag); i += tag; continue; }
    if (ch === "[") {
      let depth = 1, j = i + 1;
      while (j < text.length && depth) { if (text[j] === "[") depth++; else if (text[j] === "]") depth--; j++; }
      const inner = renderSegment(text.slice(i + 1, j - 1), values);
      if (!inner.missing) out += inner.out;
      i = j;
      continue;
    }
    if (ch === "{") {
      const end = text.indexOf("}", i);
      const value = values[text.slice(i + 1, end)] ?? "";
      if (!value) missing = true;
      out += value;
      i = end + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return { out, missing };
}

export function renderNarrationTemplate(template: Pick<NarrationTemplate, "text" | "lang">, facts: NarrationFacts): string {
  const { out } = renderSegment(template.text, placeholderValues(facts, template.lang));
  return out
    .replace(/[ \t]+/gu, " ")
    .replace(/ +([.,!?])/gu, "$1")
    .replace(/([.,!?])(?=[\p{L}])/gu, "$1 ")
    .replace(/(^|[.!?]\s+)(\p{Ll})/gu, (_m, lead: string, letter: string) => lead + letter.toLocaleUpperCase("ru"))
    .trim();
}

/** Шаблон по коду, иначе выбранный владельцем по умолчанию, иначе первый таджикский. */
export function pickNarrationTemplate(config: Pick<NarrationConfig, "templates" | "defaultTemplateId">, templateId?: string | null): NarrationTemplate | null {
  const templates = config.templates ?? [];
  return templates.find((t) => t.id === templateId)
    ?? templates.find((t) => t.id === config.defaultTemplateId)
    ?? templates.find((t) => t.lang === "tg")
    ?? templates[0]
    ?? null;
}

/** ЕДИНАЯ точка: текст озвучки из данных объекта для мастера CRM, Шабнам и сервера. */
export function narrationDraftText(config: Pick<NarrationConfig, "templates" | "defaultTemplateId">, facts: NarrationFacts, templateId?: string | null): { text: string; templateId: string | null; lang: NarrationLang } {
  const template = pickNarrationTemplate(config, templateId);
  if (!template) return { text: suggestedNarration(facts), templateId: null, lang: "ru" };
  return { text: renderNarrationTemplate(template, facts), templateId: template.id, lang: template.lang };
}

/** Языки, на которых у владельца есть хотя бы один шаблон, в постоянном порядке (сначала таджикский). */
export function narrationTemplateLangs(templates: readonly Pick<NarrationTemplate, "lang">[]): NarrationLang[] {
  return NARRATION_LANGS.filter((lang) => templates.some((t) => t.lang === lang));
}

/**
 * ВАРИАНТЫ ТЕКСТА ПО КРУГУ (14.11.2026, владелец: «несколько шаблонов, чтобы не каждый раз одинаковые»).
 * Следующий шаблон того же языка после `afterId` (прошлый выбор сотрудника). Нет прошлого или он
 * другого языка — первый шаблон языка. Один шаблон на язык — он же.
 */
export function nextNarrationTemplateId(templates: readonly Pick<NarrationTemplate, "id" | "lang">[], lang: NarrationLang, afterId?: string | null): string | null {
  const same = templates.filter((t) => t.lang === lang);
  if (!same.length) return null;
  const at = same.findIndex((t) => t.id === afterId);
  return same[(at + 1) % same.length].id;
}

/**
 * Шаблон нового объекта, если сотрудник его не выбирал: следующий вариант после его прошлого,
 * на том же языке. Мастер CRM показывает ровно его, сервер (мастер CRM и Шабнам) ставит его же.
 * Прошлого выбора нет — null, дальше работает обычный pickNarrationTemplate (умолчание владельца).
 */
export function narrationRotatedTemplateId(templates: readonly Pick<NarrationTemplate, "id" | "lang">[], lastTemplateId?: string | null): string | null {
  const last = templates.find((t) => t.id === lastTemplateId);
  return last ? nextNarrationTemplateId(templates, last.lang, last.id) : null;
}

/** Голос по умолчанию: выбранный владельцем, иначе первый в списке. */
export function pickNarrationVoice(config: Pick<NarrationConfig, "voices" | "defaultVoiceId">, voiceId?: string | null): string | null {
  return config.voices.find((v) => v.id === voiceId)?.id ?? config.voices.find((v) => v.id === config.defaultVoiceId)?.id ?? config.voices[0]?.id ?? null;
}

/**
 * Что уходит в ElevenLabs: таджикские цифры (агент мог вписать «3 ҳуҷра»)
 * превращаются в слова тем же модулем, что и голос Шабнам. Не получилось
 * (дата, дробь) — текст остаётся как есть, агент услышит и поправит.
 */
export function narrationSpeechText(script: string, lang: NarrationLang | null | undefined): string {
  if (lang !== "tg") return script;
  return tajikSpeechNumbers(script) ?? script;
}

export const narrationDraftSchema = z.object({
  expectedRevision: z.number().int().min(0), requestKey: z.string().uuid(),
  script: z.string().trim().min(10).max(5000).optional(),
  voiceId: z.string().trim().max(100).optional(),
  templateId: z.string().trim().max(40).optional(),
  /** Агент правит текст или голос и сразу просит новое аудио (только при включённой автоозвучке). */
  generate: z.boolean().optional(),
});
/** Выбор агента в конце мастера (CRM и Шабнам): одно поле запроса создания объекта. */
export const narrationWizardChoiceSchema = z.object({
  /** «Без озвучки» (12.11.2026): ничего не генерируется и не тратится, монтажёру пометка. */
  none: z.literal(true).optional(),
  script: z.string().trim().min(10).max(5000).optional(),
  templateId: z.string().trim().max(40).optional(),
  voiceId: z.string().trim().max(100).optional(),
});
export type NarrationWizardChoice = z.infer<typeof narrationWizardChoiceSchema>;
/** Карточка объекта: «Без озвучки» / «Включить озвучку». */
export const narrationModeSchema = z.object({ off: z.boolean() }).strict();
export const narrationActionSchema = z.object({ expectedRevision: z.number().int().positive(), confirmed: z.literal(true) });
export const narrationHandoffSchema = narrationActionSchema.extend({
  audioReviewed: z.literal(true),
  requestKey: z.string().uuid(), mode: z.enum(["AUDIO_ONLY", "WITH_SOURCES"]), editorId: z.string().uuid().optional(),
});
export type PropertyNarrationItem = {
  id: string; revision: number; script: string; voiceId: string | null; status: string;
  approvedAt: string | null; stale: boolean; hasAudio: boolean; errorCode: string | null; createdAt: string;
  canReconcile?: boolean;
  source?: string; templateId?: string | null; language?: string | null; generateAfter?: string | null;
};
/** Что видит мастер: шаблоны и голоса без ключей и моделей. */
export type NarrationOptionsView = {
  templates: NarrationTemplate[]; voices: Array<{ id: string; name: string; gender?: "male" | "female" }>;
  defaultTemplateId: string | null; defaultVoiceId: string | null; autoGenerate: boolean;
  /** Что этот сотрудник выбрал в прошлый раз (если голос и шаблон ещё в настройках). */
  lastChoice?: { voiceId?: string; templateId?: string };
  /** Готовые образцы голосов (кнопка «▶ Прослушать»). */
  samples?: NarrationVoiceSampleRef[];
};
export type PropertyNarrationView = {
  versions: PropertyNarrationItem[]; suggestedScript: string; config: NarrationConfig;
  /** Данные объекта для шаблона текста (14.11.2026: карточка собирает текст той же функцией, что мастер). */
  facts?: NarrationFacts;
  /** У объекта выбрано «Без озвучки» (12.11.2026). */
  off?: boolean;
  lastChoice?: { voiceId?: string; templateId?: string };
  configured: boolean; canApprove: boolean; canConfigure?: boolean; canDraft?: boolean; sendsEnabled: boolean;
  /** Агент объекта одобряет готовое аудио (автоозвучка), маркетинг — по-прежнему черновой текст. */
  canApproveAudio?: boolean; autoGenerate?: boolean;
  budget?: { usedChars: number; usedGenerations: number; dailyChars: number; dailyGenerations: number };
  /** Последняя генерация упала на «кредиты ElevenLabs закончились» (видно руководству). */
  quotaExceeded?: boolean;
  deliveries?: Array<{ id: string; status: string; mode: string; versionId: string; createdAt: string; lastError: string | null; planHash: string | null }>;
  ownerReportsEnabled?: boolean;
  ownerReport?: { active: boolean; revision: number; executionMode: string; deliveries: Array<{ id: string; status: string; period: string; lastError: string | null }> };
  readiness?: { voiceCount: number; modelConfigured: boolean; apiKeyConfigured: boolean };
  samples?: NarrationVoiceSampleRef[];
  /** Озвучку на этот ролик накладывает CRM (есть ролик без голоса от монтажёра); ошибка наложения — для руководства. */
  /** problem (14.11.2026): последняя озвучка не легла на вышедший ролик — VOICE_LONGER (ушла монтажёру удлинить ролик) или FAILED. */
  mix?: { hasMaster: boolean; error: string | null; problem?: "VOICE_LONGER" | "FAILED" | null };
};
/** Настройки CRM → «Озвучка роликов» (14.11.2026): вся техника, которую агент в карточке не видит. */
export type NarrationSettingsView = {
  config: NarrationConfig; apiKeyConfigured: boolean; sendsEnabled: boolean; quotaExceeded: boolean;
  canConfigure: boolean; configured: boolean; autoGenerate: boolean; samplesReady: number;
  budget: { usedChars: number; usedGenerations: number; dailyChars: number; dailyGenerations: number };
};
