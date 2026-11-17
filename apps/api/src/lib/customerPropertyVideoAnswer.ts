/**
 * «А ВИДЕО ЭТОЙ КВАРТИРЫ ЕСТЬ?» — ОТВЕТ ИЗ CRM, А НЕ ИЗ МОДЕЛИ (16–17.11.2026).
 *
 * Живой случай Instagram 16.11, 21:29–21:30: клиент переслал наш пост объекта №178 и спросил «Хами хонара
 * видеоша дорен». У ядра бота нет ни инструмента, ни факта «видео», поэтому правдиво ответить могла только CRM:
 *  - есть опубликованный рилс объекта — ссылка на него;
 *  - нет рилса, но в карточке готов ролик (clipVideoUrl, READY) — «видео есть, агент пришлёт» (ссылка на загруженный файл
 *    подписана токеном на сутки и длинная — клиенту её не шлём, ревью #225 N2);
 *  - видео нет — «видео пришлёт наш агент», и ход зовёт ответственного через одну дверь «бот пообещал агента».
 * Ссылка на рилс уходит только при включённом «бот может отправлять ссылки» (customerReplyLink, ревью #225 N1);
 * выключено — «видео есть, агент пришлёт» и тот же сигнал агенту.
 * Ревью #225 (17.11): решает ТОЛЬКО то, что клиент написал сам (служебные пометки «[вложение: video]» и чужие
 * транскрипты не считаются); «видео не нужно / видел» — не просьба; вместе с вопросом о цене, адресе и т. п. —
 * ответ на оба вопроса (факты из CRM той же дверью, что у ядра); любой другой вопрос рядом — ответ модели.
 * Объект — только определённый в этой же пачке сообщений (customerBurstFocusFresh), старый фокус не годится.
 */
import { prisma } from "../db.js";
import { botMayOffer, BOT_OFFER_SELECT } from "./propertyMatch.js";
import { safeCustomerPropertyLink } from "./customerPropertyUrls.js";
import { customerLinksAllowed } from "./customerAgentFeaturePolicy.js";
import { customerReplyLink } from "./customerReplyLink.js";
import { classifyCustomerPropertyFactIntent } from "./customerPropertyFactIntent.js";
import { readCustomerPropertyFacts, renderCustomerPropertyFacts } from "./customerPropertyFacts.js";
import type { CustomerPropertyFactKind } from "@royal-home/shared";

const W = (alternatives: string, flags = "iu") => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, flags);
/** «видео», «видеоша», «видеоро», «video», «ролик», «видос». */
const VIDEO_SOURCE = "видео\\p{L}*|video\\p{L}*|ролик\\p{L}*|видос\\p{L}*";
/** The customer ASKS for it (ru/tg, also in Latin letters), not offers his own. */
const REQUEST_SOURCE = "есть|имеется|пришлите|пришли|скиньте|скинь|киньте|отправьте|отправь|покажите|покажи|дайте|можно|хочу|нужн[оаы]|" +
  "доред|дорен|дорӣ|дори|дорин|ҳаст|хаст|ҳастай|хастай|бор|равон\\s+кунед|равон\\s+кунен|фиристед|фиристен|партоед|партоен|мумкин|лозим|даркор|" +
  "dored|doren|dorin|hast|bor|est|mozhno|mojno|ravon\\s+kuned|firisted|skinte|otpravte|pokazhite";
