import sharp from "sharp";
import { z } from "zod";
import {
  SOCIAL_VIDEO_CAPTION_TONE_LABELS,
  SOCIAL_VIDEO_CAPTION_VARIANTS,
  SOCIAL_VIDEO_COVER_PROVIDER_LABELS,
  SOCIAL_VIDEO_DEFAULT_COVER_PROVIDER,
  SOCIAL_VIDEO_LIMITS,
  type SocialVideoAiCaptionRequest,
  type SocialVideoAiProviderInfo,
  type SocialVideoCaptionLanguage,
  type SocialVideoCaptionTone,
  type SocialVideoChannel,
  type SocialVideoCoverProvider,
  type SocialVideoTrends,
} from "@royal-home/shared";
import { callGemini } from "../ai/geminiClient.js";
import { resolveGeminiRuntime } from "../ai/geminiSettings.js";
import { geminiGenerateUrlFor, geminiProxyHeaders } from "../ai/geminiTransport.js";
import { emptyUsage, logAiCall } from "../ai/shared.js";
import { moveTrailingEmojiToStart } from "../ai/reelsCaptionAi.js";
import { stripDashes } from "../ai/seoGenerator.js";
import {
  OPENAI_IMAGE_TIMEOUT_MS,
  OPENAI_OUT_OF_MONEY_CODE,
  OpenAiError,
  estimateImageCostUsd,
  imageCostFromUsage,
  logOpenAiCall,
  openAiPost,
  resolveOpenAiKey,
  type ImageUsage,
} from "../ai/openaiClient.js";
import { coverImageSize, loadCoverRuntimeSettings } from "./video/coverOpenAi.js";
import { buildContactFooter } from "./reelsCaptionTemplate.js";
import { logSystemError } from "./systemError.js";

/**
 * ИИ ДЛЯ «СВОБОДНЫХ РОЛИКОВ» (12.10.2026): подписи по двум строкам brief и обложка.
 *
 * ПРОМТ — ПРОСЬБА, А НЕ ГАРАНТИЯ. Модель возвращает структуру (крючок, строки,
 * призыв, хештеги), а подпись СОБИРАЕМ мы: контакты агентства дописываются кодом
 * из той же константы, что и под постами объектов (reelsCaptionTemplate.ts), и ни
 * номера, ни ссылки, ни цифры, которых не было в описании ролика, до человека
 * не доходят — строка с ними выбрасывается. Тот же приём, что у подписей к Reels
 * объектов (ai/reelsCaptionAi.ts): модели физически нечем «договориться» с
 * реальностью, когда факты проверяет код, а не она сама.
 *
 * Любой отказ превращается в `SocialVideoAiError` с русским текстом — его
 * показывают на экране как есть, поэтому внутренних деталей в нём нет.
 */

/** Человеческая ошибка ИИ: сообщение безопасно показывать на экране как есть. */
export class SocialVideoAiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocialVideoAiError";
  }
}

/** Сколько ждём ответ модели. Внутри callGemini свои повторы по 30 с — этот потолок
 *  нужен, чтобы экран не висел минутами, пока перебираются модели и ключи. */
const AI_TIMEOUT_MS = 30_000;
/** Подпись, которая годится везде, если ни одна выбранная сеть не задаёт своего предела. */
const UNIVERSAL_CAPTION_LIMIT = 1000;
/** Первая строка на YouTube становится заголовком, а он не длиннее 100 символов. */
const TITLE_MAX_CHARS = 100;
const MAX_HASHTAGS = 8;
/** Хештеги агентства — всегда в конце, как под постами объектов (buildReelsHashtags). */
const MANDATORY_HASHTAGS = ["#Душанбе", "#RoyalHome"] as const;
/** Запас под хештеги в бюджете текста, который просим у модели, символов. */
const HASHTAGS_RESERVE_CHARS = 80;
/** Шапка контактов для чисто таджикской подписи: русская шапка под таджикским текстом режет глаз. Номер под ней тот же. */
const TG_CONTACT_HEAD = "📲 Занг занед ё дар директ нависед:";

// ───────────────────────────── подписи ─────────────────────────────

/**
 * Предел длины подписи под выбранные сети: самый короткий из заданных (Threads 500,
 * Telegram 1024), иначе универсальные 1000. Сети без предела (YouTube, TikTok) его не
 * задают — писать им «роман» незачем, это подпись под видео.
 */
export function effectiveCaptionLimit(channels: readonly SocialVideoChannel[]): number {
  const limits = channels
    .map((channel) => SOCIAL_VIDEO_LIMITS[channel].maxCaptionChars)
    .filter((n): n is number => n !== null);
  return Math.min(UNIVERSAL_CAPTION_LIMIT, ...limits);
}

