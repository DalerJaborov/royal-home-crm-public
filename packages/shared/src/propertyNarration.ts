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
 * Цена в озвучке не произносится намеренно (`narrationScriptError`): цена
 * живёт в описании под видео и меняется там сама, а смена цены не тянет за
 * собой ни новую озвучку, ни перемонтаж.
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

export const narrationVoiceSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,100}$/),
  name: z.string().trim().min(1).max(80),
  gender: z.enum(["male", "female"]).optional(),
});

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
});
const uniqueVoices = (v: { voices: { id: string }[] }) => new Set(v.voices.map((voice) => voice.id)).size === v.voices.length;
const uniqueTemplates = (v: { templates?: { id: string }[] }) => !v.templates || new Set(v.templates.map((t) => t.id)).size === v.templates.length;
export const narrationConfigSchema = narrationConfigBase
  .refine(uniqueVoices, "Голоса не должны повторяться")
  .refine(uniqueTemplates, "Коды шаблонов не должны повторяться");
/** PUT настроек: поле, которого нет в запросе, остаётся прежним (старый экран не стирает шаблоны). */
export const narrationConfigPatchSchema = narrationConfigBase.partial();
export type NarrationConfig = z.infer<typeof narrationConfigSchema>;

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

export type NarrationFacts = { type: string; rooms: number | null; areaSqm: string; floor: number | null; totalFloors: number | null; district: string | null };

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
export const NARRATION_PLACEHOLDERS = ["вид", "комнаты", "площадь", "этаж", "этаж_пор", "этажей", "район"] as const;
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

/** Фрагмент `[ ... ]` выпадает целиком, если в нём есть пустое слово. Скобки вкладываются. */
function renderSegment(text: string, values: Record<string, string>): { out: string; missing: boolean } {
  let out = "", missing = false, i = 0;
  while (i < text.length) {
    const ch = text[i];
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
  script: z.string().trim().min(10).max(5000).optional(),
  templateId: z.string().trim().max(40).optional(),
  voiceId: z.string().trim().max(100).optional(),
});
export type NarrationWizardChoice = z.infer<typeof narrationWizardChoiceSchema>;
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
};
export type PropertyNarrationView = {
  versions: PropertyNarrationItem[]; suggestedScript: string; config: NarrationConfig;
  configured: boolean; canApprove: boolean; canConfigure?: boolean; canDraft?: boolean; sendsEnabled: boolean;
  /** Агент объекта одобряет готовое аудио (автоозвучка), маркетинг — по-прежнему черновой текст. */
  canApproveAudio?: boolean; autoGenerate?: boolean;
  budget?: { usedChars: number; usedGenerations: number; dailyChars: number; dailyGenerations: number };
  deliveries?: Array<{ id: string; status: string; mode: string; versionId: string; createdAt: string; lastError: string | null; planHash: string | null }>;
  ownerReportsEnabled?: boolean;
  ownerReport?: { active: boolean; revision: number; executionMode: string; deliveries: Array<{ id: string; status: string; period: string; lastError: string | null }> };
  readiness?: { voiceCount: number; modelConfigured: boolean; apiKeyConfigured: boolean };
};
