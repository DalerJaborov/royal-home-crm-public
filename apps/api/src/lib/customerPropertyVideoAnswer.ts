/**
 * «А ВИДЕО ЭТОЙ КВАРТИРЫ ЕСТЬ?» — ОТВЕТ СЕРВЕРА, А НЕ МОДЕЛИ (16.11.2026).
 *
 * Живой случай Instagram 16.11, 21:29–21:30: клиент переслал наш пост объекта №178 и спросил
 * «Хами хонара видеоша дорен» («видео этой квартиры у вас есть?»). Видео у объекта в CRM есть
 * (опубликованный рилс), но у ядра бота нет ни инструмента, ни факта «видео»: ответить могла только
 * модель, и правдиво — никак. Поэтому решает код, по данным CRM:
 *  - у объекта есть опубликованное видео (рилс Instagram) — даём ссылку на него;
 *  - видео нет — честно говорим, что видео пришлёт агент, и ход зовёт ответственного через одну
 *    дверь «бот пообещал агента» (signalStaffFollowUp → alertClientWaiting): обещание правдиво,
 *    только если человек об этом узнаёт.
 * Срабатывает только на короткую просьбу о видео про объект, который уже определён (фокус), и только
 * когда в той же фразе нет другого вопроса (цена, адрес…) — смешанный вопрос остаётся модели.
 */
import { prisma } from "../db.js";
import { botMayOffer, BOT_OFFER_SELECT } from "./propertyMatch.js";
import { safeCustomerPropertyLink } from "./customerPropertyUrls.js";

const W = (alternatives: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, "iu");
/** «видео», «видеоша», «видеоро», «видеош», «video», «ролик». */
const VIDEO_WORD = W("видео\\p{L}*|video\\p{L}*|ролик\\p{L}*|видос\\p{L}*");
/** The customer ASKS for it (ru/tg), not offers his own: «есть / пришлите / покажите», «доред / дорен / ҳаст / равон кунед». */
const REQUEST_CUE = W("есть|имеется|пришлите|пришли|скиньте|скинь|киньте|отправьте|отправь|покажите|покажи|дайте|можно|хочу|нужн\\p{L}*|" +
  "доред|дорен|дорӣ|дори|дорин|ҳаст|хаст|ҳастай|хастай|бор|равон\\s+кунед|равон\\s+кунен|фиристед|фиристен|партоед|партоен|мумкин|лозим|даркор|" +
  // The same in Latin letters, as customers often type Tajik and Russian.
  "dored|doren|dorin|hast|bor|est|mozhno|mojno|ravon\\s+kuned|firisted|skinte|otpravte|pokazhite");
/** Own material («сниму / пришлю видео», «видео мефиристам») is a seller's offer, never a request for ours. */
const OWN_MATERIAL = W("сниму|сняла?|пришлю|скину|отправлю|запишу|мефиристам|равон\\s+мекунам|гирифтам|мегирам|партоям");
/** Another question in the same words stays with the model: price, address, area, floor, rooms, viewing, discount. */
const OTHER_QUESTION = W("цен\\p{L}*|стоимост\\p{L}*|стоит|нарх\\p{L}*|адрес\\p{L}*|где|куҷо\\p{L}*|кучо\\p{L}*|площад\\p{L}*|масоҳат\\p{L}*|" +
  "этаж\\p{L}*|ошён\\p{L}*|комнат\\p{L}*|ҳуҷра\\p{L}*|хучра\\p{L}*|скидк\\p{L}*|торг\\p{L}*|показ\\p{L}*|посмотреть|дидан|ипотек\\p{L}*|рассрочк\\p{L}*|фото\\p{L}*|сурат\\p{L}*|акс\\p{L}*");

export function customerPropertyVideoRequested(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 160 || /https?:\/\//iu.test(t) || /\d{5,}/u.test(t.replace(/[\s()+-]/gu, ""))) return false;
  return VIDEO_WORD.test(t) && REQUEST_CUE.test(t) && !OWN_MATERIAL.test(t) && !OTHER_QUESTION.test(t);
}

/** A published Instagram reel/IGTV of THIS object, as the CRM stores it (Property.instagramUrl). A photo post is not a video. */
export function customerPropertyVideoLink(instagramUrl: string | null | undefined): string | null {
  if (!instagramUrl) return null;
  let path: string;
  try { path = new URL(instagramUrl.trim()).pathname; } catch { return null; }
  if (!/^\/(?:[A-Za-z0-9._]+\/)?(?:reel|reels|tv)\/[A-Za-z0-9_-]+\/?$/u.test(path)) return null;
  return safeCustomerPropertyLink(instagramUrl.trim());
}

export type CustomerPropertyVideoAnswer = { text: string; agentPromised: boolean };
/** Tajik: «Бале … ҳаст» as the agents write it in this chat; «Ин ҳавола: {ссылка}» — tajik-phrasebook, live-agent-phrases.md. */
export function renderCustomerPropertyVideoAnswer(shortId: number, link: string | null, language: "ru" | "tg"): CustomerPropertyVideoAnswer {
  if (link) {
    return { agentPromised: false, text: language === "tg"
      ? `Бале, видеои объекти №${shortId} ҳаст. Ин ҳавола: ${link}`
      : `Да, видео объекта №${shortId} есть. Вот ссылка: ${link}` };
  }
  return { agentPromised: true, text: language === "tg"
    ? `Видеои объекти №${shortId}-ро агенти мо ба шумо мефиристад.`
    : `Видео объекта №${shortId} пришлёт вам наш агент.` };
}

/** CRM read for the object in focus. null when the object may not be offered (sold, hidden, deleted): the model answers then. */
export async function readCustomerPropertyVideoAnswer(propertyId: string, language: "ru" | "tg"): Promise<CustomerPropertyVideoAnswer | null> {
  const row = await prisma.property.findUnique({ where: { id: propertyId },
    select: { ...BOT_OFFER_SELECT, shortId: true, instagramUrl: true } });
  if (!row || row.status === "SOLD" || !botMayOffer(row)) return null;
  return renderCustomerPropertyVideoAnswer(row.shortId, customerPropertyVideoLink(row.instagramUrl), language);
}
