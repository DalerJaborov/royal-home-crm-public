import { clientLanguageScores, detectClientLanguage } from "../ai/clientLanguage.js";
import { maskAssistantContacts } from "../lib/assistantContacts.js";
import { tajikSpeechNumbers } from "./tajikSpeechNumbers.js";
function publicBase(): string | null {
  const raw = process.env.CRM_PUBLIC_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}
export const MAX_HUMAN_PARTS = 4;
export const ASSISTANT_VOICE_PART_CHARS = 180;
const humanSentences = new Intl.Segmenter("ru", { granularity: "sentence" });

function splitLongHumanPart(part: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = part;
  while (rest.length > limit && chunks.length < MAX_HUMAN_PARTS - 1) {
    let end = 0;
    for (const sentence of humanSentences.segment(rest)) {
      const nextEnd = sentence.index + sentence.segment.trimEnd().length;
      if (nextEnd > limit) break;
      end = nextEnd;
    }
    if (!end) end = rest.slice(0, limit + 1).search(/\s+\S*$/u);
    if (end <= 0) break;
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trimStart();
  }
  return [...chunks, rest];
}

/** Ответ «как у людей»: реплики разделены строкой `|||` — не больше четырёх, пустые отбрасываются. */
export function splitHumanMessages(text: string, maxPartChars?: number): string[] {
  let parts = text.split(/\n?\s*\|\|\|\s*\n?/).map((p) => p.trim()).filter(Boolean);
  if (maxPartChars) parts = parts.flatMap(part => splitLongHumanPart(part, maxPartChars));
  if (parts.length === 0)
    return [];
  if (parts.length <= MAX_HUMAN_PARTS)
    return parts;
  return [...parts.slice(0, MAX_HUMAN_PARTS - 1), parts.slice(MAX_HUMAN_PARTS - 1).join("\n")];
}
/**
* Реакции как у человека (владелец, 03.11.2026): модель сама решает, ставить ли реакцию на сообщение
* собеседника, и пишет первой строкой `[реакция: 👍]`. Строка всегда вырезается из текста;
* реакция ставится только из списка ниже (без обидных) — иначе молча пропускается.
*/
export const ASSISTANT_REACTIONS: ReadonlySet<string> = new Set([
  "👍", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🎉", "🤩", "🙏", "👌",
  "💯", "🤣", "⚡", "🤝", "🫡", "😎", "👀", "😇", "🤗", "🆒", "🤓", "🤯",
]);
const REACTION_LINE = /^\s*\[реакция:\s*([^\]\r\n]*)\]\s*/u;
export function splitReaction(text: string): {
  text: string;
  reaction: string | null;
} {
  const m = REACTION_LINE.exec(text);
  if (!m)
    return { text, reaction: null };
  const emoji = m[1].trim().replace(/\uFE0F/g, "");
  return { text: text.slice(m[0].length), reaction: ASSISTANT_REACTIONS.has(emoji) ? emoji : null };
}
const MD_LINK = /\[([^\]\n]+)\]\((\/[^)\s]*)\)/g;

