/**
 * ПОКУПАТЕЛИ ПОД ОБЪЯВЛЕНИЕ СОБСТВЕННИКА (владелец 24.09.2026).
 *
 * «Если кто-то как собственник прорекламировал себя у нас под постом, а ты
 * предлагаешь ему свои услуги, заодно сразу проверь наших покупателей, кто ищет
 * именно такую квартиру именно в этом районе, и скажи, что у нас есть один-два
 * заинтересованных покупателя. Никаких данных покупателя не даёшь никогда».
 *
 * Объекта в базе ещё нет — есть только текст объявления. Из него читаются цена,
 * площадь, этаж, комнаты (lib/listingAd.ts::parseListingFacts) и место (район по
 * названию, народное название, улица или ориентир с настоящей карты города), и по
 * ним идёт ТОТ ЖЕ подбор, что у «Кому подойдёт» на карточке объекта
 * (routes/matching.ts::findMatchingClientsForProperty). Второго правила «кто
 * подходит» здесь нет.
 *
 * ТРУСЛИВО. Обещание «у нас есть покупатель» собственник проверит первым же
 * звонком. Поэтому без цены числом и без места подбор не идёт вовсе: покупатели
 * без требований к району «подходят» к любому объекту, и без этих двух признаков
 * бот наобещал бы полбазы. Аренда не подбирается: покупателям она не нужна.
 */

import { formatClientCode } from "@royal-home/shared";
import { prisma } from "../db.js";
import { findMatchingClientsForProperty } from "../routes/matching.js";
import { placesMentioned } from "../ai/geoMentions.js";
import { FOLK_PLACES } from "../ai/folkPlaces.js";
import { BW, TAIL } from "../ai/wordBoundary.js";
import { findDistrictIdByName } from "./districtLookup.js";
import { parseListingFacts } from "./listingAd.js";
import { geoMatchKey } from "./geoNormalize.js";
import { logTimeline } from "./timeline.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";

/**
 * Начало пометки `InstagramComment.note` у комментария собственника, которому
 * бот написал в личку (messengers/comments.ts::contactOwner). По нему заявка,
 * заведённая потом в личке, узнаёт, откуда пришёл человек.
 */
export const OWNER_NOTE_PREFIX = "собственник: ";

export interface ListingBuyerMatch {
  /** Сколько ждущих покупателей подходит. 0 — не нашлось или судить не из чего. */
  total: number;
  /** Номера карточек лучших из них (ПК-000123) — ТОЛЬКО для агента, не для собственника. */
  codes: string[];
  /** Где, по нашему прочтению, объект — для подсказки агенту. */
  where: string | null;
}

const NONE: ListingBuyerMatch = { total: 0, codes: [], where: null };

const RENT = new RegExp(`${BW}(сда[её]тся|сдаю|аренд${TAIL}|и[чҷ]ора${TAIL}|в\\s+месяц|дар\\s+мо[хҳ])`, "iu");

const OFFICIAL_DISTRICTS = ["Сино", "Фирдавси", "Шохмансур", "Исмоили Сомони"];

/** Район и точка из текста: сначала точное (улица, ориентир с карты), потом народное название, потом район прямо. */
async function locate(text: string): Promise<{ districtId: string | null; lat: number | null; lng: number | null; where: string | null }> {
  const [place] = await placesMentioned(text, { loose: true }).catch(() => []);
  if (place) {
    const districtId = place.districtName ? ((await findDistrictIdByName(place.districtName)) ?? null) : null;
    return { districtId, lat: place.lat, lng: place.lng, where: place.name };
  }
  const key = ` ${geoMatchKey(text)} `;
  const folk = FOLK_PLACES.find((f) => key.includes(` ${geoMatchKey(f.name)} `));
  if (folk) return { districtId: (await findDistrictIdByName(folk.district)) ?? null, lat: null, lng: null, where: folk.name };
  const official = OFFICIAL_DISTRICTS.find((d) => key.includes(` ${geoMatchKey(d)} `));
  if (official) return { districtId: (await findDistrictIdByName(official)) ?? null, lat: null, lng: null, where: official };
  return { districtId: null, lat: null, lng: null, where: null };
}

