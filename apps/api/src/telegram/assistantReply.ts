import { clientLanguageScores } from "../ai/clientLanguage.js";
import { maskPhonesInFreeText } from "../lib/clientPhone.js";
function publicBase(): string | null {
  const raw = process.env.CRM_PUBLIC_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}
const MAX_HUMAN_PARTS = 4;
/** Ответ «как у людей»: реплики разделены строкой `|||` — не больше четырёх, пустые отбрасываются. */
export function splitHumanMessages(text: string): string[] {
  const parts = text.split(/\n?\s*\|\|\|\s*\n?/).map((p) => p.trim()).filter(Boolean);
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
/**
* Ответ помощника (markdown со ссылками вида `[Имя](/clients/ID)`) → простой текст
* для Telegram. Относительные ссылки в Telegram не работают — делаем абсолютными
* (CRM_PUBLIC_URL); адреса не маскируются, а вот телефоны и @ники в тексте — да,
* когда `maskPhones`: сначала прячем ссылки, потом маскируем остальное.
*/
export function renderAssistantForTelegram(text: string, opts: {
  maskPhones: boolean;
}): string {
  text = sanitizeAssistantReply(text, opts.maskPhones);
  const base = publicBase();
  const links: string[] = [];
  let out = text.replace(MD_LINK, (_m, label: string, path: string) => {
    const shown = label;
    links.push(base ? `${shown} — ${base}${path}` : shown);
    return `\u0000${links.length - 1}\u0000`;
  });
  out = out.replace(/\*\*(.+?)\*\*/g, "$1");
  // eslint-disable-next-line no-control-regex
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => links[Number(i)] ?? "");
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
/** Only entity routes: discard query/fragment and never turn arbitrary paths into links. */
export function sanitizeAssistantReply(text: string, maskContacts: boolean): string {
  // Strip internal placeholders supplied by the model before generating our own.
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000\u0001]/g, "");
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
    .replace(/(?<![\d+])\d{1,2}[-./]\d{1,2}[-./]\d{4}(?!\d)|(?<![\d+])\d[\d \u00a0]*(?:[.,]\d{1,2})?\s*(?:сомони|TJS|USD|доллар(?:ов|а)?|\$)(?!\p{L})/giu, hold);
  // eslint-disable-next-line no-control-regex
  return maskPhonesInFreeText(protectedText).replace(/\u0001(\d+)\u0001/g, (_m, i: string) => saved[Number(i)] ?? "");
}
export const VOICE_MAX_CHARS = 320;
export interface AssistantReplyPlan {
  text: string;
  speech: string;
  truncated: boolean;
  needsText: boolean;
  language: "ru" | "tg" | "text-only";
}
export function prepareAssistantReply(text: string, maskContacts = false): AssistantReplyPlan {
  const full = sanitizeAssistantReply(text, maskContacts);
  // Even in private, speech does not recite contacts. The full authorised text retains them.
  const safeSpeech = sanitizeAssistantReply(full, true);
  const cleaned = safeSpeech
    .replace(/\[([^\]\n]+)\]\([^)]+\)/g, "$1")
    .replace(/(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/(?:\+?\d*)?[•]+\d*|@[•]+|(?:t(?:elegram)?\.me|wa\.me)\/[•]+/g, "контакт в карточке")
    .replace(/[\p{Extended_Pictographic}️‍]/gu, "")
    .replace(/[—–]{2,}|[-_=*#>•]{2,}/g, " ")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\|\|\|/g, ". ")
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/\.\s*\./g, ".")
    .replace(/\s{2,}/g, " ").trim();
  const truncated = cleaned.length > VOICE_MAX_CHARS;
  let speech = cleaned;
  if (truncated) {
    const cut = cleaned.slice(0, VOICE_MAX_CHARS - 1);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    speech = end > 200 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
  }
  // Reuse CRM language markers, then add assistant-specific Tajik verbs.
  // Unknown/mixed replies stay text-only: Cyrillic alone does not establish Russian.
  const scores = clientLanguageScores(cleaned);
  const tajik = scores.tajik > 0 || scores.greetings > 0 || /[ғӣқӯҳҷ]|(?:^|[^\p{L}])(?:ёфтам|ёфт|кардам|кунед|омода|шуд|надорам|равон|дигар|интихоб|нависед|мебошад|мекунам|муштари|пайдо)(?=$|[^\p{L}])/iu.test(full);
  const russian = scores.russian > 0 || /(?:^|[^\p{L}])(?:готово|нашла|нашёл|нашел|добавила|добавил|ответ|данные|бюджет|источник|подробности|контакт|телефон|дата|помочь|помогу|сделано|хорошо|отлично|проверила|записала)(?=$|[^\p{L}])/iu.test(cleaned);
  const language = tajik ? "tg" : russian ? "ru" : "text-only";
  const hasLink = /(?:https?:\/\/|www\.|\[[^\]]+\]\([^)]*\)|\/(?:clients|properties)\/)/i.test(text);
  const promisedText = /(?:подробност|детал|карточк|список|ссылк|цифр)[\s\S]{0,100}(?:текст|отдельн)|(?:текст|отдельн)[\s\S]{0,100}(?:подробност|детал|карточк|список|ссылк)/i.test(full);
  const contactsRemoved = safeSpeech !== full;
  return { text: full, speech, truncated, language, needsText: truncated || hasLink || promisedText || contactsRemoved };
}