/** Обрезка по границе слова — не посреди слова и не посреди суррогатной пары эмодзи. */
function clipAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > max * 0.5) cut = cut.slice(0, lastSpace);
  return cut.replace(/[\s,.:;!?\-]+$/u, "");
}

/**
 * Укорачивает готовую подпись под предел сети ЦЕЛЫМИ СТРОКАМИ С КОНЦА: первая строка
 * (крючок, на YouTube — заголовок) остаётся всегда. Режет не посреди фразы, поэтому
 * лучше потерять хвост с хештегами, чем получить оборванное предложение. Если не
 * помещается даже одна первая строка — режем её по слову.
 */
export function fitCaptionToLimit(caption: string, limit: number): string {
  if (caption.length <= limit) return caption;
  const lines = caption.split("\n");
  while (lines.length > 1 && lines.join("\n").length > limit) lines.pop();
  const kept = lines.join("\n").trimEnd();
  return kept.length <= limit ? kept : clipAtWord(kept, limit);
}

/**
 * ПРОВЕРКА ФАКТОВ СТРОКИ. В подписи допустимы только цифры и ссылки, которые человек сам
 * написал в описании ролика: цена, телефон, адрес, сайт — всё, чего там нет, модель
 * выдумала. Годы текущего десятилетия пропускаем: «в 2026 году» — не факт об агентстве.
 */
function makeFactGuard(source: string): (line: string) => boolean {
  // «650 000», «650,000» и «650000» — одно число: склеиваем разделители между цифрами.
  const compact = (s: string): string => s.replace(/(?<=\d)[\s.,](?=\d)/g, "");
  const sourceCompact = compact(source);
  const sourceLower = source.toLowerCase();
  const REF_RE = /https?:\/\/\S+|www\.\S+|t\.me\/\S+|@[\p{L}\p{N}_.]{3,}|[\p{L}\p{N}-]+\.(?:com|tj|ru|org|net|info)\b/giu;
  return (line) => {
    for (const run of compact(line).match(/\d{3,}/g) ?? []) {
      if (/^20(2[4-9]|30)$/.test(run)) continue;
      if (!sourceCompact.includes(run)) return false;
    }
    for (const ref of line.match(REF_RE) ?? []) {
      if (!sourceLower.includes(ref.toLowerCase())) return false;
    }
    return true;
  };
}

/** Строка как её увидит человек: без markdown-звёздочек, длинных тире и с эмодзи в начале (решения владельца 20.09.2026). */
function cleanLine(line: string): string {
  return moveTrailingEmojiToStart(stripDashes(line.replace(/\*+/g, "").replace(/^[\s•\-–—]+/u, "")).trim()).trim();
}

/** Поле ответа модели (строка или массив строк) → непустые чистые строки. */
function toLines(value: string | string[] | null | undefined): string[] {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : value.split("\n");
  return raw.flatMap((item) => item.split("\n")).map(cleanLine).filter(Boolean);
}

/** Хештеги: только буквы/цифры/«_», без повторов, затем теги агентства; всего не больше MAX_HASHTAGS. */
function normalizeHashtags(value: string | string[] | null | undefined, isSafe: (line: string) => boolean): string[] {
  const tokens = (Array.isArray(value) ? value : [value ?? ""]).flatMap((item) => item.split(/[\s,]+/));
  const mandatory = new Set(MANDATORY_HASHTAGS.map((tag) => tag.toLowerCase()));
  const seen = new Set<string>();
  const own: string[] = [];
  for (const token of tokens) {
    const word = token.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
    if (!word) continue;
    const tag = `#${word}`;
    const key = tag.toLowerCase();
    if (seen.has(key) || mandatory.has(key) || !isSafe(tag)) continue;
    seen.add(key);
    own.push(tag);
  }
  return [...own.slice(0, MAX_HASHTAGS - MANDATORY_HASHTAGS.length), ...MANDATORY_HASHTAGS];
}

const nullableText = z.string().nullish();
const nullableLines = z.union([z.array(z.string()), z.string()]).nullish();

/** Один вариант в ответе модели. Поля с суффиксом Tg заполняются только в режиме «русский + тоҷикӣ». */
const variantSchema = z.object({
  hook: z.string(),
  body: nullableLines,
  cta: nullableText,
  hookTg: nullableText,
  bodyTg: nullableLines,
  ctaTg: nullableText,
  hashtags: nullableLines,
});
type RawVariant = z.infer<typeof variantSchema>;