/** Links are vetted by the assistant core or produced by a CRM fast path. */
export function assistantCardLinks(text: string, maskPhones: boolean) {
  const base = publicBase();
  if (!base) return [];
  let origin: URL;
  try { origin = new URL(base); } catch { return []; }
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) return [];
  const links = new Map<string, { path: string; text: string; url: string }>();
  for (const [, label, path] of sanitizeAssistantReply(text, maskPhones).matchAll(MD_LINK)) {
    if (links.has(path)) continue;
    const title = label.replace(/[*_`]/g, "").trim().slice(0, 72);
    if (title) links.set(path, { path, text: title, url: base + path });
  }
  return [...links.values()];
}

export type AssistantReplyMode = "auto" | "text" | "voice";

export function requestedAssistantReplyPreference(text: string): {
  mode: AssistantReplyMode;
  voiceLanguage?: AssistantSpeechLanguage;
} {
  for (const part of text.split(/[,.!?;\n]+|\s+и\s+(?=(?:ответь|напиши|пришли|отправь))/iu).reverse()) {
    const clause = part.trim();
    if (/^(?:пожалуйста\s+)?(?:(?:ответь(?:те)?|напиши(?:те)?|пришли(?:те)?|отправь(?:те)?)(?:\s+(?:мне|это|ответ)){0,3}\s+)?(?:только\s+)?текстом$/iu.test(clause) ||
        /^(?:матнӣ ҷавоб деҳ|бо матн ҷавоб деҳ|бо матн навис)$/iu.test(clause)) return { mode: "text" };
    if (/^(?:пожалуйста\s+)?(?:(?:ответь(?:те)?|пришли(?:те)?|отправь(?:те)?)(?:\s+(?:мне|это|ответ)){0,3}\s+)?(?:голосом|голосовым)$/iu.test(clause)) return { mode: "voice", voiceLanguage: "ru" };
    if (/^(?:бо овоз ҷавоб деҳ|бо овоз фирист)$/iu.test(clause)) return { mode: "voice", voiceLanguage: "tg" };
  }
  return { mode: "auto" };
}

export function requestedAssistantReplyMode(text: string): AssistantReplyMode {
  return requestedAssistantReplyPreference(text).mode;
}
/** Plain fallback keeps link labels. Delivery attaches verified CRM links as buttons. */
export function renderAssistantForTelegram(text: string, opts: {
  maskPhones: boolean;
}): string {
  return sanitizeAssistantReply(text, opts.maskPhones)
    .replace(MD_LINK, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1");
}
const HTML_ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const escapeHtml = (t: string): string => t.replace(/[&<>"]/g, (c) => HTML_ESC[c]);
/**
* Лёгкое оформление уже экранированного текста (владелец, 03.11.2026): суммы — жирным, коды карточек
* и телефоны — моноширинным (копируются одним тапом). Ссылки к этому моменту спрятаны в метки \u0000N\u0000,
* внутрь тегов правило не заходит. Замаскированный телефон (+992•••••3726) под шаблон не попадает.
*/
export function decorateHtml(html: string): string {
  return html
    .replace(/(?<![\p{L}\d])(?:ОБ|ПК)-\d{3,}(?!\d)/gu, "<code>$&</code>")
    .replace(/\+992\d{9}(?!\d)/g, "<code>$&</code>")
    .replace(/(?<![\d+])\d[\d \u00a0]*(?:\s?(?:TJS|USD|сомони|\$))/gu, "<b>$&</b>");
}
/**
* Тот же ответ, но HTML для Telegram: ссылка прячется В ИМЯ (<a href>), а не печатается длинным адресом
* (владелец, 03.11.2026). Маска телефонов, вырезание **жирного** и порядок «сначала ссылки, потом маска» —
* как в renderAssistantForTelegram. Нет CRM_PUBLIC_URL — имя без ссылки.
*/
export function renderAssistantHtml(text: string, opts: {
  maskPhones: boolean;
}): string {
  text = sanitizeAssistantReply(text, opts.maskPhones);
  const base = publicBase();
  const links: {
    label: string;
    path: string;
  }[] = [];
  let out = text.replace(MD_LINK, (_m, label: string, path: string) => {
    links.push({ label, path });
    return `\u0000${links.length - 1}\u0000`;
  });
  out = out.replace(/\*\*(.+?)\*\*/g, "$1");
  out = decorateHtml(escapeHtml(out));
  // eslint-disable-next-line no-control-regex
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => {
    const link = links[Number(i)];
    if (!link)
      return "";
    const label = escapeHtml(link.label);
    return base ? `<a href="${escapeHtml(base + link.path)}">${label}</a>` : label;
  });
}
const DOLLAR_PREFIX = /\$[ \u00a0\u202f]*((?:\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:[.,]\d{1,2})?)(?![\p{L}\p{Nd}]|[.,]\d)/gu;
const OBJECT_CODE_AFTER_LINK = /\[([^\]\n]+)\]\((\/properties\/[^)\s]+)\)[ \t]+(?:\([ \t]*`?(ОБ-\d{3,})`?[ \t]*\)|`(ОБ-\d{3,})`)/giu;
const TEMPERATURE_STATUS = /[ \t]*(?:[,;·–—-][ \t]*)?статус[ \t]*[:–—-]?[ \t]*\*{0,2}`?(?:hot|cold|warm|горяч[а-яё]+|холодн[а-яё]+|т[её]пл[а-яё]+)`?\*{0,2}(?![\p{L}\p{N}])/giu;
const TEMPERATURE_TAG = /[ \t]*(?:\([ \t]*(?:hot|cold|warm|горячий|холодный|т[её]плый)[ \t]*\)|[·–—][ \t]*(?:hot|cold|warm)(?=[ \t]*(?:[,.\n]|$)))/giu;

/** Only entity routes: discard query/fragment and never turn arbitrary paths into links. */
export function sanitizeAssistantReply(text: string, maskContacts: boolean): string {
  // Strip internal placeholders supplied by the model before generating our own.
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000\u0001]/g, "");
  text = text.replace(TEMPERATURE_STATUS, "").replace(TEMPERATURE_TAG, "");
  text = text.replace(OBJECT_CODE_AFTER_LINK, (_m, label: string, path: string, parenthesized: string | undefined, inline: string | undefined) => {
    const code = parenthesized ?? inline;
    return `[${/ОБ-\d{3,}/iu.test(label) ? label : `${code} · ${label}`}](${path})`;
  });
  const safeLinks = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, path: string) => {
    if (!path.startsWith("/"))
      return `[${label}](${path})`;
    const route = path.split(/[?#]/, 1)[0];
    return /^\/(?:clients|properties)\/(?:[0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(route)
      ? `[${label}](${route})` : label;
  });
  if (!maskContacts)
    return safeLinks;
  // Preserve approved IDs and financial/date literals while masking free text.
  const saved: string[] = [];
  const hold = (value: string) => { saved.push(value); return `\u0001${saved.length - 1}\u0001`; };
  const protectedText = safeLinks.replace(/\]\((\/(?:clients|properties)\/[^)]+)\)/g, (_m, path: string) => `](${hold(path)})`)
    .replace(DOLLAR_PREFIX, hold)
    .replace(/(?<![\d+])(?:\d{1,2}[-./]\d{1,2}[-./]\d{4}|\d{4}-\d{2}-\d{2})(?![\d-])/g, hold)
    .replace(/(?<![\d+])\d[\d \u00a0\u202f]*(?:[.,]\d{1,2})?\s*(?:сомон[иӣ]|TJS|USD|доллар(?:ов|а)?|\$)(?!\p{L})/giu, hold);
  // eslint-disable-next-line no-control-regex
  return maskAssistantContacts(protectedText).replace(/\u0001(\d+)\u0001/g, (_m, i: string) => saved[Number(i)] ?? "");
}
export const VOICE_MAX_CHARS = 320;
export type AssistantSpeechLanguage = "ru" | "tg";
export interface AssistantReplyPlan {
  text: string;
  speech: string;
  truncated: boolean;
  needsText: boolean;
  needsWrittenDetails: boolean;
  ambiguousLanguage: boolean;
  language: AssistantSpeechLanguage | "text-only";
}
/** Remove non-spoken markup before splitting so links and contact masks stay intact. */
export function stripAssistantSpeechMarkup(safeSpeech: string): string {
  return safeSpeech
    .replace(/\[([^\]\n]+)\]\([^)]+\)/g, "$1")
    .replace(/(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/(?:\+?\d*)?[•]+\d*|@[•]+|(?:t(?:elegram)?\.me|wa\.me)\/[•]+/g, "контакт в карточке")
    .replace(/[\p{Extended_Pictographic}️‍]/gu, "")
    .replace(/[—–]{2,}|[-_=*#>•]{2,}/g, " ")
    .replace(/^\s*[-•]\s+/gm, "");
}

export function prepareAssistantReply(text: string, maskContacts = false, fallbackLanguage?: AssistantSpeechLanguage): AssistantReplyPlan {
  const full = sanitizeAssistantReply(text, maskContacts);
  // Even in private, speech does not recite contacts. The full authorised text retains them.
  const safeSpeech = sanitizeAssistantReply(full, true);
  const cleaned = stripAssistantSpeechMarkup(safeSpeech)
    .replace(/\|\|\|/g, ". ")
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/\.\s*\./g, ".")
    .replace(/\s{2,}/g, " ").trim();
  // Reuse CRM language markers, then add assistant-specific Tajik verbs.
  // Unknown/mixed replies stay text-only: Cyrillic alone does not establish Russian.
  const scores = clientLanguageScores(cleaned);
  const tajik = scores.tajik > 0 || scores.greetings > 0 || /[ғӣқӯҳҷ]|(?:^|[^\p{L}])(?:ёфтам|ёфт|кардам|кунед|омода|шуд|надорам|равон|дигар|интихоб|нависед|мебошад|мекунам|муштари|пайдо)(?=$|[^\p{L}])/iu.test(full);
  const russian = scores.russian > 0 || /(?:^|[^\p{L}])(?:готово|нашла|нашёл|нашел|добавила|добавил|ответ|данные|бюджет|источник|подробности|контакт|телефон|дата|помочь|помогу|сделано|хорошо|отлично|проверила|записала)(?=$|[^\p{L}])/iu.test(cleaned);
  const ambiguousLanguage = scores.tajik > 0 && scores.russian > 0 && detectClientLanguage(cleaned) === "mixed";
  const language = ambiguousLanguage ? "text-only" : tajik ? "tg" : russian ? "ru" : fallbackLanguage ?? "text-only";
  const expanded = language === "tg"
    ? tajikSpeechNumbers(cleaned.replaceAll("контакт в карточке", "тамос дар корт").replace(DOLLAR_PREFIX, "$1 доллар"))
    : cleaned;
  const truncated = expanded !== null && expanded.length > VOICE_MAX_CHARS;
  let speech = expanded ?? "";
  if (truncated && language === "tg" && /\p{N}/u.test(cleaned)) {
    // A cut inside a written-out amount or time could change the value.
    speech = "";
  } else if (truncated) {
    const cut = speech.slice(0, VOICE_MAX_CHARS - 1);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    speech = end > 200 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
  }
  const hasLink = /(?:https?:\/\/|www\.|\[[^\]]+\]\([^)]*\)|\/(?:clients|properties)\/)/i.test(text);
  const promisedText = /(?:подробност|детал|карточк|список|ссылк|цифр)[\s\S]{0,100}(?:текст|отдельн)|(?:текст|отдельн)[\s\S]{0,100}(?:подробност|детал|карточк|список|ссылк)/i.test(full);
  const contactsRemoved = safeSpeech !== full;
  const needsWrittenDetails = expanded === null || hasLink || promisedText || contactsRemoved;
  return { text: full, speech, truncated, language, ambiguousLanguage, needsWrittenDetails, needsText: truncated || needsWrittenDetails };
}

export function prepareAssistantVoicePart(
  text: string, maskContacts: boolean, conversationLanguage?: AssistantSpeechLanguage,
): { part: AssistantReplyPlan; fallbackLanguage?: AssistantSpeechLanguage } {
  const part = prepareAssistantReply(text, maskContacts);
  const fallbackLanguage = conversationLanguage && part.language === "text-only" && !part.ambiguousLanguage
    && /[а-яёғӣқӯҳҷ]/iu.test(text) && !/\p{L}/u.test(text.replace(/[а-яёғӣқӯҳҷ]/giu, ""))
    ? conversationLanguage : undefined;
  return { part: fallbackLanguage ? prepareAssistantReply(text, maskContacts, fallbackLanguage) : part, fallbackLanguage };
}