/** The request words that exist only in Tajik / only in Russian (Latin spelling included); a text with both stays with the dialogue language. */
const TAJIK_REQUEST_SOURCE = "доред|дорен|дорӣ|дори|дорин|ҳаст|хаст|ҳастай|хастай|бор|равон\\s+кунед|равон\\s+кунен|фиристед|фиристен|партоед|партоен|dored|doren|dorin|hast|ravon\\s+kuned|firisted";
const RUSSIAN_REQUEST_SOURCE = "есть|имеется|пришлите|пришли|скиньте|скинь|киньте|отправьте|отправь|покажите|покажи|дайте|можно|хочу|est|mozhno|mojno|skinte|otpravte|pokazhite";
/** «Видео не нужно», «видео видел / смотрел», «лозим нест»: not a request — never answer with a link. */
const NOT_WANTED = W("не\\s+нуж\\p{L}*|не\\s+надо|не\\s+хочу|без\\s+видео|видел\\p{L}*|смотрел\\p{L}*|посмотрел\\p{L}*|" +
  "лозим\\s+нест|даркор\\s+нест|нелозим|нахостам|намехоҳам|намехохам|дидам|дидем|тамошо\\s+кардам|didam|kerak\\s+emas");
/** Own material («сниму / пришлю видео», «видео мефиристам»): a seller's offer, never a request for ours. */
const OWN_MATERIAL = W("сниму|сняла?|пришлю|скину|отправлю|запишу|мефиристам|равон\\s+мекунам|гирифтам|мегирам|партоям");
/** Neutral framing that may stand next to the request («хами хонара», «у вас», «этой квартиры», «№178»). */
const FRAMING_SOURCE = "а|и|у|вас|вам|мне|нам|ли|же|ещё|еще|тоже|пожалуйста|лутфан|этой|этого|этот|эту|это|той|того|квартир\\p{L}*|" +
  "дом\\p{L}{0,2}|объект\\p{L}*|хами|хамин|ҳамин|ҳами|ин|хона|хонара|хонаша|хонаи|хонаро|ҳам|хам|шумо|бошад|боша|ба|аз|дар|ва|ку|кани";
/** Greetings and thanks of the same burst («Салом Алейкум», then the pictures, then the question) ask nothing. */
const GREETING_SOURCE = "салом\\p{L}*|ассалом\\p{L}*|асалом\\p{L}*|алейкум|алайкум|здравствуйте|здравствуй|привет|добрый|доброе|день|вечер|утро|" +
  "спасибо|рахмат|раҳмат|ташаккур|salom|assalomu|alaykum|rahmat";

const strip = (text: string, source: string) => text.replace(W(source, "giu"), " ");
const ownMaterialOrRefusal = (text: string) => NOT_WANTED.test(text) || OWN_MATERIAL.test(text);

/**
 * What to answer for the customer's OWN words of this burst (typed text of the current and set-aside messages only):
 *  - `{ facts: [] }` — a plain video request;
 *  - `{ facts: [...] }` — a video request together with a fact question the CRM answers (price, address, …);
 *  - `null` — not a video request, a refusal, own material, or another question: the model answers.
 */
