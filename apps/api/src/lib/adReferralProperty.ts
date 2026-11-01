/**
 * Объект рекламы по метке Meta (referral): одна функция для старого бота (messengers/sharedMedia.ts)
 * и нового ядра (lib/customerPropertyRegistry.ts). Вынесено 01.11.2026: ядро брало только Ad-строку и
 * выбрасывало название объявления — клиент из рекламы получал «по этой рекламе объект не определился».
 */
import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import { identifyProperty } from "./propertyMatch.js";
import { captionFooterShortId, matchPropertyByCaption, matchPropertyByFacts, parsePropertyFacts } from "../messengers/sharedPostCard.js";

export const PROPERTY_WITH_DISTRICT = { district: { select: { name: true } } } as const;

export async function propertyById(id: string) {
  return prisma.property.findFirst({ where: { id, deletedAt: null }, include: PROPERTY_WITH_DISTRICT });
}

/** Объект по номеру публикации: ролик (publishedPostIds), фото-пост, история. */
export async function propertyByMediaId(mediaId: string) {
  const direct = await prisma.property.findFirst({
    where: {
      deletedAt: null,
      OR: [
        { publishedPostIds: { path: ["INSTAGRAM"], equals: mediaId } },
        { publishedPostIds: { path: ["FACEBOOK"], equals: mediaId } },
      ],
    },
    orderBy: { createdAt: "desc" },
    include: PROPERTY_WITH_DISTRICT,
  });
  if (direct) return direct;
  const photoPost = await prisma.propertyPhotoPost.findFirst({
    where: { status: "PUBLISHED", OR: [{ mediaId }, { secondaryId: mediaId }] },
    orderBy: { createdAt: "desc" },
    select: { propertyId: true },
  });
  if (photoPost) return propertyById(photoPost.propertyId);
  const story = await prisma.propertyStoryPost.findFirst({
    where: { mediaId },
    orderBy: { publishedAt: "desc" },
    select: { propertyId: true },
  });
  return story ? propertyById(story.propertyId) : null;
}

/**
 * ОБЪЕКТ НАШЕГО ОБЪЯВЛЕНИЯ (02.10.2026) — когда пересылки нет или она не узнана.
 *
 * Порядок тот же, что у пересланного поста: прямая привязка объявления к объекту
 * (Ad.propertyId — её ставит сверка рекламы, lib/ads/adMatching.ts), номер
 * публикации, которой крутится реклама (из метки referral или из таблицы Ad),
 * код поста, и только потом подпись. Подпись рекламы — наша, но шаблоны подписей
 * общие, поэтому и здесь объект берётся только единственным совпадением.
 */
export async function adReferralPropertyId(input: {
  adId?: string;
  adPostId?: string;
  adTitle?: string;
  /** Подпись ролика из вложения сообщения — только когда объявление не прочиталось. */
  mediaCaption?: string;
}): Promise<string | null> {
  try {
    const ad = input.adId
      ? await prisma.ad.findUnique({
          where: { platform_externalId: { platform: "META", externalId: input.adId } },
          select: {
            propertyId: true,
            mediaId: true,
            postShortcode: true,
            caption: true,
            name: true,
            _count: { select: { properties: true } },
          },
        })
      : null;
    // Объявление про НЕСКОЛЬКО объектов («гибкое», 03.10.2026) не говорит, о каком из
    // них пишет клиент: «основной» объект — лишь первый по весу, и отдать его
    // значило бы назвать клиенту не ту квартиру. Остальные пути ниже (пост, название)
    // по-прежнему работают.
    if (ad?.propertyId && ad._count.properties <= 1) {
      const linked = await propertyById(ad.propertyId);
      if (linked) return linked.id;
    }
    /**
     * У ГИБКОГО ОБЪЯВЛЕНИЯ РЕШАЕТ ТОЛЬКО ТО, ЧТО ВИДЕЛ КЛИЕНТ (03.10.2026, вопрос Dan
     * «почему назван агент Ноза»). Номер публикации и подпись в самой метке Meta
     * (adPostId, adTitle) — это ролик, на который человек ответил. А поля объявления
     * в нашей таблице (mediaId, код поста, «№N» в названии, подпись) описывают лишь
     * ОДИН из его роликов, обычно первый: клиент ответил на ролик про 920 000, а
     * объект и агент брались бы от соседнего ролика про 970 000.
     */
    const multi = (ad?._count.properties ?? 0) > 1;
    const adOwn = multi ? null : ad;
    // Номер публикации рекламы бывает и вида «{страница}_{пост}» — пробуем и хвост.
    const ids = new Set<string>();
    for (const raw of [input.adPostId, adOwn?.mediaId]) {
      if (!raw) continue;
      ids.add(raw);
      if (raw.includes("_")) ids.add(raw.slice(raw.lastIndexOf("_") + 1));
    }
    for (const id of ids) {
      const byId = await propertyByMediaId(id);
      if (byId) return byId.id;
    }
    if (adOwn?.postShortcode) {
      const byCode = await prisma.property.findFirst({
        where: { instagramUrl: { contains: adOwn.postShortcode }, deletedAt: null },
        select: { id: true },
      });
      if (byCode) return byCode.id;
    }
    // Название объявления пишет маркетолог: «№557» или «#557» там — номер объекта
    // (то же правило, что у сверки рекламы, lib/ads/adMatching.ts::nameShortId;
    // импортировать оттуда нельзя — тот модуль импортирует messengers/sharedMedia.ts, а тот этот).
    const nameMatch = adOwn?.name?.match(/[#№]\s*(\d+)/);
    const nameId = nameMatch ? Number(nameMatch[1]) : null;
    if (nameId != null) {
      const byName = await prisma.property.findFirst({ where: { shortId: nameId, deletedAt: null }, select: { id: true } });
      if (byName) return byName.id;
    }
    // Подпись вложения берём, лишь если строки объявления нет вовсе: у известного
    // объявления подпись ролика уже учтена его же полями и связями.
    for (const caption of [input.adTitle, adOwn?.caption, ad ? undefined : input.mediaCaption]) {
      if (!caption) continue;
      const footer = captionFooterShortId(caption);
      const byFooter =
        footer != null
          ? await prisma.property.findFirst({ where: { shortId: footer, deletedAt: null }, select: { id: true } })
          : null;
      const facts = parsePropertyFacts(caption);
      const found = byFooter ?? (await matchPropertyByCaption(caption)) ?? (await matchPropertyByFacts(facts));
      if (found) return found.id;
      // Последний путь — общее узнавание по приметам (lib/propertyMatch.ts), то же,
      // что у разбора звонков и робозвонка: ориентир, адрес, ЖК, цена, площадь.
      // Текст рекламы — наш, но догадки и там нет: только уверенный ответ.
      const byClues = await identifyProperty({
        text: caption,
        priceTjs: facts.currency === "TJS" ? facts.price : null,
        areaSqm: facts.areaSqm,
        rooms: facts.rooms,
      });
      if (byClues.propertyId) return byClues.propertyId;
    }
    return null;
  } catch (err) {
    void logSystemError("meta", `Объект рекламы не определён: ${describeError(err)}`);
    return null;
  }
}