const responseSchema = z.object({ variants: z.array(z.unknown()) });

/** Блок «крючок, строки, призыв» с пустой строкой между частями. */
function textBlock(hook: string, body: string[], cta: string[]): string[] {
  const lines = [hook];
  if (body.length > 0) lines.push("", ...body);
  if (cta.length > 0) lines.push("", ...cta);
  return lines;
}

/** Контактный подвал агентства: русская шапка, на таджикском тексте — таджикская; номер один и тот же. */
function contactFooterLines(language: SocialVideoCaptionLanguage): string[] {
  const [head, ...rest] = buildContactFooter(null).split("\n");
  return [language === "TG" ? TG_CONTACT_HEAD : (head ?? ""), ...rest];
}

/**
 * Один сырой вариант → готовая подпись или null (вариант не годится: нет крючка или
 * крючок содержит выдуманный факт). Строки тела и призыва с выдуманным фактом просто
 * выбрасываются — остальная подпись остаётся.
 */
function assembleCaption(raw: RawVariant, language: SocialVideoCaptionLanguage, isSafe: (line: string) => boolean): string | null {
  const safe = (lines: string[]): string[] => lines.filter(isSafe);
  const hook = clipAtWord(cleanLine(raw.hook), TITLE_MAX_CHARS);
  if (!hook || !isSafe(hook)) return null;

  const lines = textBlock(hook, safe(toLines(raw.body)), safe(toLines(raw.cta)));

  if (language === "RU_TG") {
    const hookTg = cleanLine(raw.hookTg ?? "");
    // Без таджикской половины это уже не двуязычная подпись — не выдаём её за такую.
    if (!hookTg || !isSafe(hookTg)) return null;
    lines.push("", ...textBlock(hookTg, safe(toLines(raw.bodyTg)), safe(toLines(raw.ctaTg))));
  }

  lines.push("", ...contactFooterLines(language));
  const tags = normalizeHashtags(raw.hashtags, isSafe);
  lines.push("", tags.join(" "));
  return lines.join("\n");
}