export function customerPropertyVideoPlan(ownWords: string): { facts: CustomerPropertyFactKind[]; tajik: boolean } | null {
  // Callers pass own words only; a service marker («[вложение: video]») is stripped anyway — it is never a request.
  const text = ownWords.replace(/\[вложение:[^\]\n]*\]/giu, " ").trim();
  if (!text || text.length > 300 || /https?:\/\//iu.test(text) || /\d{5,}/u.test(text.replace(/[\s()+-]/gu, ""))) return null;
  if (!W(VIDEO_SOURCE).test(text) || !W(REQUEST_SOURCE).test(text) || ownMaterialOrRefusal(text)) return null;
  const withoutVideo = strip(strip(strip(text, GREETING_SOURCE), VIDEO_SOURCE), REQUEST_SOURCE).replace(/[№#]\s*\d{1,9}/gu, " ");
  const leftover = strip(withoutVideo, FRAMING_SOURCE).replace(/[^\p{L}]+/gu, "");
  // «Видео бор?» is Tajik by its request word alone (the dialogue-language detector has no hint for it): answer in Tajik, on «шумо».
  const tajik = W(TAJIK_REQUEST_SOURCE).test(text) && !W(RUSSIAN_REQUEST_SOURCE).test(text);
  if (!leftover) return { facts: [], tajik };
  const facts = classifyCustomerPropertyFactIntent(withoutVideo, { hasPropertyContext: true });
  return facts?.length ? { facts, tajik } : null;
}
/** Kept for callers that only need yes/no. */
export function customerPropertyVideoRequested(ownWords: string): boolean { return customerPropertyVideoPlan(ownWords) !== null; }

/** A published Instagram reel/IGTV of THIS object, as the CRM stores it (Property.instagramUrl). A photo post is not a video. */
export function customerPropertyVideoLink(instagramUrl: string | null | undefined): string | null {
  if (!instagramUrl) return null;
  let path: string;
  try { path = new URL(instagramUrl.trim()).pathname; } catch { return null; }
  if (!/^\/(?:[A-Za-z0-9._]+\/)?(?:reel|reels|tv)\/[A-Za-z0-9_-]+\/?$/u.test(path)) return null;
  return safeCustomerPropertyLink(instagramUrl.trim());
}

export type CustomerPropertyVideoAnswer = { text: string; agentPromised: boolean };
/** Tajik: «Бале … ҳаст» as the agents write it; «Ин ҳавола: {ссылка}» and «Агенти мо … мефиристад» — tajik-phrasebook, live-agent-phrases.md.
 * `link` null: no link may go out (switch off, no public reel, only an uploaded clip); `videoExists` then says whether
 * the CRM does have a video the agent will send. */
export function renderCustomerPropertyVideoAnswer(shortId: number, link: string | null, language: "ru" | "tg", videoExists = link !== null): CustomerPropertyVideoAnswer {
  if (link) {
    return { agentPromised: false, text: language === "tg"
      ? `Бале, видеои объекти №${shortId} ҳаст. Ин ҳавола: ${link}`
      : `Да, видео объекта №${shortId} есть. Вот ссылка: ${link}` };
  }
  if (videoExists) {
    return { agentPromised: true, text: language === "tg"
      ? `Бале, видеои объекти №${shortId} ҳаст. Агенти мо онро ба шумо мефиристад.`
      : `Да, видео объекта №${shortId} есть. Наш агент пришлёт его вам.` };
  }
  return { agentPromised: true, text: language === "tg"
    ? `Видеои объекти №${shortId}-ро агенти мо ба шумо мефиристад.`
    : `Видео объекта №${shortId} пришлёт вам наш агент.` };
}

/** CRM read for the object in focus. null when the object may not be offered (sold, hidden, deleted) or the asked
 * facts cannot be rendered: the model answers then. */
export async function readCustomerPropertyVideoAnswer(propertyId: string, language: "ru" | "tg", channel: string,
  facts: readonly CustomerPropertyFactKind[] = []): Promise<CustomerPropertyVideoAnswer | null> {
  const row = await prisma.property.findUnique({ where: { id: propertyId },
    select: { ...BOT_OFFER_SELECT, shortId: true, clipVideoUrl: true, clipVideoStatus: true } });
  if (!row || row.status === "SOLD" || !botMayOffer(row)) return null;
  // The uploaded clip is never linked (token link for 24 hours): it only makes «there is a video, the agent will send it» true.
  const reel = customerPropertyVideoLink(row.instagramUrl);
  const hasClip = row.clipVideoStatus === "READY" && !!row.clipVideoUrl;
  const link = customerReplyLink(reel, await customerLinksAllowed(channel));
  const video = renderCustomerPropertyVideoAnswer(row.shortId, link, language, !!reel || hasClip);
  if (!facts.length) return video;
  const known = await readCustomerPropertyFacts(propertyId, channel);
  if (!known || known.availability === "SOLD") return null;
  const rendered = renderCustomerPropertyFacts(known, facts, language).trim();
  return rendered ? { agentPromised: video.agentPromised, text: `${video.text}\n${rendered}` } : null;
}
