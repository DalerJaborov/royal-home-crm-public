import { BW, EW } from "../ai/wordBoundary.js";
import { extractMentionedPropertyNumber } from "../ai/propertyMentionGuard.js";
import { identifyProperty } from "./propertyMatch.js";
import { resolveCallPropertyHint } from "./telephony/resolveCallProperty.js";

/**
 * КАКОЙ ОБЪЕКТ НАЗВАЛ КЛИЕНТ В ЧАТЕ (24.09.2026, проход по классам после
 * ОБ-000118; решение владельца «Все задачи продолжаем» по карточке «Отдавать»).
 *
 * Раньше чат понимал только номер («объект №112»). Звонок и робозвонок уже
 * узнают объект по описанию (lib/propertyMatch.ts::identifyProperty), а бот —
 * нет: «видел у вас двушку у Бодомзора за 300 000» он понимал как запрос,
 * показывал похожие, и лид уходил агенту показанной замены.
 *
 * ПОЧЕМУ НУЖЕН ПОВОД. Покупатель чаще описывает ЖЕЛАНИЕ («двушку у Бодомзора до
 * 300»), а шаг «объект назван явно» безусловный и перебивает и показ, и
 * совпадение по запросу. Поэтому по описанию узнаём, только когда человек прямо
 * говорит про объявление («видел», «в рекламе», «ваше объявление», «эту
 * квартиру», «дидам», «эълон»), и только уверенно (место + цена/приметы, отрыв
 * от второго кандидата — правила identifyProperty).
 *
 * МЕСТО — ФРАЗОЙ ПОСЛЕ ПРЕДЛОГА, А НЕ ВСЕМ СООБЩЕНИЕМ. Слова всей реплики
 * («здравствуйте», «комнатная», «сколько») совпадали бы со словами заголовков
 * карточек и «находили» место там, где его нет.
 */

const SEEN_LISTING = new RegExp(
  [
    `${BW}(?:видел|видела|увидел|увидела|видели)${EW}`,
    `${BW}(?:рекла\\p{L}*|объявлени\\p{L}*|пост\\p{L}{0,2})${EW}`,
    `${BW}(?:ваш[уеа]?|эт[уоа]|этот)\\s+(?:квартир\\p{L}*|дом\\p{L}*|участ\\p{L}*|объект\\p{L}*)`,
    `${BW}(?:дидам|дидем|дидаам|эълон\\p{L}*|реклама\\p{L}*)${EW}`,
  ].join("|"),
  "iu"
);

/** Предлоги места: «у Бодомзора», «возле фабрики Гулдаст», «назди бозори Корвон». */
const PLACE_CUES = new Set(["у", "возле", "около", "напротив", "рядом", "назди", "наздики", "пеши"]);
/** После «у» чаще всего не место, а «у вас есть»: такие слова место не начинают. */
const NOT_A_PLACE = new Set(["вас", "нас", "тебя", "меня", "них", "него", "неё", "нее", "шумо", "мо", "с", "со"]);
/** До трёх слов места; обрывается на знаке препинания, числе и следующем предлоге. */
const PLACE_WORDS = 3;

export function mentionsSeenListing(text: string): boolean {
  return SEEN_LISTING.test(text);
}

export function placePhrases(text: string): string | null {
  const phrases: string[] = [];
  // Знаки препинания — отдельными «словами», чтобы место на них обрывалось.
  const tokens = text.toLowerCase().match(/[\p{L}][\p{L}\d-]*|[.,!?;:()«»"]|\d+/gu) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    if (!PLACE_CUES.has(tokens[i])) continue;
    let j = i + 1;
    if (tokens[i] === "рядом" && (tokens[j] === "с" || tokens[j] === "со")) j++;
    const phrase: string[] = [];
    while (j < tokens.length && phrase.length < PLACE_WORDS) {
      const w = tokens[j];
      if (!/^\p{L}/u.test(w) || PLACE_CUES.has(w) || (phrase.length === 0 && NOT_A_PLACE.has(w))) break;
      phrase.push(w);
      j++;
    }
    if (phrase.length) phrases.push(phrase.join(" "));
  }
  return phrases.length ? phrases.join(" ") : null;
}

/** Что из черновика бота годится в приметы (всё необязательно). */
export interface BotDraftClues {
  districtName?: string;
  type?: string;
  rooms?: number;
  budgetMax?: number;
}

/**
 * id объекта, если клиент назвал его номером или уверенно описал объявление;
 * иначе null. Не бросает: узнавание — подсказка раздаче, а не условие ответа.
 */
export async function resolveBotPropertyMention(text: string, draft: BotDraftClues): Promise<string | null> {
  const number = extractMentionedPropertyNumber(text);
  if (number) return resolveCallPropertyHint(number);
  if (!mentionsSeenListing(text)) return null;
  const place = placePhrases(text);
  if (!place) return null;
  const found = await identifyProperty({
    place,
    districtName: draft.districtName ?? null,
    type: draft.type ?? null,
    rooms: draft.rooms ?? null,
    budgetTjs: draft.budgetMax ?? null,
  });
  return found.via === "description" ? found.propertyId : null;
}