/** Ключ для сравнения заходов: первая строка без регистра, знаков и эмодзи. */
function hookKey(caption: string): string {
  return (caption.split("\n")[0] ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

const TONE_HINTS: Record<SocialVideoCaptionTone, string> = {
  SELLING: "энергично, выгода и ценность в первой строке, чёткий призыв, лёгкая срочность без давления",
  FRIENDLY: "тепло и по-человечески, как совет знакомого, на «вы», без нажима и канцелярита",
  PREMIUM: "сдержанно и статусно, короткие уверенные фразы, без восклицательных знаков и слов «выгодно», «супер», «акция»",
  SHORT: "очень коротко: яркий крючок и 1-2 короткие строки, 1-2 эмодзи, без воды",
};

const LANGUAGE_HINTS: Record<SocialVideoCaptionLanguage, string> = {
  RU: "Язык: русский, грамотный и живой.",
  TG:
    "Язык: таджикский, кириллицей, литературный (правильно используй ғ, ӣ, қ, ӯ, ҳ, ҷ). " +
    "Не пиши русский текст с таджикскими окончаниями. Поля hook, body, cta — на таджикском.",
  RU_TG:
    "Языки: русский И таджикский (кириллицей, литературный: ғ, ӣ, қ, ӯ, ҳ, ҷ). Поля hook, body, cta — на русском; " +
    "hookTg, bodyTg, ctaTg — тот же смысл на таджикском, а не дословный перевод.",
};

function buildSystemPrompt(): string {
  return [
    "Ты копирайтер и SMM-маркетолог агентства недвижимости Royal Home в Душанбе (Таджикистан).",
    "Пишешь подписи под промо-роликами агентства для Instagram, Facebook, YouTube, TikTok, Telegram и Threads.",
    "Аудитория: русско- и таджикоязычные жители Душанбе и Таджикистана.",
    "",
    "Каждый вариант состоит из: hook (цепляющая первая строка, не длиннее 100 символов, на YouTube она станет",
    "заголовком), body (2-4 КОРОТКИЕ строки по сути ролика), cta (одна строка с призывом написать или позвонить",
    "БЕЗ номера телефона: контакты система допишет сама), hashtags (5-8 тематических хештегов).",
    "",
    "ФАКТЫ. Используй ТОЛЬКО то, что есть в описании ролика. Не придумывай цены, адреса, районы, площади,",
    "сроки, акции, скидки, телефоны, ссылки, сайты, имена и прочие факты. Если фактов мало, пиши об агентстве",
    "и теме ролика общими словами без цифр.",
    "",
    "СТИЛЬ. Никогда не используй длинное (—) и среднее (–) тире: запятая, точка или двоеточие. Эмодзи только в",
    "НАЧАЛЕ строки, не больше одного на строку. Не начинай hook с вопроса. Запрещены штампы: «уютное гнёздышко»,",
    "«не упустите шанс», «мечта каждого», «ждёт своего хозяина», «добро пожаловать в», «не просто квартира, а образ жизни».",
    "",
    `Дай РОВНО ${SOCIAL_VIDEO_CAPTION_VARIANTS} варианта, заметно разных по заходу: разные ракурсы, разные первые строки,`,
    "разная структура. Ответ только JSON по схеме.",
  ].join("\n");
}

/** Сколько символов текста (крючок, строки, призыв) просим у модели: остальное съедают контакты и хештеги. */
function textBudget(limit: number, language: SocialVideoCaptionLanguage): number {
  const footer = contactFooterLines(language).join("\n").length;
  return Math.max(120, limit - footer - HASHTAGS_RESERVE_CHARS);
}

function buildUserPrompt(input: SocialVideoAiCaptionRequest): string {
  const limit = effectiveCaptionLimit(input.channels);
  const budget = textBudget(limit, input.language);
  const lines = [
    `О чём ролик (со слов владельца): ${input.brief}`,
    input.title ? `Название ролика: ${input.title}` : null,
    `Тон: ${SOCIAL_VIDEO_CAPTION_TONE_LABELS[input.tone]}: ${TONE_HINTS[input.tone]}.`,
    LANGUAGE_HINTS[input.language],
    input.channels.length > 0
      ? `Подпись уйдёт в: ${input.channels.join(", ")}. Вся подпись вместе с контактами и хештегами не длиннее ${limit} символов.`
      : `Подпись универсальная, вся не длиннее ${limit} символов вместе с контактами и хештегами.`,
    input.language === "RU_TG"
      ? `Текст hook+body+cta вместе на обоих языках не длиннее ${budget} символов.`
      : `Текст hook+body+cta не длиннее ${budget} символов.`,
  ];
  if (input.avoid.length > 0) {
    lines.push(
      "",
      "Эти подписи уже показывали, новые должны сильно отличаться по заходу, первой строке и формулировкам (не перефразируй их):",
      ...input.avoid.map((text, i) => `${i + 1}) ${text.slice(0, 500).replace(/\s+/g, " ")}`)
    );
  }
  return lines.filter((line): line is string => line !== null).join("\n");
}

/** Схема ответа модели; половина для таджикского текста нужна только в режиме «русский + тоҷикӣ». */
function schemaFor(language: SocialVideoCaptionLanguage): Record<string, unknown> {
  const lineList = { type: "array", items: { type: "string" } };
  const properties: Record<string, unknown> = {
    hook: { type: "string", description: "Цепляющая первая строка, до 100 символов, без номера телефона." },
    body: { ...lineList, description: "2-4 короткие строки по сути ролика, только факты из описания." },
    cta: { type: "string", description: "Одна строка с призывом написать или позвонить, БЕЗ номера телефона." },
    hashtags: { ...lineList, description: "5-8 тематических хештегов, каждый начинается с #." },
  };
  const required = ["hook", "body", "cta", "hashtags"];
  if (language === "RU_TG") {
    properties.hookTg = { type: "string", description: "Крючок на таджикском (кириллица)." };
    properties.bodyTg = { ...lineList, description: "Те же строки на таджикском." };
    properties.ctaTg = { type: "string", description: "Призыв на таджикском, без номера телефона." };
    required.push("hookTg", "bodyTg", "ctaTg");
  }
  return {
    type: "object",
    properties: {
      variants: {
        type: "array",
        items: { type: "object", properties, required },
      },
    },
    required: ["variants"],
  };
}

/** Вызов модели с потолком времени: callGemini сам перебирает модели и ключи и может занять минуты. */
async function callModelWithTimeout(input: SocialVideoAiCaptionRequest): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), AI_TIMEOUT_MS);
  });
  try {
    const answer = await Promise.race([
      callGemini<unknown>({
        endpoint: "social-video-caption-ai",
        system: buildSystemPrompt(),
        user: buildUserPrompt(input),
        maxTokens: input.language === "RU_TG" ? 6144 : 4096,
        schema: schemaFor(input.language),
      }),
      timeout,
    ]);
    if (answer === "timeout") {
      void logSystemError("ai", `ИИ не ответил за ${AI_TIMEOUT_MS / 1000} с (подписи свободного ролика)`);
      throw new SocialVideoAiError(`ИИ не ответил за ${AI_TIMEOUT_MS / 1000} секунд — попробуйте ещё раз`);
    }
    return answer;
  } catch (err) {
    if (err instanceof SocialVideoAiError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    void logSystemError("ai", `Сбой ИИ при написании подписей свободного ролика: ${reason}`);
    throw new SocialVideoAiError("ИИ сейчас недоступен — попробуйте ещё раз через минуту или напишите подпись сами");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Варианты подписи к свободному ролику. Возвращает от 1 до SOCIAL_VIDEO_CAPTION_VARIANTS
 * готовых текстов (с контактами и хештегами), каждый не длиннее предела выбранных сетей.
 * Нет ответа, пустой ответ или все варианты забракованы проверкой фактов →
 * `SocialVideoAiError` с текстом для экрана.
 */
export async function generateSocialVideoCaptions(input: SocialVideoAiCaptionRequest): Promise<string[]> {
  const answer = await callModelWithTimeout(input);
  if (answer == null) {
    // callGemini уже записал причину в журнал ошибок и вернул null (нет ключа, отказ Google, блокировка промта).
    throw new SocialVideoAiError("ИИ сейчас недоступен — не ответил на запрос. Попробуйте ещё раз через минуту или напишите подпись сами");
  }
  const parsed = responseSchema.safeParse(answer);
  if (!parsed.success || parsed.data.variants.length === 0) {
    throw new SocialVideoAiError("ИИ вернул пустой ответ — нажмите «Перегенерировать»");
  }

  const isSafe = makeFactGuard(`${input.brief}\n${input.title ?? ""}`);
  const limit = effectiveCaptionLimit(input.channels);
  // Заходы, которые уже показывали, и повторы внутри ответа не берём: «Перегенерировать» должно давать новое.
  const usedKeys = new Set(input.avoid.map(hookKey));
  const captions: string[] = [];
  for (const candidate of parsed.data.variants) {
    const variant = variantSchema.safeParse(candidate);
    if (!variant.success) continue;
    const assembled = assembleCaption(variant.data, input.language, isSafe);
    if (!assembled) continue;
    const caption = fitCaptionToLimit(assembled, limit);
    const key = hookKey(caption);
    if (!key || usedKeys.has(key)) continue;
    usedKeys.add(key);
    captions.push(caption);
    if (captions.length === SOCIAL_VIDEO_CAPTION_VARIANTS) break;
  }

  if (captions.length === 0) {
    throw new SocialVideoAiError("ИИ написал подписи, но они не прошли проверку (выдуманные цифры, ссылки или повтор прежних) — нажмите «Перегенерировать»");
  }
  return captions;
}

// ───────────────────────────── обложка ─────────────────────────────

export interface SocialVideoCoverInput {
  title: string;
  brief: string | null;
  /** Пожелание к картинке своими словами (экран «Нарисовать обложку»). */
  prompt?: string | null;
  /** Кто рисует. По умолчанию Gemini (SOCIAL_VIDEO_DEFAULT_COVER_PROVIDER). */
  provider?: SocialVideoCoverProvider;
  /**
   * Кадр из самого ролика (JPEG) — основа обложки. Берёт только Gemini (умеет рисовать по картинке);
   * для OpenAI игнорируется, `usedFrame` в ответе будет false.
   */
  frameImage?: Buffer | null;
  /** Свежие тренды оформления: вписываются в промт текстом у обоих рисовальщиков. */
  trends?: SocialVideoTrends | null;
}

export interface SocialVideoCoverResult {
  buffer: Buffer;
  mimeType: string;
  /** Кто нарисовал на самом деле. */
  provider: SocialVideoCoverProvider;
  /** Кадр ролика действительно ушёл в запрос как основа. */
  usedFrame: boolean;
  /** Тренды действительно вписаны в промт. */
  usedTrends: boolean;
}

/** Сколько пунктов трендов вписываем в промт: больше — модель теряет главное. */
const MAX_TREND_ITEMS_IN_PROMPT = 7;

function trendsLine(trends: SocialVideoTrends | null | undefined): string | null {
  const items = (trends?.digest ?? [])
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, MAX_TREND_ITEMS_IN_PROMPT);
  return items.length > 0 ? `Учти актуальные тренды оформления обложек: ${items.join("; ")}.` : null;
}

/**
 * Промт обложки. БЕЗ ТЕКСТА НА КАРТИНКЕ — намеренно: модели искажают буквы, особенно кириллицу
 * и таджикские знаки (тот же вывод, что в ai/coverImage.ts); название, если надо, кладёт сам
 * ролик. Тема — со слов владельца, поэтому подставляется как данные, а не как команда.
 *
 * Есть `frameImage` — промт для РИСОВАНИЯ ПО КАДРУ: сохранить героя и сцену, а не придумать новые
 * (поэтому здесь нет «без людей» и «современная архитектура», которые спорили бы с кадром).
 */
export function buildSocialVideoCoverPrompt(input: SocialVideoCoverInput): string {
  const topic = [input.title.trim(), input.brief?.trim()].filter(Boolean).join(". ");
  const wish = input.prompt?.trim() ? `Пожелание к картинке: ${input.prompt.trim()}.` : null;
  const trends = trendsLine(input.trends);
  const noText = "БЕЗ ТЕКСТА: никаких букв, цифр, надписей, логотипов, водяных знаков и вывесок.";

  if (input.frameImage && input.frameImage.length > 0) {
    return [
      "К запросу приложен КАДР из самого ролика. Это основа обложки: сохрани героя и сцену кадра (людей, интерьер, объект),",
      "узнаваемо и без искажения лиц и пропорций.",
      "Сделай из него красивую вертикальную рекламную обложку Reels (9:16) для агентства недвижимости Royal Home в Душанбе, Таджикистан:",
      "перекомпонуй под вертикаль, усиль свет, цвет и глубину, оставь свободное место сверху и снизу.",
      topic ? `Тема ролика: ${topic}.` : null,
      wish,
      trends,
      noText,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  return [
    "Красивая вертикальная рекламная обложка Reels (9:16) для агентства недвижимости в Душанбе, Таджикистан.",
    topic ? `Тема ролика: ${topic}.` : null,
    wish,
    "Фотореалистичная сочная картинка премиального уровня: современная архитектура или уютный интерьер, светлая и тёплая",
    "палитра, мягкий золотой свет, много воздуха, главный объект в центре кадра, свободное место сверху и снизу.",
    trends,
    `${noText} Без людей крупным планом.`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

// ───────────────────────────── OpenAI ─────────────────────────────

const OPENAI_MONEY_MESSAGE =
  "На счёте OpenAI закончились деньги — пополните баланс или загрузите обложку сами. Можно также переключиться на Gemini";

interface ImagesGenerationResponse {
  data?: { b64_json?: string }[];
  usage?: ImageUsage;
}

/**
 * Рисует обложку ИИ (OpenAI). Ключ, модель, качество и учёт расхода — те же, что у обложек
 * объектов (Настройки → Обложки для соцсетей). Возвращает PNG как пришёл от модели: под
 * вертикаль 1080×1920 его подгоняет тот, кто сохраняет обложку (как для загруженной).
 * Расход пишется в журнал ИИ под своим endpoint `social-video-cover`, дневной предел
 * обложек объектов он не расходует.
 */
async function drawOpenAiCover(prompt: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const started = Date.now();
  let model = "";
  try {
    const key = await resolveOpenAiKey();
    if (!key) {
      throw new SocialVideoAiError("Ключ OpenAI не задан — вставьте его в Настройках, переключитесь на Gemini или загрузите обложку сами");
    }
    const settings = await loadCoverRuntimeSettings();
    model = settings.openaiImageModel;
    const size = coverImageSize(settings.openaiImageModel, "story");
    const response = await openAiPost<ImagesGenerationResponse>("/images/generations", {
      apiKey: key.key,
      timeoutMs: OPENAI_IMAGE_TIMEOUT_MS,
      body: {
        model,
        prompt,
        size,
        quality: settings.openaiImageQuality,
        n: 1,
        output_format: "png",
      },
    });
    const encoded = response.data?.find((item) => item.b64_json)?.b64_json;
    if (!encoded) throw new SocialVideoAiError("ИИ вернул пустой ответ без картинки — попробуйте ещё раз");
    const buffer = Buffer.from(encoded, "base64");
    if (buffer.length === 0) throw new SocialVideoAiError("ИИ вернул пустую картинку — попробуйте ещё раз");
    const cost = imageCostFromUsage(response.usage) ?? estimateImageCostUsd(settings.openaiImageQuality, "1024x1536");
    await logOpenAiCall({ endpoint: "social-video-cover", model, costUsd: cost, ms: Date.now() - started, ok: true });
    return { buffer, mimeType: "image/png" };
  } catch (err) {
    if (err instanceof SocialVideoAiError) throw err;
    if (model) {
      await logOpenAiCall({ endpoint: "social-video-cover", model, costUsd: null, ms: Date.now() - started, ok: false });
    }
    if (err instanceof OpenAiError) {
      if (err.code === OPENAI_OUT_OF_MONEY_CODE) {
        throw new SocialVideoAiError(OPENAI_MONEY_MESSAGE);
      }
      void logSystemError("ai", `Обложка свободного ролика не нарисована (${model || "модель не выбрана"}): ${err.message}`);
      // OpenAiError.message уже переведён на русский (describeOpenAiError) и без секретов.
      throw new SocialVideoAiError(`${err.message}. Попробуйте ещё раз, переключитесь на Gemini или загрузите обложку сами`);
    }
    const reason = err instanceof Error ? err.message : String(err);
    void logSystemError("ai", `Сбой при рисовании обложки свободного ролика: ${reason}`);
    throw new SocialVideoAiError("Не удалось нарисовать обложку — попробуйте ещё раз или загрузите свою");
  }
}

// ───────────────────────────── Gemini ─────────────────────────────

/** Рисование дольше текста (живой замер 22.08.2026: ~20 с на обложку); с кадром-основой чуть дольше. */
const GEMINI_COVER_TIMEOUT_MS = 90_000;
/** Длинная сторона готовой обложки: под вертикаль 1080×1920 её подгоняет тот, кто сохраняет. */
const GEMINI_COVER_MAX_SIDE_PX = 1920;

/**
 * Отказ Google при рисовании → текст для экрана. Главное отличие, как в ai/coverImage.ts: 429 с
 * `FreeTier` значит «проект без оплаты, ждать бесполезно», а обычный 429 — «подождите».
 * Подробности (тело ответа) остаются в журнале ошибок, на экран они не попадают.
 */
export function explainGeminiCoverFailure(status: number, body: string): string {
  if (status === 429 && /FreeTier/i.test(body)) {
    return "Gemini рисует картинки только на платном проекте Google — переключитесь на ChatGPT или подключите оплату";
  }
  if (status === 429) return "Google ограничил частоту запросов Gemini — попробуйте через несколько минут или переключитесь на ChatGPT";
  if (status === 404) return "Рисующей модели Gemini нет или она закрыта — проверьте имя в Настройках → ИИ или переключитесь на ChatGPT";
  if (status === 401 || status === 403) return "Ключ Gemini отклонён Google — проверьте его в Настройках → ИИ или переключитесь на ChatGPT";
  if (status === 400) return "Gemini не принял запрос на рисование — попробуйте другое пожелание или переключитесь на ChatGPT";
  return "Gemini сейчас не нарисовал обложку — попробуйте ещё раз или переключитесь на ChatGPT";
}

interface GeminiImageResponse {
  candidates?: {
    content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * Рисует вертикальную обложку 9:16 через Gemini. Транспорт, ключи (перебор по очереди) и модель
 * рисования — как у обложек блога (ai/coverImage.ts, Настройки → ИИ). С `frame` кадр уходит
 * первой частью запроса картинкой-основой (inlineData image/jpeg).
 */
async function drawGeminiCover(prompt: string, frame: Buffer | null): Promise<{ buffer: Buffer; mimeType: string }> {
  const started = Date.now();
  const runtime = await resolveGeminiRuntime();
  if (runtime.keys.length === 0) {
    throw new SocialVideoAiError("Ключ Gemini не введён — вставьте его в Настройках → ИИ, переключитесь на ChatGPT или загрузите обложку сами");
  }
  const model = runtime.imageModel;
  const parts: Record<string, unknown>[] = [];
  if (frame) parts.push({ inlineData: { mimeType: "image/jpeg", data: frame.toString("base64") } });
  parts.push({ text: prompt });

  const send = (apiKey: string, withAspect: boolean): Promise<Response> =>
    fetch(geminiGenerateUrlFor(model), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey, ...geminiProxyHeaders() },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseModalities: ["IMAGE"],
          // Не все рисующие модели знают imageConfig: на 400 про него повторяем без него (9:16 остаётся в промте).
          ...(withAspect ? { imageConfig: { aspectRatio: "9:16" } } : {}),
        },
      }),
      signal: AbortSignal.timeout(GEMINI_COVER_TIMEOUT_MS),
    });

  let userMessage = "Не удалось нарисовать обложку — попробуйте ещё раз, переключитесь на ChatGPT или загрузите свою";
  let technical = "нет попыток";

  for (const apiKey of runtime.keys) {
    try {
      let res = await send(apiKey, true);
      let detail = res.ok ? "" : (await res.text()).replace(/\s+/g, " ");
      if (!res.ok && res.status === 400 && /aspect|imageConfig|image_config/i.test(detail)) {
        res = await send(apiKey, false);
        detail = res.ok ? "" : (await res.text()).replace(/\s+/g, " ");
      }
      if (!res.ok) {
        userMessage = explainGeminiCoverFailure(res.status, detail);
        technical = `HTTP ${res.status}: ${detail.slice(0, 300)}`;
        // 401/403 — беда конкретного ключа, следующий может ответить. Остальное относится к модели или
        // проекту, и перебор ключей его не изменит.
        if (res.status !== 401 && res.status !== 403) break;
        continue;
      }

      const data = (await res.json()) as GeminiImageResponse;
      const inline = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
      if (!inline?.data) {
        // Ответ без картинки — почти всегда отказ модели по содержанию запроса (кадр с людьми, фильтры).
        const reason = data.promptFeedback?.blockReason ?? data.candidates?.[0]?.finishReason ?? "нет причины";
        userMessage = frame
          ? "Gemini отказался рисовать по этому кадру — нажмите «Нарисовать» без кадра из ролика или переключитесь на ChatGPT"
          : "Gemini отказался рисовать по этому описанию — измените пожелание или переключитесь на ChatGPT";
        technical = `ответ без изображения (${reason})`;
        break;
      }

      const buffer = await sharp(Buffer.from(inline.data, "base64"))
        .resize({ width: GEMINI_COVER_MAX_SIDE_PX, height: GEMINI_COVER_MAX_SIDE_PX, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 88 })
        .toBuffer();
      void logAiCall({
        endpoint: "social-video-cover:gemini",
        model,
        spent: {
          ...emptyUsage(),
          inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        },
        ms: Date.now() - started,
        ok: true,
      });
      return { buffer, mimeType: "image/jpeg" };
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      technical = err instanceof Error ? err.message : String(err);
      if (timedOut) {
        userMessage = `Gemini не нарисовал обложку за ${GEMINI_COVER_TIMEOUT_MS / 1000} секунд — попробуйте ещё раз или переключитесь на ChatGPT`;
        break;
      }
    }
  }

  void logAiCall({ endpoint: "social-video-cover:gemini", model, spent: emptyUsage(), ms: Date.now() - started, ok: false });
  void logSystemError("ai", `Обложка свободного ролика не нарисована Gemini (${model}): ${technical}`);
  throw new SocialVideoAiError(userMessage);
}

// ───────────────────────────── вход для сервиса ─────────────────────────────

/**
 * Рисует обложку свободного ролика выбранным рисовальщиком (по умолчанию Gemini).
 * Возвращает картинку, чем нарисовано и что реально использовано (кадр, тренды) — сервис
 * сохраняет это в метаданных обложки. Любой отказ — `SocialVideoAiError` с русским текстом.
 */
export async function generateSocialVideoCoverImage(input: SocialVideoCoverInput): Promise<SocialVideoCoverResult> {
  const provider = input.provider ?? SOCIAL_VIDEO_DEFAULT_COVER_PROVIDER;
  const frame = provider === "GEMINI" && input.frameImage && input.frameImage.length > 0 ? input.frameImage : null;
  const prompt = buildSocialVideoCoverPrompt({ ...input, frameImage: frame });
  const usedTrends = trendsLine(input.trends) !== null;

  const drawn = provider === "GEMINI" ? await drawGeminiCover(prompt, frame) : await drawOpenAiCover(prompt);
  return { ...drawn, provider, usedFrame: frame !== null, usedTrends };
}

/**
 * Какие рисовальщики доступны сейчас — БЕЗ сетевых вызовов: смотрим только, введён ли ключ
 * (Настройки или окружение — как это проверяют сами рисовальщики). Что у проекта Google включена
 * оплата, так не узнать: об этом скажет первый вызов Gemini понятной ошибкой.
 */
export async function listCoverProviders(): Promise<SocialVideoAiProviderInfo[]> {
  const check = async (
    provider: SocialVideoCoverProvider,
    hasKey: () => Promise<boolean>,
    missing: string
  ): Promise<SocialVideoAiProviderInfo> => {
    const label = SOCIAL_VIDEO_COVER_PROVIDER_LABELS[provider];
    try {
      return (await hasKey())
        ? { provider, label, available: true, problem: null }
        : { provider, label, available: false, problem: missing };
    } catch {
      return { provider, label, available: false, problem: "Не удалось проверить ключ — попробуйте ещё раз" };
    }
  };
  return Promise.all([
    check("GEMINI", async () => (await resolveGeminiRuntime()).keys.length > 0, "Ключ Gemini не введён — Настройки → ИИ"),
    check("OPENAI", async () => (await resolveOpenAiKey()) !== null, "Ключ OpenAI не введён — Настройки → ИИ"),
  ]);
}