export async function matchBuyersForListing(text: string): Promise<ListingBuyerMatch> {
  if (RENT.test(text)) return NONE;
  const facts = parseListingFacts(text);
  if (facts.price == null) return NONE;
  const where = await locate(text);
  if (!where.districtId && where.lat == null) return NONE;

  const matched = await findMatchingClientsForProperty(
    {
      id: "listing",
      price: facts.price,
      currency: facts.currency,
      districtId: where.districtId,
      rooms: facts.rooms,
      areaSqm: facts.areaSqm,
      floor: facts.floor,
      totalFloors: facts.totalFloors,
      lat: where.lat,
      lng: where.lng,
    },
    5
  );
  if (matched.total === 0) return { ...NONE, where: where.where };
  const kinds = await prisma.client.findMany({
    where: { id: { in: matched.items.map((m) => m.id) } },
    select: { id: true, kind: true },
  });
  const kindOf = new Map(kinds.map((k) => [k.id, k.kind]));
  return {
    total: matched.total,
    codes: matched.items.map((m) => formatClientCode(m.shortId, kindOf.get(m.id) ?? "BUYER")),
    where: where.where,
  };
}

/** Одна строка для агента: сколько подходит и кто, без имён и телефонов. */
export function describeBuyerMatch(match: ListingBuyerMatch): string {
  if (match.total === 0) return "Подходящих покупателей в базе сейчас нет (или в объявлении не хватило цены и места).";
  return `Подходящие покупатели в базе: ${match.total} (${match.codes.join(", ")}${match.total > match.codes.length ? " и другие" : ""}).`;
}

const CHANNEL_LABEL: Record<string, string> = { INSTAGRAM: "Instagram", FACEBOOK: "Facebook" };

/**
 * ПОДСКАЗКА АГЕНТУ В КАРТОЧКЕ (владелец 24.09.2026): «этот лид прокомментировал
 * нашу публикацию, потом бот с ним поговорил, и он согласился — это всё должно
 * быть в карточке клиента, и там же подходящих клиентов показывать».
 *
 * Зовётся из личной переписки в момент, когда бот получил номер и завёл заявку
 * (messengers/conversation.ts). Если этому человеку бот писал как собственнику
 * по комментарию, в хронологию карточки ложится одна запись: что он написал под
 * постом, что бот предложил и что он согласился, и номера подходящих покупателей
 * — подбор делается заново, на сегодняшнюю базу. Номера карточек видит только
 * агент: собственнику бот называет лишь «один / два / несколько».
 */
export async function noteOwnerCommentOrigin(clientId: string, channel: string, subscriberId: string): Promise<void> {
  if (channel !== "INSTAGRAM" && channel !== "FACEBOOK") return;
  try {
    const comment = await prisma.instagramComment.findFirst({
      where: { channel, authorId: subscriberId, dmSentAt: { not: null }, note: { startsWith: OWNER_NOTE_PREFIX } },
      orderBy: { dmSentAt: "desc" },
      select: { text: true },
    });
    if (!comment) return;
    const match = await matchBuyersForListing(comment.text).catch((err) => {
      void logSystemError("meta", `Подбор покупателей для собственника из комментария не сделан: ${describeError(err)}`);
      return null;
    });
    await logTimeline({
      clientId,
      actor: { kind: "system", source: "owner-comment" },
      type: "SYSTEM",
      notes:
        `Собственник пришёл из комментария под нашим постом в ${CHANNEL_LABEL[channel]}: «${comment.text.slice(0, 300)}». ` +
        "Объявление скрыто, бот написал ему в личку, предложил съёмку, выкладку на все площадки и продажу через нас — он ответил и оставил номер. " +
        (match ? describeBuyerMatch(match) : "Подбор покупателей не удался — посмотрите «Кому подойдёт» после заведения объекта."),
    });
  } catch (err) {
    void logSystemError("meta", `Подсказка «пришёл из комментария» в карточку ${clientId} не записана: ${describeError(err)}`);
  }
}
