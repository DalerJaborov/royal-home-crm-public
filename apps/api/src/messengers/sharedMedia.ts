import { prisma } from "../db.js";
import { MARKET_TYPE_LABELS, PROPERTY_TYPE_LABELS, propertyHasMarket, propertyHeadline, type MarketType, type PropertyType } from "@royal-home/shared";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { isInstagramLink } from "../lib/instagramLink.js";
import { firstForeignLink, firstOwnSiteLink, linkPreview } from "../lib/linkPreview.js";
import { detectSpam } from "../lib/incomingSpam.js";
import { crmPropertyIdFromUrl, siteListingIdFromUrl, mentionedCardNumber } from "../lib/propertyMentionFromText.js";
import { propertyOwnerAgentId } from "../lib/propertyOwner.js";
import { adReferralPropertyId, propertyById, propertyByMediaId, PROPERTY_WITH_DISTRICT } from "../lib/adReferralProperty.js";
import { resolvePropertyFromPageUrl } from "../lib/resolvePropertyFromPageUrl.js";
import { noticeInterestByConversation } from "../lib/propertyInterestNotice.js";
import { linkConversationPropertyByChannel } from "../lib/propertyVoice/linkConversation.js";
import { customerTransportInput, findScopedBotConversation, resolveCustomerEndpoint,
  type CustomerTransportHint, type CustomerTransportReference } from "../lib/customerConversationScope.js";
import { updatePublishedMarks } from "../lib/publishedMarks.js";
import { findAgentsWithPermission } from "../lib/recipients.js";
import { notifyFeedOnly } from "../lib/notifications.js";
import { channelLabel } from "@royal-home/shared";
import { expandLinkFields, facebookMediaIds } from "./sharedLinks.js";
import {
  captionFooterShortId,
  looksLikeHousing,
  matchPropertyByCaption,
  matchPropertyByFacts,
  parsePropertyFacts,
} from "./sharedPostCard.js";

// Правило «похоже на жильё» живёт рядом с чтением карточки (оно нужно и там);
// вебхук и тесты берут его отсюда, как раньше.
export { looksLikeHousing };
import { districtByPoint } from "../lib/propertyDistrict.js";
import { BW, EW, TAIL } from "../ai/wordBoundary.js";

/**
 * Клиент прислал наш пост/рилс или ответил на нашу историю.
 *
 * В Instagram это происходит постоянно: человек листает ленту, видит квартиру,
 * пересылает её в директ со словами «свободна?» — или отвечает на историю одним
 * смайликом. Раньше такое сообщение доходило до бота как «[вложение: ig_reel]»
 * или вовсе как пустое, и он отвечал невпопад либо молчал. Клиент, показавший
 * пальцем на конкретную квартиру, — самый горячий из всех, и терять его нельзя.
 *
 * Здесь из вложения достаётся ссылка, по ней ищется объект в базе, и разговор
 * получает нормальную человеческую подводку: «клиент спрашивает про ЭТУ квартиру,
 * вот её цена и район».
 */

/** Короткий код поста Instagram: instagram.com/reel/CODE, /p/CODE, /tv/CODE.
 *  С 02.10.2026 — и с именем аккаунта в адресе (instagram.com/royal.home.tj/reel/CODE,
 *  так копирует ссылку приложение) и коротким доменом instagr.am: раньше такие
 *  ссылки на наш же пост не узнавались вовсе (разбор 02.10, аудит узнавания, п. 8). */
export function instagramShortcode(url: string | undefined | null): string | null {
  if (!url) return null;
  // «share/» — не имя аккаунта: в instagram.com/share/reel/<токен> после reel/ лежит
  // токен ссылки, а не код поста (10.10.2026). Код достаётся из адреса, куда такая
  // ссылка ведёт (messengers/sharedLinks.ts::expandLinkFields).
  const match = url.match(/(?:instagram\.com|instagr\.am)\/(?:(?!share\/)[A-Za-z0-9._]{1,30}\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i);
  return match ? match[1] : null;
}

// Разбор ссылок на наш сайт переехал в lib/propertyMentionFromText.ts (одно правило для всех каналов).
export { crmPropertyIdFromUrl, siteListingIdFromUrl };

const WITH_DISTRICT = PROPERTY_WITH_DISTRICT;
// Объект рекламы ищет и новое ядро клиентского бота — функция живёт в общем модуле, отсюда её берут, как раньше.
export { adReferralPropertyId };

/** Сколько карточек просматриваем, выясняя причину промаха. Объектов в базе пока
 *  десятки, но предел обязателен: запись в журнал не имеет права вычитывать таблицу
 *  целиком — она делается в живом ходе разговора с клиентом. */
const MISFILLED_SCAN_LIMIT = 300;
/** Сколько номеров показать в самой записи — дальше её перестают читать. */
const MISFILLED_SHOWN = 15;

/**
 * Почему пересланную публикацию не опознали — с НОМЕРАМИ карточек, которые это чинят.
 *
 * Прежняя запись называла код поста («код Db8pQABqyif не найден…»). Код в каждой
 * пересылке свой, поэтому дедупликация в lib/systemError.ts, сверяющая текст целиком,
 * не срабатывала НИ РАЗУ: за неделю накопилось десять одинаковых по смыслу записей, и
 * все они будили директора утренней сводкой. Здесь текст постоянный, а сам код уходит
 * в поле адреса — там он и полезнее, ссылкой можно открыть пост.
 *
 * Причин промаха две, и лечатся они по-разному. Различить их изнутри разговора нельзя,
 * а по базе — можно: если в карточках лежат ссылки не на Instagram, узнавание по ним
 * не сработает никогда, и чинится это заменой ссылки. Если же все ссылки правильные,
 * значит поста нет ни у одного объекта, и лечится это заведением карточки.
 */
/** Id переписки по паре «канал + собеседник»; диалога ещё нет (первое сообщение) — null. */
async function conversationIdOf(input: { channel?: string; recipientId?: string; accountId?: string | null; transport?: CustomerTransportReference }): Promise<string | null> {
  if (!input.channel || !input.recipientId) return null;
  try {
    const conv = await findScopedBotConversation(customerTransportInput(input.channel, input.recipientId, input.transport ?? input.accountId));
    return conv?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Строка руководителю «обращение по неизвестной публикации» (P0-2, 10.10.2026).
 * Одна на переписку: тег без времени, повтор обновляет ту же строку ленты.
 * Без пуша в телефон — как и прочие сигналы руководству (владелец 20.09.2026).
 * Возвращает true, если строка ушла (тогда бот вправе сказать «передал коллеге»).
 */
async function raiseUnknownShare(input: SharedMediaInput, conversationId: string | null): Promise<boolean> {
  if (!input.channel || !input.recipientId) return false;
  // Явно чужое и без слов о деле — не дело (тот же признак, что у молчания на чужой ролик).
  if (captionSaysForeign(input.postTitle) && !clientTalksBusiness(input.text)) return false;
  try {
    const supervisors = await findAgentsWithPermission("clients.assign");
    if (supervisors.length === 0) return false;
    const where = channelLabel(input.channel) || input.channel;
    await notifyFeedOnly(supervisors, {
      kind: "lead",
      title: "📨 Обращение по неизвестной публикации",
      body:
        `В ${where} клиент переслал публикацию, а объект по ней не узнан. Посмотрите пост в переписке, ` +
        `ответьте клиенту и привяжите публикацию к объекту — бот обещал, что коллега посмотрит.`,
      url: conversationId ? `/messages?open=${conversationId}` : "/messages",
      tag: `unknown-share-${conversationId ?? `${input.channel}-${input.recipientId}`}`,
    });
    return true;
  } catch (err) {
    void logSystemError("meta", `Обращение по неизвестной публикации не передано руководителю: ${describeError(err)}`, {
      dedupKey: "unknown-share-task",
    });
    return false;
  }
}

async function reportUnmatchedShare(code: string, conversationId: string | null = null): Promise<void> {
  try {
    const withLink = await prisma.property.findMany({
      where: { deletedAt: null, instagramUrl: { not: null } },
      select: { shortId: true, instagramUrl: true },
      orderBy: { shortId: "asc" },
      take: MISFILLED_SCAN_LIMIT,
    });
    // Пустую строку считаем НЕзаполненным полем, а не ошибкой: про такие объекты
    // уже говорят блокировки продажи (lib/propertyPipeline.ts) и фильтр «без видео».
    const misfilled = withLink.filter((p) => p.instagramUrl?.trim() && !isInstagramLink(p.instagramUrl));

    const shown = misfilled.slice(0, MISFILLED_SHOWN).map((p) => `№${p.shortId}`).join(", ");
    const rest = misfilled.length > MISFILLED_SHOWN ? ` и ещё ${misfilled.length - MISFILLED_SHOWN}` : "";

    await logSystemError(
      "meta",
      misfilled.length
        ? `Пересланная публикация не опознана: её кода нет ни в одной карточке. У ${misfilled.length} объектов ` +
            `в поле «Ссылка на публикацию Instagram» лежит НЕ адрес Instagram (${shown}${rest}) — по ним узнавание ` +
            `не сработает никогда, и клиенту в Instagram бот такую ссылку больше не отправляет. Замените её на ` +
            `адрес самого поста: instagram.com/reel/… или instagram.com/p/….`
        : `Пересланная публикация не опознана: её кода нет ни в одной карточке, при этом все заполненные ссылки ` +
            `ведут на Instagram. Значит этого поста нет ни у одного объекта: карточка не заведена, поле пустое ` +
            `или пост перезалит заново.`,
      // Переписка — параметром адреса, а не в тексте: текст постоянный ради дедупа журнала.
      { url: `https://www.instagram.com/reel/${code}/${conversationId ? `?conversation=${conversationId}` : ""}` }
    );
  } catch (err) {
    void logSystemError("meta", `Пересланная публикация не опознана, а причину выяснить не удалось: ${describeError(err)}`);
  }
}

/** Номер карточки в подписи под своей же публикацией: тем же способом, каким бот
 *  сам называет объект клиенту (см. describeProperty и propertyOfferText.ts —
 *  «№1042» единый для всей CRM формат ссылки на карточку). Агентство обычно
 *  переносит этот номер и в подпись под постом в Instagram. */
const CAPTION_SHORTID_RE = /№\s*(\d+)/;

/** Номер карточки из подписи, если он там есть. Используется и здесь (узнавание в
 *  диалоге), и в одноразовой починке lib/backfillInstagramUrls.ts — код один,
 *  правило «что считать номером карточки» не должно разойтись по двум местам. */
export function captionShortId(caption: string | undefined | null): number | null {
  const match = caption?.match(CAPTION_SHORTID_RE);
  if (!match) return null;
  const shortId = Number(match[1]);
  return Number.isFinite(shortId) ? shortId : null;
}

/** Карточка по номеру из подписи — единственное совпадение или ничего: гадать
 *  нельзя, ошибка здесь означает, что клиенту назовут чужую цену. */
async function propertyByCaptionNumber(caption: string | undefined) {
  const shortId = captionShortId(caption);
  if (shortId == null) return null;
  return prisma.property.findFirst({ where: { shortId, deletedAt: null }, include: WITH_DISTRICT });
}

/**
 * ПУБЛИКАЦИИ, КОТОРЫЕ ПОИСК РАНЬШЕ НЕ СМОТРЕЛ (10.10.2026, аудит P0-2, §4 п.3):
 * повтор ролика (PropertySocialRepost), подборка ОДНОГО объекта (SocialDigestPost) и
 * креатив нашей рекламы (Ad.postShortcode / Ad.mediaId). Реклама и повтор в нашей
 * ленте /me/media не видны, поэтому пересылка такого поста кончалась «не опознана».
 * Подборка из нескольких объектов и «гибкое» объявление на несколько объектов
 * объекта не дают: какой из них имел в виду клиент, неизвестно — гадать нельзя.
 */
async function propertyByOtherPublication(input: { code?: string; mediaIds?: string[] }) {
  const ids = new Set<string>();
  for (const raw of input.mediaIds ?? []) {
    ids.add(raw);
    // Номер публикации Facebook бывает и вида «{страница}_{пост}» — пробуем и хвост.
    if (raw.includes("_")) ids.add(raw.slice(raw.lastIndexOf("_") + 1));
  }
  const idList = [...ids];
  const publicationWhere = [
    ...(input.code ? [{ permalink: { contains: input.code } }] : []),
    ...(idList.length ? [{ mediaId: { in: idList } }, { secondaryId: { in: idList } }] : []),
  ];
  if (publicationWhere.length === 0) return null;

  const repost = await prisma.propertySocialRepost.findFirst({
    where: { OR: publicationWhere },
    orderBy: { createdAt: "desc" },
    select: { propertyId: true },
  });
  const viaRepost = repost ? await propertyById(repost.propertyId) : null;
  if (viaRepost) return viaRepost;

  const digest = await prisma.socialDigestPost.findFirst({
    where: { OR: publicationWhere },
    orderBy: { createdAt: "desc" },
    select: { propertyIds: true },
  });
  if (digest?.propertyIds.length === 1) {
    const viaDigest = await propertyById(digest.propertyIds[0]!);
    if (viaDigest) return viaDigest;
  }

  const adWhere = [
    ...(input.code ? [{ postShortcode: input.code }] : []),
    ...(idList.length ? [{ mediaId: { in: idList } }] : []),
  ];
  const ad = await prisma.ad.findFirst({
    where: { OR: adWhere },
    orderBy: { lastSyncedAt: "desc" },
    select: { propertyId: true, properties: { select: { propertyId: true }, take: 2 } },
  });
  if (!ad) return null;
  const single = ad.properties.length === 1 ? ad.properties[0]!.propertyId : ad.properties.length === 0 ? ad.propertyId : null;
  return single ? propertyById(single) : null;
}

/**
 * НОМЕР ПУБЛИКАЦИИ INSTAGRAM — У КАРТОЧКИ (10.10.2026, аудит P0-2 / P1-2: он есть у
 * 1 объекта из 52 при 32 опубликованных). Автопубликация из CRM пишет его сама
 * (videoHandoff.ts::applySucceededPublishResults), но ролики, выложенные руками
 * или до 02.10, его не имеют — и узнавание по номеру из вложения Meta для них
 * мертво. Пересланный пост, найденный по коду в карточке И в НАШЕЙ ленте, даёт
 * этот номер из первых рук (Graph API нашего аккаунта): дописываем его, если
 * ключа ещё нет. Чужой номер (из вложения Meta) сюда не попадает: ночная сверка
 * (publishedChannelsAudit.ts) по нему проверяет, жив ли пост, и неверный номер
 * снял бы канал. Запись — условная, через общий lib/publishedMarks.ts.
 */
async function rememberInstagramMediaId(property: { id: string }, mediaId: string): Promise<void> {
  try {
    await updatePublishedMarks(property.id, (current) =>
      current.postIds.INSTAGRAM ? null : { channels: current.channels, postIds: { ...current.postIds, INSTAGRAM: mediaId } }
    );
  } catch (err) {
    void logSystemError("meta", `Номер публикации Instagram у объекта не сохранён: ${describeError(err)}`, {
      dedupKey: "remember-instagram-media-id",
    });
  }
}

/**
 * Слова, рядом с которыми «№N» в СВОБОДНОМ ТЕКСТЕ КЛИЕНТА действительно значит
 * номер нашей карточки, а не что-то ещё («паспорт №1234567», «заказ №12», «дом
 * №5, квартира 3» — про свой адрес, не про объект в базе).
 *
 * НАЙДЕНО АДВЕРСАРИАЛЬНОЙ ПРОВЕРКОЙ 21.08.2026: `propertyByCaptionNumber`
 * задумывался для ДОВЕРЕННОГО источника (наша же подпись под постом,
 * healInstagramUrl) — там совпадение практически гарантированно верное. Текст
 * клиента источник НЕдоверенный: «№» само по себе слово не отличает разговор
 * про объект от случайного упоминания. При маленьких shortId (в начале
 * нумерации агентства) совпадение более вероятно, а ошибка маршрутизации
 * означает, что лид уйдёт владельцу ЧУЖОГО, случайно совпавшего объекта.
 */
const PROPERTY_MENTION_CONTEXT_RE = /кварт|объект|обьект|дом|квартир|номер\s*объ|листинг|недвиж|(?<![\p{L}])(?:об|ob)-?\d/iu;

/** Строгая версия captionShortId для текста клиента: тот же формат «№N», но
 *  только рядом со словом, явно указывающим на объект недвижимости. */
// ОДНО ПРАВИЛО С ЧАТОМ (ревизия 02.10.2026). Своё «№N рядом со словом дом/кварт»
// пропускало ровно адрес продавца («продаю квартиру в доме №25» → объект 25), а
// понятное чату «ОБ-000118» не узнавало. Теперь номер читает та же функция, что и
// переписка (ai/propertyMentionGuard.ts): «объект N», «№N» не после адреса, «ОБ-…».
function clientMentionedPropertyNumber(text: string | undefined | null, linkText?: string): number | null {
  if (!text || !PROPERTY_MENTION_CONTEXT_RE.test(text)) return null;
  // Число из ссылки сайта (/listing/45) — id сайта, а не номер карточки (lib/propertyMentionFromText.ts).
  const n = mentionedCardNumber(text, linkText ?? text);
  return n ? Number(n) : null;
}

/**
 * САМОИСЦЕЛЕНИЕ поля «Ссылка на публикацию Instagram» — тем же приёмом, что и
 * reconcileInstagramAccountIds в messengers/accounts.ts для идентификаторов
 * аккаунтов: мы только что доказали связь другим путём (номер в подписи), и
 * сохраняем её, чтобы следующая пересылка ЭТОГО ЖЕ поста нашлась быстрым путём —
 * прямым совпадением кода, без похода в Graph API и без подписи.
 *
 * На проде у 17 карточек в этом поле лежит не адрес Instagram (t.me или пусто) —
 * ради них это и написано: правится само, при первом же пересланном посте.
 */
/** @returns true, если ссылка была действительно изменена (вызывающий может
 *  отличить «уже была верной» от «поправлена только что»). */
export async function healInstagramUrl(propertyId: string, currentUrl: string | null, permalink: string): Promise<boolean> {
  const code = instagramShortcode(permalink);
  if (!code || (currentUrl && currentUrl.includes(code))) return false;
  try {
    await prisma.property.update({ where: { id: propertyId }, data: { instagramUrl: permalink } });
    console.warn(
      `[объекты] Ссылка на публикацию Instagram у карточки ${propertyId} восстановлена автоматически (по номеру в подписи)`
    );
    return true;
  } catch (err) {
    void logSystemError("meta", `Автопривязка публикации Instagram к карточке ${propertyId} не сохранилась: ${describeError(err)}`);
    return false;
  }
}

/**
 * Объект, на который показывает клиент. Порядок проверок — от самого точного
 * признака к самому общему; первое совпадение выигрывает.
 *
 * Ссылку ищем И в тексте, И во вложении: бот отдаёт объекты приоритетно ссылкой на
 * пост Instagram (см. propertyLink в ai/leadQualifier.ts), и человек чаще копирует
 * её текстом, чем пересылает саму публикацию.
 */
async function findSharedProperty(input: SharedMediaInput) {
  const text = input.text;
  const attachmentUrl = input.attachmentUrl;
  const ownMedia = { permalink: input.ownPermalink, caption: input.ownCaption };
  /**
   * ССЫЛКУ НА НАШ ОБЪЕКТ ИЩЕМ И ВО ВЛОЖЕНИИ (21.09.2026).
   *
   * Код публикации Instagram ниже искался в ОБОИХ полях, а ссылка на наш сайт —
   * только в тексте. Между тем «поделиться» в Instagram присылает адрес именно
   * вложением, и текста при этом часто нет вовсе: человек пересылал НАШУ же
   * страницу объекта, а бот отвечал ему «видео у меня не открылось».
   */
  // Обёртки переходов и ссылки «поделиться» разворачиваются здесь же (10.10.2026,
  // P0-2/P1-4, messengers/sharedLinks.ts): дальше по ним работают прежние разборщики.
  const linkFields = await expandLinkFields(`${text ?? ""} ${attachmentUrl ?? ""}`);

  const crmId = crmPropertyIdFromUrl(linkFields);
  if (crmId) {
    const byCrmId = await prisma.property.findFirst({
      where: { id: crmId, deletedAt: null },
      include: WITH_DISTRICT,
    });
    if (byCrmId) return { property: byCrmId, source: "site" as const };
  }

  const siteId = siteListingIdFromUrl(linkFields);
  if (siteId != null) {
    const bySiteId = await prisma.property.findFirst({
      where: { siteListingId: siteId, deletedAt: null },
      include: WITH_DISTRICT,
    });
    if (bySiteId) return { property: bySiteId, source: "site" as const };
  }

  // Сверяем по короткому коду, а не по строке целиком: у одной и той же публикации
  // адреса отличаются хвостом (?igsh=…) и доменом (instagram.com / www.instagram.com).
  const code =
    instagramShortcode(attachmentUrl) ??
    instagramShortcode(text) ??
    instagramShortcode(ownMedia?.permalink) ??
    instagramShortcode(linkFields);
  if (code) {
    const byPost = await prisma.property.findFirst({
      where: { instagramUrl: { contains: code }, deletedAt: null },
      include: WITH_DISTRICT,
    });
    if (byPost) {
      // Номер публикации из НАШЕЙ ленты — у карточки, где его нет (P0-2, 10.10.2026).
      if (input.ownMediaId && instagramShortcode(input.ownPermalink) === code) {
        await rememberInstagramMediaId(byPost, input.ownMediaId);
      }
      return { property: byPost, source: "post" as const };
    }
    // Фото-пост (карусель без ролика) пишет свой адрес не в карточку, а в
    // PropertyPhotoPost — тем же приёмом ищут его комментарии (messengers/comments.ts).
    const byPhotoPost = await prisma.propertyPhotoPost.findFirst({
      where: { channel: "INSTAGRAM", status: "PUBLISHED", permalink: { contains: code } },
      orderBy: { createdAt: "desc" },
      select: { propertyId: true },
    });
    const viaPhotoPost = byPhotoPost ? await propertyById(byPhotoPost.propertyId) : null;
    if (viaPhotoPost) return { property: viaPhotoPost, source: "post" as const };
    // Повтор ролика, подборка с одним объектом и креатив нашей рекламы — свои
    // таблицы, которые поиск раньше не смотрел вовсе (P0-2, 10.10.2026: 3 из 133
    // неопознанных кодов за месяц — наша же реклама).
    const byOtherPost = await propertyByOtherPublication({ code });
    if (byOtherPost) return { property: byOtherPost, source: "post" as const };
  }

  /**
   * ПОСТ НАШЕГО КАНАЛА TELEGRAM (02.10.2026): t.me/<канал>/<номер>. Номер
   * сообщения автопубликация пишет в Property.publishedPostIds.TELEGRAM; канал
   * сверяем с Настройками, иначе одинаковый номер в чужом канале дал бы чужой объект.
   */
  const tgPost = linkFields.match(/t\.me\/([A-Za-z0-9_]{4,})\/(\d+)/i);
  if (tgPost) {
    const settings = await prisma.settings.findFirst({ select: { telegramChannelId: true } });
    const ourChannel = settings?.telegramChannelId?.trim().replace(/^@/, "").toLowerCase();
    if (ourChannel && ourChannel === tgPost[1]!.toLowerCase()) {
      const byTelegram = await prisma.property.findFirst({
        where: { deletedAt: null, publishedPostIds: { path: ["TELEGRAM"], equals: tgPost[2] } },
        orderBy: { createdAt: "desc" },
        include: WITH_DISTRICT,
      });
      if (byTelegram) return { property: byTelegram, source: "post" as const };
    }
  }

  /**
   * НОМЕР ПУБЛИКАЦИИ (02.10.2026) — самая прочная связь из всех: мы публикуем
   * посты из CRM сами, и номер, который вернул Instagram, лежит у объекта в
   * Property.publishedPostIds.INSTAGRAM (фото-пост и история — в своих таблицах).
   * Номер приходит либо прямо во вложении (reel_video_id / ig_post_media_id), либо
   * из нашей ленты, когда пост нашёлся по коду. Ни ссылка в карточке, ни подпись
   * для этого не нужны.
   */
  // Пост или ролик нашей страницы Facebook ссылкой: номер в адресе — тот же, что
  // автопубликация пишет в publishedPostIds.FACEBOOK (как ищут комментарии).
  // Все форматы ссылок Facebook — общим разборщиком (messengers/sharedLinks.ts).
  const mediaIds = [
    ...new Set([input.mediaId, input.ownMediaId, ...facebookMediaIds(linkFields)].filter((id): id is string => Boolean(id))),
  ];
  for (const mediaId of mediaIds) {
    const byMediaId = await propertyByMediaId(mediaId);
    if (byMediaId) return { property: byMediaId, source: "post" as const };
  }
  if (mediaIds.length > 0) {
    const byOtherPost = await propertyByOtherPublication({ mediaIds });
    if (byOtherPost) return { property: byOtherPost, source: "post" as const };
  }

  /**
   * ПОЛЕ ПУСТОЕ ИЛИ ИСПОРЧЕНО, НО ПОСТ ТОЧНО НАШ. `ownMedia.permalink` заполняется
   * только тогда, когда Graph API нашёл этот код в НАШЕЙ ленте (messengers/ownMedia.ts) —
   * то есть источник не строка из карточки, а собственный API Instagram, как и просил
   * владелец («мы через API брали»). Если номер карточки в подписи совпал ровно с
   * одним объектом — связь так же надёжна, как ручная ссылка, и её стоит запомнить.
   */
  if (ownMedia?.permalink) {
    const byCaption = await propertyByCaptionNumber(ownMedia.caption);
    if (byCaption) {
      // Дожидаемся: это обычная запись в базе, а не поход наружу — задержки
      // ради надёжности здесь дороже риска чуть удлинить ответ бота.
      await healInstagramUrl(byCaption.id, byCaption.instagramUrl, ownMedia.permalink);
      return { property: byCaption, source: "post" as const };
    }
  }

  /**
   * ПОДПИСЬ ПЕРЕСЛАННОГО ПОСТА (02.10.2026). Meta присылает её во вложении
   * (`payload.title`), а наша лента — когда пост нашёлся. Подпись из вложения
   * НЕ доверенная (переслать могли и чужой пост), поэтому из неё берётся только
   * строгое «Объект №N», которое CRM ставит последней строкой, полное совпадение
   * с опубликованной нами подписью или ровно один объект с той же ценой и площадью.
   */
  const postCaption = input.ownCaption || input.postTitle;
  if (isSharedPost(input.attachmentType) && postCaption) {
    const footer = captionFooterShortId(postCaption);
    const byFooter =
      footer != null
        ? await prisma.property.findFirst({ where: { shortId: footer, deletedAt: null }, include: WITH_DISTRICT })
        : null;
    if (byFooter) return { property: byFooter, source: "post" as const };
    const byCaptionText = await matchPropertyByCaption(postCaption);
    if (byCaptionText) return { property: byCaptionText, source: "post" as const };
    const byFacts = await matchPropertyByFacts(parsePropertyFacts(postCaption));
    if (byFacts) return { property: byFacts, source: "post" as const };
  }

  /** Объект, узнанный по надписям на самой картинке (sharedPostCard.ts) — уже
   *  найденный единственным совпадением, здесь только подставляется. */
  if (input.cardPropertyId) {
    const byCard = await propertyById(input.cardPropertyId);
    if (byCard) return { property: byCard, source: "post" as const };
  }

  /**
   * КЛИЕНТ САМ НАЗВАЛ НОМЕР СЛОВАМИ — не переслал ссылку, а написал «интересует
   * №1042» или «квартира номер 1042» (владелец 21.08.2026: «пишет именно по
   * данному объекту»). Тот же формат «№N», которым бот сам называет объекты
   * (describeProperty, propertyOfferText.ts) — если агент присылал клиенту это
   * же «№1042» раньше в переписке, клиент чаще всего копирует его же словами.
   * Слабее ссылки (можно случайно упомянуть число не как номер карточки), но
   * сильнее молчания — именованный номер однозначен настолько же, насколько
   * однозначна ссылка.
   */
  const typedNumber = clientMentionedPropertyNumber(text, linkFields);
  if (typedNumber != null) {
    const byTypedNumber = await prisma.property.findFirst({
      where: { shortId: typedNumber, deletedAt: null },
      include: WITH_DISTRICT,
    });
    if (byTypedNumber) return { property: byTypedNumber, source: "post" as const };
  }

  return null;
}

/** В подписи наше имя — ролик наш, даже если номер публикации не совпал
 *  (реклама крутит копию поста под другим номером). */
const OUR_BRAND_RE = /royal\s*\.?\s*home|роял\s*хо[уу]м|royalhome\.tj/iu;

export function isOurBrandCaption(caption: string | undefined | null): boolean {
  return Boolean(caption && OUR_BRAND_RE.test(caption));
}

/** Подпись есть, и она точно не наша и не про жильё. */
export function captionSaysForeign(caption: string | undefined | null): boolean {
  return (
    Boolean(caption?.trim()) &&
    !looksLikeHousing(caption) &&
    !isOurBrandCaption(caption) &&
    captionFooterShortId(caption) == null
  );
}

/**
 * МОЛЧАТЬ ЛИ НА ЧУЖОЙ РОЛИК (02.10.2026, второй заход; третий — 03.10.2026). Первый
 * заход молчал только вне рекламы, а спам приходит как раз ответом на рекламу:
 * человек жмёт объявление и шлёт свой рилс — бот узнавал рекламу и вежливо
 * отвечал. Dan: «на нашу рекламу отправляют рилс что за новый спам».
 *
 * ТРЕТИЙ ЗАХОД (03.10.2026, три живых переписки в Instagram): бот ответил
 * «Чӣ хизмат карда метавонем?» на чужой ролик без слов, пришедший с рекламы
 * (подписи нет, прочитать не вышло — прежнее правило в этом случае отвечало), и
 * дважды продавцу игровых аккаунтов, приславшему свой пост с «Ишам капен ку» и
 * «Успеть к ‼️» (любая буква считалась «живым человеком»). Теперь отвечаем на
 * чужую публикацию, только когда есть признак ДЕЛА: в словах клиента вопрос о
 * жилье, цене, показе, работе или номер телефона; подпись про жильё; объявление на
 * самой картинке. Одно приветствие делом не считается. Сообщение сохраняется в
 * переписку, агент его видит, а напишет человек вопрос — бот ответит.
 */
const CLIENT_BUSINESS = new RegExp(
  `${BW}(?:сколько|цен${TAIL}|стои${TAIL}|нарх${TAIL}|чанд|купить|куплю|покуп${TAIL}|прода${TAIL}|харид${TAIL}|` +
    `фурӯш${TAIL}|фуруш${TAIL}|посмотр${TAIL}|дидан|адрес${TAIL}|где|кучо|куҷо|район${TAIL}|ипотек${TAIL}|` +
    `агент${TAIL}|риелтор${TAIL}|вакан${TAIL}|работ${TAIL}|подробн${TAIL}|маълумот${TAIL}|интерес${TAIL}|` +
    `квартир${TAIL}|хона${TAIL}|дом${TAIL}|ҳавлӣ|хавли|комнат${TAIL}|аренд${TAIL}|иҷора${TAIL}|ичора${TAIL}|` +
    `свобод${TAIL}|озод${TAIL}|можно|мумкин)${EW}`,
  "iu"
);

export function clientTalksBusiness(text: string | undefined | null): boolean {
  if (!text?.trim()) return false;
  // Номер телефона цифрами — человек хочет связи, это дело.
  if (/\d[\d\s()+-]{6,}\d/.test(text)) return true;
  return looksLikeHousing(text) || CLIENT_BUSINESS.test(text);
}

export function silentOnForeignShare(input: {
  foreignShare: boolean;
  fromAd: boolean;
  text: string | undefined | null;
  caption: string | undefined | null;
  /** Чтение карточки (sharedPostCard.ts::readSharedCard); null — не читали или не вышло. */
  card: { listingSeen: boolean } | null;
}): boolean {
  if (!input.foreignShare) return false;
  if (clientTalksBusiness(input.text)) return false;
  if (looksLikeHousing(input.caption)) return false;
  if (input.card?.listingSeen) return false;
  return true;
}

/**
 * КЛИЕНТ САМ ПОКАЗАЛ ИНТЕРЕС К ОБЪЕКТУ — переслал наш пост/ссылку, и мы узнали,
 * какая это квартира (владелец 21.08.2026: «если кто-то пишет именно по объекту —
 * отправляешь первым делом самому агенту, он свои объекты лучше всех знает»).
 *
 * ДО ЭТОЙ ФУНКЦИИ узнавание кончалось на подсказке для модели: buildNote выше
 * возвращал текст «отвечай про ЭТОТ объект», бот отвечал правильно, а дальше
 * след терялся — если из этого диалога позже родится лид, распределение о
 * пересланном посте ничего не знало. Реальный разрыв между «бот понял» и
 * «система учла».
 *
 * ЧИНИМ БЕЗ НОВОГО МЕХАНИЗМА. PropertyExposure уже существует и уже безусловно
 * маршрутизирует лид владельцу объекта (leads.ts::pickByShownProperty,
 * assignReason="own_property_shown") — механизм задумывался под «бот показал
 * объект», но по данным (channel+recipientId или clientId) не различает, кто
 * именно инициировал показ. Клиент, сам принёсший ссылку на объект, для этого
 * правила ничем не хуже клиента, которому объект показал бот, — значит, это та
 * же запись, с тем же весом и тем же окном действия (ownPropertyShownWindowDays).
 *
 * Требует channel+recipientId (без диалога писать некуда) и назначенного
 * intakeAgentId (без хозяина отдавать некому — объект, добавленный без
 * привязки к агенту, тут не маршрутизируется, только подсказывает модели).
 * Ошибка базы никогда не должна ломать ответ клиенту — оборачиваем в try/catch,
 * как и весь остальной sharedMediaHint.
 */
export async function recordClientInterest(
  property: {
    id: string;
    shortId: number;
    status: string;
    intakeAgentId: string | null;
    assignedAgentId: string | null;
    createdById: string | null;
  },
  channel: string | undefined,
  recipientId: string | undefined,
  // Необязателен: вызов из комментариев (comments.ts) диалога не ведёт и связь «диалог ↔ объект»
  // не пишет — её ставят только сообщения из личной переписки.
  source?: "SHARED_MEDIA" | "LISTING_LINK",
  transport?: CustomerTransportHint
): Promise<void> {
  // «Голос рынка»: след «в диалоге речь об этом объекте» пишется ДО проверок
  // маршрутизации ниже. Они решают, отдавать ли лид хозяину объекта, а вопрос
  // клиента о проданной или чужой квартире — такой же голос рынка (lib/propertyVoice).
  // Хозяин объекта — по общему правилу (lib/propertyOwner.ts), а не только агент
  // приёма: карточка, заведённая без него, раньше лид не маршрутизировала вовсе.
  // Проданный или снятый объект лид своему бывшему агенту не отдаёт (02.10.2026).
  if (!channel || !recipientId) return;
  try {
    const endpoint = await resolveCustomerEndpoint(customerTransportInput(channel, recipientId, transport));
    if (source) void linkConversationPropertyByChannel({ channel, recipientId, transport: endpoint, propertyId: property.id, source });
    if (!propertyOwnerAgentId(property) || (property.status !== "AVAILABLE" && property.status !== "RESERVED")) return;
    /**
     * ДЕДУП НА 10 МИНУТ (адверсариальная проверка 21.08.2026): без него клиент,
     * зациклившийся на одном сообщении, или повтор доставки вебхука пишет по
     * записи на каждое срабатывание — pickByShownProperty это переживает
     * (дедуп по владельцу внутри), но `take: 20` при частых повторах мог бы
     * вытеснить из выборки более старые реальные показы ДРУГИХ объектов. Не
     * полноценный ShownProperty-анти-дубль (недельное окно ни к чему для
     * разового «клиент переслал ещё раз»), просто щиток от короткого залпа.
     */
    const recent = await prisma.propertyExposure.findFirst({
      where: {
        channel,
        recipientId,
        endpointScopeId: endpoint.endpointScopeId,
        propertyId: property.id,
        kind: "CLIENT_SHARED",
        sentAt: { gte: new Date(Date.now() - 10 * 60_000) },
      },
      select: { id: true },
    });
    // Клиент уже закреплён за другим агентом — агенту объекта сообщаем
    // (02.10.2026, lib/propertyInterestNotice.ts; свой суточный дедуп там).
    // С `source` хозяина будит уже связь «диалог ↔ объект» выше — для любого
    // собеседника, и без карточки тоже (P0-3, 10.10.2026); здесь остаётся путь
    // без диалога — комментарий под постом.
    // Public comment author IDs are not proof of the same private DM/Client.
    // This compatibility entry point intentionally performs no private lookup.
    if (!source) void noticeInterestByConversation({ channel, recipientId, propertyId: property.id });
    if (recent) return;

    await resolveCustomerEndpoint(customerTransportInput(channel, recipientId, endpoint));

    await prisma.propertyExposure.create({
      data: {
        channel,
        recipientId,
        endpointScopeId: endpoint.endpointScopeId,
        propertyId: property.id,
        shortId: property.shortId,
        kind: "CLIENT_SHARED",
      },
    });
  } catch (err) {
    void logSystemError(
      "meta",
      `Интерес клиента к объекту №${property.shortId} не записан: ${describeError(err)}`
    );
  }
}

/**
 * ПОСЕТИТЕЛЬ ПИШЕТ В ЧАТ СО СТРАНИЦЫ ОБЪЕКТА (02.10.2026, Dan: «любой интерес…
 * своему агенту»). Страница шла модели только подсказкой, и лид из чата уходил
 * раздачей, хотя форма сайта с той же страницы давно отдаёт его агенту объекта
 * (routes/webhooks.ts, resolvePropertyFromPageUrl). Записываем интерес тем же
 * следом, что и присланную ссылку, — его читает раздача (pickByShownProperty).
 */
export async function recordPageInterest(
  pageUrl: string | null | undefined,
  channel: string,
  recipientId: string
): Promise<string | null> {
  try {
    const id = await resolvePropertyFromPageUrl(pageUrl);
    const property = id ? await propertyById(id) : null;
    if (property) await recordClientInterest(property, channel, recipientId, "LISTING_LINK");
    // id объекта страницы возвращается, чтобы чат сайта мог оставить след в диалоге
    // уже на первом сообщении (диалога тогда ещё нет — см. sharedPropertyId).
    return property?.id ?? null;
  } catch (err) {
    void logSystemError("meta", `Объект страницы сайта не определён: ${describeError(err)}`);
    return null;
  }
}

/** Что делать с прочими вложениями — главное, чтобы бот не замолчал. */
const ATTACHMENT_HINTS: Record<string, string> = {
  location: "[клиент прислал геометку — скорее всего показывает, какой район ему нужен. Уточни, ищет ли он жильё именно там]",
  // Имя и номер из визитки с 20.09.2026 попадают в сам текст хода (messengers/meta.ts),
  // поэтому подсказка больше не велит спрашивать номер заново: раньше именно она
  // заставляла переспрашивать то, что человек только что прислал.
  contact:
    "[клиент прислал карточку контакта — имя и номер из неё уже в тексте этого же сообщения. Если номер его собственный — прими его и НЕ спрашивай телефон снова; если из разговора видно, что номер чужой, — уточни, чей он и чем помочь]",
  // Видео и документы с 02.08.2026 разбираются (ai/geminiMedia.ts), и описание
  // приходит В ЭТО ЖЕ сообщение отдельным блоком <client_content kind="video">…
  // (границы недоверенного содержимого, см. ai/untrustedContent.ts).
  // Подсказка написана так, чтобы годиться в обоих случаях: разбор мог и не удаться
  // (нет ключа, отказ Gemini, файл тяжелее потолка), и тогда строки с описанием
  // просто не будет. Обещать здесь «мы не умеем» больше нельзя — чаще всего умеем.
  video:
    "[клиент прислал видео — скорее всего показывает квартиру. Если ниже есть строка с описанием того, " +
    "что на видео, отвечай ПО НЕМУ, как будто посмотрел сам, и не проси пересказать словами. Если " +
    "описания нет — коротко попроси рассказать, что на видео]",
  file:
    "[клиент прислал файл. Если ниже есть строка с его содержанием, отвечай по ней. Если нет — коротко " +
    "попроси написать словами, что нужно]",
  document:
    "[клиент прислал документ. Если ниже есть строка с его содержанием, отвечай по ней. Если нет — коротко " +
    "попроси написать словами, что нужно]",
  /**
   * «unsupported» — ОТКАЗ САМОЙ META, А НЕ НАШ (22.09.2026, продавец дачи в
   * WhatsApp). Этот тип означает, что Meta не смогла доставить сообщение сама
   * (опрос, «просмотр один раз», отредактированное сообщение): файла нет, и
   * открывать нечего. Без этой строки тип проваливался в общую ветку ниже, и
   * код САМ велел модели сказать «не умеем читать это вложение» — тот же
   * промах, что уже чинили с шаблонной карточкой (template ниже): человек
   * слышит, что бот не сумел открыть присланное, хотя до нас оно не дошло.
   */
  unsupported:
    "[WhatsApp не смог доставить нам это сообщение (опрос, «просмотр один раз» или подобное) — клиент " +
    "мог и не знать об этом. ЗАПРЕЩЕНО говорить, что ты не сумел открыть файл, фото или вложение. " +
    "Скажи просто, что сообщение не дошло, и попроси написать текстом или прислать обычным фото]",
  sticker: "[клиент прислал стикер — это не вопрос. Ответь коротко и по-доброму, разговор продолжай своим вопросом]",
  /**
   * ШАБЛОННАЯ КАРТОЧКА — ЭТО МЫ, А НЕ КЛИЕНТ (20.09.2026).
   *
   * Карточку с кнопкой отправляет только CRM: в приложении Instagram такой кнопки
   * нет ни у клиента, ни у сотрудника (см. routes/webhooks.ts, 22.08.2026). То есть
   * `[вложение: template]` в переписке — наше же сообщение, вернувшееся эхом, и
   * открывать там нечего.
   *
   * Без этой строки тип «template» проваливался в общую ветку ниже, и код САМ велел
   * модели сказать «мы не умеем читать это вложение, напишите словами». Отсюда и
   * бралось «файл кушода наметавонам» в ответ человеку, который всего лишь нажал
   * кнопку под нашим объявлением: 21 случай в выгрузке живых переписок за
   * 21.08–20.09, из них 3 в один только последний день. Запрет в промте у рекламной
   * подводки при этом стоял (`neutralOpenerHint`, `vacancyTurnHint` в
   * ai/adTemplateOpener.ts) — но рядом лежало прямое указание обратного, и побеждало
   * оно.
   */
  template:
    "[в переписке видна НАША ЖЕ карточка с кнопкой — её отправила программа, а не клиент. Клиент ничего " +
    "не присылал, открывать нечего. ЗАПРЕЩЕНО говорить, что вложение, файл, фото или видео не открылись, " +
    "и просить прислать словами то, чего он не присылал. Отвечай на его СОБСТВЕННЫЕ слова; если своих слов " +
    "у него пока нет — поздоровайся и ОДНИМ коротким вопросом спроси, чем можешь помочь]",
};

/** Карточку прислал клиент — см. проверку перед ATTACHMENT_HINTS в buildNote. */
const CLIENT_CARD_HINT =
  "[клиент прислал карточку — прочитай её текст в его сообщении: номер в ней — номер клиента, " +
  "имя — его имя. Второй раз номер НЕ спрашивай. ЗАПРЕЩЕНО говорить, что вложение не открылось]";

/** Одна строка про объект — то, что бот может сказать клиенту без выдумок.
 *  Экспортируется: ответ на комментарий под постом (messengers/comments.ts) обязан
 *  описывать объект теми же словами, что и ответ в личке, иначе цены в двух местах
 *  начнут расходиться. */
export function describeProperty(p: {
  rooms: number | null;
  type: PropertyType;
  areaSqm: unknown;
  price: unknown;
  currency: string;
  status: string;
  // Закрытый объект (offSite) может остаться без района вовсе (владелец
  // 14.09.2026) — бот его всё равно может обсуждать (личная ссылка клиенту),
  // просто без названия района в строке.
  district: { name: string } | null;
  shortId: number;
  /** Новостройка/вторичка/котлован — необязательное поле (17.09.2026, владелец:
   *  «как это мы не знаем, новостройка или нет?»). Отсутствует на части старых
   *  карточек и у вызовов, которые его ещё не выбирают из базы — тогда просто не
   *  добавляется в строку, а не выдумывается. */
  marketType?: string | null;
}): string {
  const head = propertyHeadline(p);
  const price = `${Number(p.price).toLocaleString("ru-RU")} ${p.currency === "USD" ? "$" : "с."}`;
  const sold = p.status !== "AVAILABLE" ? ", УЖЕ НЕ В ПРОДАЖЕ" : "";
  const place = p.district?.name ? `, ${p.district.name}` : "";
  // «Новостройка/вторичка» — только у квартиры и коммерции (propertyTypeFields.ts).
  const market = p.marketType && propertyHasMarket(p.type) ? `, ${MARKET_TYPE_LABELS[p.marketType as MarketType] ?? p.marketType}` : "";
  return `объект №${p.shortId}: ${head}${place}${market}, ${Number(p.areaSqm)} м², ${price}${sold}`;
}

export interface SharedMediaInput {
  text: string;
  attachmentType?: string;
  attachmentUrl?: string;
  replyToStoryUrl?: string;
  /**
   * Канал и адресат в нём (psid/igsid/wa_id) — тот же ключ, что и у карточки
   * клиента до её появления (см. PropertyExposure). Нужны только затем, чтобы
   * записать «клиент сам показал интерес к объекту» — см. recordClientInterest
   * ниже. Необязательны: без них подсказка модели работает как раньше, просто
   * запись не пишется (тесты и разовые вызовы без реального диалога).
   */
  channel?: string;
  recipientId?: string;
  /** Exact installed account from the authenticated/current transport adapter. */
  accountId?: string | null;
  transport?: CustomerTransportReference;
  /**
   * Модель ВИДИТ присланное: история скачана, публикация найдена в нашей ленте,
   * фото пришло файлом. Меняет подсказку на противоположную по смыслу — «отвечай
   * по тому, что видишь» вместо «переспроси, тебе не видно».
   *
   * До 16.08.2026 этого различия не было вовсе, и бот переспрашивал даже тогда,
   * когда картинка лежала прямо перед ним.
   */
  mediaSeen?: boolean;
  /** Подпись под нашей публикацией — в ней обычно цена, район и метраж. */
  ownCaption?: string;
  /**
   * Адрес публикации, каким его отдал Graph API нашей же ленты (messengers/ownMedia.ts).
   * Заполнен ТОЛЬКО когда пост подтверждённо наш — это и есть сигнал для самоисцеления
   * поля «Ссылка на публикацию Instagram» у карточки: см. healInstagramUrl ниже.
   */
  ownPermalink?: string;
  /** Номер нашей публикации из ленты (OwnMedia.id) — см. propertyByMediaId. */
  ownMediaId?: string;
  /** Номер пересланной публикации прямо из вложения Meta (reel_video_id / ig_post_media_id). */
  mediaId?: string;
  /** Подпись пересланной публикации из вложения Meta (`payload.title`) — недоверенная. */
  postTitle?: string;
  /** Объект, узнанный по надписям на картинке (sharedPostCard.ts::propertyFromSharedCard). */
  cardPropertyId?: string | null;
}

/** Пересланная публикация: пост, рилс или карусель. Тип нужен и вебхуку, чтобы
 *  знать, когда идти за файлом в собственную ленту. */
export function isSharedPost(attachmentType?: string): boolean {
  // "ig_post" — так Meta с 2024 года размечает пересланный ПОСТ (не рилс); у нас
  // его не было, и такой пост уходил в «вложение, которое мы не умеем читать».
  return attachmentType === "share" || attachmentType === "ig_reel" || attachmentType === "ig_post";
}

/**
 * Ровно тот случай, которым buildNote ниже заканчивается фразой «видео не
 * открылось»: публикацию переслали, но бот её не видит (`!mediaSeen`) И не
 * может привязать к объекту (`!found`). Вынесено ОТДЕЛЬНЫМ вызовом, а не
 * разбором готовой строки подсказки, потому что текст подсказки — для модели
 * и меняется от формулировки к формулировке, а решение «было это тот самый
 * неопознанный случай или нет» нужно messengers/conversation.ts ТОЧНЫМ, без
 * догадок по тексту (см. MAX_UNRESOLVED_SHARE_REPLIES в ai/replyRepeatGuard.ts —
 * там считают, сколько раз подряд это уже случалось в разговоре).
 *
 * Да, это второй вызов findSharedProperty на то же самое сообщение (первый —
 * внутри buildNote/sharedMediaHint). Плата за то, что признак не расходится с
 * буквой buildNote и логика совпадения объекта не дублируется в двух местах
 * руками. Оба вызова — дешёвые indexed-запросы, а срабатывает это только на
 * пересланных публикациях, самом редком типе входящего сообщения.
 */
/**
 * ЧТО ИМЕННО ПРИСЛАЛИ: опознанный объект, неопознанная пересылка или ничего.
 *
 * Нужен рекламному пути (routes/webhooks.ts, 17.09.2026, вечер). `isUnresolvedSharedPost`
 * отвечает только «это тот самый случай „видео не открылось“?» и для сообщения
 * С РЕКЛАМЫ вызывался с коротким замыканием по `fromAd` — то есть для рекламы
 * ответ был всегда «нет», и отличить «объект опознан» от «пересылку не разобрали»
 * по нему было нельзя. Отсюда и брался вопрос «какую квартиру вы ищете» вместо
 * разговора про ТУ САМУЮ квартиру из объявления.
 *
 * Возвращает и id объекта, и признак неопознанности — одним вызовом
 * findSharedProperty вместо двух.
 */
export async function sharedPostContext(
  input: SharedMediaInput
): Promise<{ propertyId: string | null; unresolved: boolean }> {
  if (!isSharedPost(input.attachmentType)) return { propertyId: null, unresolved: false };
  const found = await findSharedProperty(input);
  // `mediaSeen` повторяет условие isUnresolvedSharedPost: картинку мы видим,
  // значит сказать «не открылось» бот и не собирался.
  return { propertyId: found?.property.id ?? null, unresolved: !found && !input.mediaSeen };
}

export async function isUnresolvedSharedPost(input: SharedMediaInput): Promise<boolean> {
  if (!isSharedPost(input.attachmentType) || input.mediaSeen) return false;
  const found = await findSharedProperty(input);
  return !found;
}

/**
 * Дописывает к сообщению клиента пояснение для модели. Возвращает исходный текст,
 * если пояснять нечего.
 *
 * Пояснение идёт в квадратных скобках отдельной строкой — тем же приёмом, что и
 * пометки о вложениях: модель понимает это как контекст, а не как слова клиента.
 */
/**
 * Подсказка для модели про этот ход — ОТДЕЛЬНО от текста клиента.
 *
 * Раньше эта функция возвращала текст клиента вместе с приклеенной подсказкой, и
 * склейка уходила в историю диалога как слова человека: в инбоксе агент видел абзац
 * наших инструкций вместо реплики («🔥»), а модель получала ситуативное указание
 * заново на каждом следующем ходу. Теперь подсказка возвращается сама по себе и
 * живёт ровно один ход (см. turnHint в messengers/conversation.ts).
 */
export async function sharedMediaHint(input: SharedMediaInput): Promise<string> {
  // Подсказка — приятное дополнение, а не условие ответа. Если база не отзовётся,
  // клиент всё равно получит ответ бота: молчание для него хуже общей фразы.
  try {
    return (await buildNote(input)) ?? "";
  } catch (err) {
    void logSystemError("meta", `Пересланный объект не распознан: ${describeError(err)}`);
    return "";
  }
}

/** Пояснение к сообщению — ровно одно: две подсказки подряд сбивают модель с толку. */
async function buildNote(input: SharedMediaInput): Promise<string | null> {
  const isShare = isSharedPost(input.attachmentType);
  const hasStory = Boolean(input.replyToStoryUrl);

  // Узнали конкретную квартиру — это самый горячий случай, и говорить надо про неё.
  const found = await findSharedProperty(input);
  if (found) {
    void recordClientInterest(
      found.property,
      input.channel,
      input.recipientId,
      found.source === "post" ? "SHARED_MEDIA" : "LISTING_LINK",
      input.transport ?? input.accountId
    );
    const origin =
      found.source === "post" ? "клиент показывает на НАШУ публикацию" : "клиент прислал ссылку на наш объект";
    return (
      `[${origin} — ${describeProperty(found.property)}. Отвечай про ЭТОТ объект: ` +
      "цену и детали бери отсюда, не выдумывай. Если он уже не в продаже — честно скажи и предложи похожее]"
    );
  }

  /**
   * КАРТОЧКИ НЕТ, НО ПУБЛИКАЦИЮ МЫ ВИДИМ.
   *
   * Промежуточный случай, которого раньше не существовало: объект к публикации не
   * привязан (или в поле ссылки лежит телеграм — так на проде у 20 карточек из 41),
   * зато сама публикация наша, и мы принесли модели её картинку и подпись. Этого
   * достаточно, чтобы отвечать по существу вместо «а сколько комнат?».
   *
   * Цену и адрес модель обязана брать ИЗ ПОДПИСИ, а не выдумывать: подпись писали мы
   * сами, это такой же источник правды, как карточка.
   */
  /**
   * ВИДИМ, НО ЧЬЁ — НЕ ЗНАЕМ (02.10.2026). Картинку или ролик скачали с CDN Meta,
   * а в нашей ленте этой публикации нет. Раньше и этот случай объявлялся «НАШЕЙ
   * публикацией» — для чужого поста или видео, снятого самим клиентом, это неправда.
   */
  // Адрес instagram.com вебхук не скачивает никогда: «видим» при нём значит, что
  // файл взяли из НАШЕЙ ленты — это ветка ниже.
  if (isShare && input.mediaSeen && !input.ownPermalink && !input.ownCaption && !isInstagramLink(input.attachmentUrl)) {
    return (
      "[клиент переслал видео или пост. Само присланное ты видишь — отвечай по нему, как будто посмотрел " +
      "сам, и НЕ говори, что видео не открылось. Если на нём карточка объекта с ценой и площадью — говори " +
      "по этим цифрам и предложи подробности; если это чужое объявление — скажи, что понял, и предложи " +
      "похожее из наших. Если по картинке непонятно, о каком жилье речь, ОДНИМ вопросом попроси ссылку " +
      "на это объявление или номер объекта. Называй присланное просто ВИДЕО: слова «реел», «рилс», «reel», " +
      "«пост», «публикация» клиенту ЗАПРЕЩЕНЫ]"
    );
  }

  if (isShare && input.mediaSeen) {
    const caption = input.ownCaption?.trim();
    return (
      "[клиент показывает на НАШУ публикацию. Само присланное ты видишь — отвечай по нему, как будто " +
      "посмотрел сам, и НЕ проси пересказать словами и не спрашивай район. " +
      (caption
        ? `Подпись под публикацией: «${caption.slice(0, 600)}» — цену, район и метраж бери оттуда, не выдумывай. `
        : "Подписи под публикацией нет — говори только о том, что видно на картинке, цену не выдумывай. ") +
      "Называй присланное просто ВИДЕО: слова «реел», «рилс», «reel», «пост», «публикация» в сообщении " +
      "клиенту ЗАПРЕЩЕНЫ — живые люди так не говорят. Задай ОДИН вопрос, если он нужен]"
    );
  }

  // Публикацию переслали, но объект не опознан: пост мог быть удалён, перезалит или
  // не привязан к объекту. Молчать нельзя — переспрашиваем.
  if (isShare) {
    /**
     * СНАЧАЛА ПОПРОБУЕМ ПРОЧИТАТЬ ССЫЛКУ (21.09.2026). Кнопка «поделиться» в
     * Instagram присылает ссылку ВЛОЖЕНИЕМ, и до этой правки такая ссылка не
     * читалась никогда: разбор вложений возвращал «видео у меня не открылось»
     * раньше, чем выполнение доходило до чтения ссылок. Если по ссылке удалось
     * прочитать объявление — говорить надо про него, а не про невидимое видео.
     */
    const sharedLinkNote = await readLinkNote(input);
    if (sharedLinkNote) return sharedLinkNote;

    /**
     * ЗАМЕР, а не отладка. Причин промаха ровно две, и лечатся они по-разному:
     *  • Meta не дала адрес публикации — тогда узнавание по пересланному видео
     *    невозможно в принципе, и надо просить у клиента ссылку;
     *  • адрес есть и код достали, но в карточках его нет — причину и виновные
     *    карточки называет reportUnmatchedShare, сходив в базу.
     * Различить их иначе нельзя: снаружи оба случая выглядят как «не опознали».
     *
     * Замер за 7–13.08.2026 ответил на первый вопрос: код извлекался ВО ВСЕХ
     * десяти случаях, ветка «Meta не дала адрес» не сработала ни разу. Оставлена
     * она на будущее — формат вложений Meta меняет молча.
     */
    const code =
      instagramShortcode(input.attachmentUrl) ??
      instagramShortcode(input.text) ??
      instagramShortcode(await expandLinkFields(`${input.text ?? ""} ${input.attachmentUrl ?? ""}`));
    // Id переписки — в каждой записи журнала (P2-7, 10.10.2026): без него исход
    // обращения проверить нельзя (в аудите его восстанавливали по времени).
    const conversationId = await conversationIdOf(input);
    if (code) {
      void reportUnmatchedShare(code, conversationId);
    } else {
      void logSystemError(
        "meta",
        `Пересланная публикация не опознана: Meta не дала адрес публикации${input.attachmentUrl ? ` (пришло: ${input.attachmentUrl.slice(0, 120)})` : " (адреса нет вовсе)"}. Узнать объект по такому вложению нельзя.`,
        conversationId ? { url: `/messages?open=${conversationId}` } : undefined
      );
    }
    /**
     * ОБРАЩЕНИЕ ПО НЕИЗВЕСТНОЙ ПУБЛИКАЦИИ — ДЕЛО ЧЕЛОВЕКА, А НЕ СТРОКА ЖУРНАЛА
     * (10.10.2026, аудит P0-2: 135 таких пересылок за месяц, 31 из 35 переписок так
     * и не стали клиентами). Руководителю — строка в ленте со ссылкой на переписку:
     * посмотреть пост, назвать объект или ответить самому. Явно чужое (подпись не
     * про жильё, клиент о деле ни слова) — не беспокоим. Клиенту бот честно говорит,
     * что передал коллеге, только если строка действительно ушла.
     */
    const handedOver = await raiseUnknownShare(input, conversationId);
    /**
     * ЧТО ИМЕННО СЛОМАЛОСЬ ЗДЕСЬ (разбор владельца 16.08.2026).
     *
     * Клиент переслал ЧУЖОЙ ролик — публикацию музыкального аккаунта, к недвижимости
     * не относящуюся вовсе, — а бот ответил: «Подскажите, сколько комнат в квартире
     * на этом видео?». Виноваты две строки этой самой подсказки: она объявляла любое
     * пересланное «нашей публикацией» и прямо велела спросить про комнаты.
     *
     * Ни того, ни другого мы не знаем. Пересланное бывает: нашей публикацией
     * (тогда её узнают выше по коду), чужим объявлением конкурента, роликом со
     * стороны и просто случайным видео. Спрашивать «сколько комнат на этом видео»
     * бессмысленно во всех трёх последних случаях, а в последнем ещё и нелепо: там
     * нет никакой квартиры.
     *
     * Поэтому теперь: не называем публикацию нашей, не спрашиваем о СОДЕРЖИМОМ
     * того, чего не видели, и переводим разговор на то, что человеку нужно.
     */
    return (
      "[клиент переслал публикацию, но САМОГО ВИДЕО ТЫ НЕ ВИДИШЬ и не знаешь, что на нём. Это может быть " +
      "наш объект, чужое объявление или вообще ролик не про жильё. " +
      "Называй присланное просто ВИДЕО. Слова «реел», «рилс», «reel», «пост», «публикация» в сообщении " +
      "клиенту ЗАПРЕЩЕНЫ: по-таджикски и по-русски живые люди так не говорят, это калька и сразу выдаёт бота. " +
      "ЗАПРЕЩЕНО спрашивать о содержимом видео — «сколько комнат на этом видео», «какой там этаж», «что за " +
      "дом на видео»: ты его не открыл, и человек это сразу понимает. " +
      (handedOver
        ? "Скажи по-человечески, что видео у тебя не открылось, поэтому сразу не видишь, какой это объект, и что " +
          "ты передал его коллеге — он посмотрит и ответит здесь же. И ОДНИМ вопросом переведи разговор на то, " +
          "что ему нужно: «Ин видео дар ман кушода нашуд, ба ҳамкорам фиристодам — менигараду ҳамин ҷо ҷавоб " +
          "медиҳад. Шумо чунин хона мекобед? Чандхонага?» / «Видео у меня не открылось, передал коллеге — он " +
          "посмотрит и ответит здесь же. Вы такую квартиру ищете? Сколько комнат нужно?». "
        : "Скажи по-человечески, что видео у тебя не открылось, и ОДНИМ вопросом переведи разговор на то, что " +
          "ему нужно: «Ин видео дар ман кушода нашуд. Шумо чунин хона мекобед? Чандхонага?» / «Видео у меня не " +
          "открылось. Вы такую квартиру ищете? Сколько комнат нужно?». ") +
      "Если по его словам видно, что речь вообще не о жилье, — не выдумывай квартиру: спокойно спроси, чем " +
      "помочь по жилью. " +
      "Ни в коем случае не молчи и не отвечай общей фразой]"
    );
  }

  if (hasStory) {
    // Историю с 16.08.2026 мы скачиваем и показываем модели (routes/webhooks.ts).
    // Пока это не работало, приходилось честно писать «тебе не видно» — и бот
    // переспрашивал у человека то, что тот показал именно чтобы не объяснять.
    if (input.mediaSeen) {
      return (
        "[клиент ответил на НАШУ историю — он смотрит наши публикации прямо сейчас, это тёплый интерес. " +
        "Саму историю ты видишь: отвечай по ней и по его реплике, как будто посмотрел сам. НЕ проси " +
        "пересказать словами и НЕ спрашивай район. Слова «сторис», «история», «реел», «рилс» клиенту не " +
        "пиши — говори просто «видео» или вообще без названия]"
      );
    }
    return (
      "[клиент ответил на НАШУ историю в Instagram — он смотрит наши публикации прямо сейчас, это тёплый " +
      "интерес. Ответь по существу его реплики. Содержимое самой истории тебе не видно, поэтому если " +
      "непонятно, о какой квартире речь, задай ОДИН вопрос о ней (лучше всего сколько комнат), а НЕ спрашивай район: " +
      "человек ответил на историю именно чтобы не объяснять словами. Слова «сторис», «история», «реел», " +
      "«рилс» в сообщении клиенту не используй — говори просто «видео» или вообще без названия]"
    );
  }

  /**
   * КАРТОЧКА, У КОТОРОЙ ЕСТЬ ТЕКСТ, — КАРТОЧКА КЛИЕНТА (25.09.2026).
   *
   * Подсказка «это НАША ЖЕ карточка» (ATTACHMENT_HINTS.template) верна только для
   * голого `[вложение: template]`: нашу карточку разбор входящих оставляет без
   * текста (isOwnButtonCardPayload в messengers/meta.ts). Если текст есть — это
   * слова и номер из карточки, которую прислал сам клиент (живой случай в
   * Instagram: своя карточка с телефоном, а бот слышал «клиент ничего не
   * присылал» и переспрашивал номер).
   */
  if (input.attachmentType === "template" && input.text && !input.text.startsWith("[вложение:")) {
    return CLIENT_CARD_HINT;
  }

  if (input.attachmentType === "location") {
    const district = await locationDistrict(input.text);
    if (district) return locationHint(district);
  }

  if (input.attachmentType && ATTACHMENT_HINTS[input.attachmentType]) {
    return ATTACHMENT_HINTS[input.attachmentType];
  }

  // Незнакомый тип вложения — Meta придумывает новые, и молчание в ответ хуже
  // любого несовершенного ответа. Фото и голосовые оставляем как есть: их пометку
  // ставит вебхук, а читать их мы пока не умеем.
  if (input.attachmentType && input.attachmentType !== "image" && input.attachmentType !== "audio") {
    return (
      "[клиент прислал вложение, которое мы не умеем читать. Не молчи: коротко и по-доброму попроси " +
      "написать словами, что нужно]"
    );
  }

  /**
   * ЧУЖАЯ ССЫЛКА — объявление конкурента, случайный сайт. С 16.08.2026 мы её
   * ОТКРЫВАЕМ и читаем, что там (lib/linkPreview.ts): человек прислал ссылку
   * именно затем, чтобы не пересказывать её содержимое словами, а бот до сих пор
   * просил пересказать.
   *
   * Если открыть не вышло (сайт лёг, закрылся от нас, адрес оказался внутренним) —
   * остаётся прежний путь: коротко переспросить. Молчать нельзя ни в одном из двух
   * случаев.
   */
  const linkNote = await readLinkNote(input);
  if (linkNote) return linkNote;

  return null;
}

/**
 * ПРОЧИТАТЬ ПРИСЛАННУЮ ССЫЛКУ И РАССКАЗАТЬ МОДЕЛИ, ЧТО ТАМ.
 *
 * Вынесено из `buildNote` 21.09.2026, потому что зваться это обязано в ДВУХ
 * местах: и в обычном сообщении со ссылкой, и у пересланной публикации. Раньше
 * ветка стояла в самом конце, ниже разбора вложений, и до неё не доходило
 * выполнение, если у сообщения было ЛЮБОЕ вложение. А ссылка, отправленная в
 * Instagram кнопкой «поделиться», приходит именно вложением — то есть присланная
 * так ссылка не читалась никогда, и человек слышал «видео у меня не открылось».
 *
 * Ссылку берём и из текста, и из адреса вложения: при «поделиться» текста часто
 * нет вовсе.
 */
async function readLinkNote(input: SharedMediaInput): Promise<string | null> {
  const haystack = `${input.text ?? ""} ${input.attachmentUrl ?? ""}`;
  const foreignLink = firstForeignLink(haystack);
  if (foreignLink) {
    /**
     * СПАМ НЕ ЧИТАЕМ. Рассылка — самый частый источник чужих ссылок в директе, и
     * без этой проверки спамер сотней сообщений заставляет НАШ сервер ходить по
     * своим адресам (нагул трафика на его сайт, разведка нашего выходного IP).
     * Бот такой ход всё равно оставит без ответа (detectSpam в conversation.ts) —
     * значит и подсказка ему не понадобится, и запрос наружу делать незачем.
     */
    if (detectSpam(input.text)) return null;
    const preview = await linkPreview(foreignLink);
    if (preview) {
      const what = [preview.title, preview.description].filter(Boolean).join(". ");
      return (
        `[клиент прислал ссылку на чужое объявление. Что там: «${what.slice(0, 400)}»` +
        (preview.siteName ? ` (сайт ${preview.siteName})` : "") +
        ". Отвечай так, будто открыл и посмотрел: назови, что понял из объявления, и предложи " +
        "похожее из наших объектов. НЕ проси пересказать словами — человек прислал ссылку именно " +
        "чтобы этого не делать. Чужую цену и условия обсуждай осторожно: они не наши и могли " +
        "устареть, у нас свои]"
      );
    }
    return (
      "[в сообщении ссылка не на наш сайт — возможно, объявление, которое понравилось клиенту. " +
      "Открыть её не удалось: коротко спроси, что именно там понравилось (район, площадь, цена), " +
      "и подбери похожее из нашей базы]"
    );
  }

  /**
   * ССЫЛКА НА НАШ ЖЕ САЙТ, ПО КОТОРОЙ ОБЪЕКТ НЕ НАШЁЛСЯ.
   *
   * Сюда попадают страница поиска, статья, объявление, снятое с продажи, и адрес
   * со слагом, которого разборщик номера не знает. Раньше подсказки в этом случае
   * не было ВООБЩЕ: человек присылал ссылку на нашу же страницу и получал ответ,
   * будто ничего не присылал. Страницу просто читаем, как чужую.
   */
  const ownLink = firstOwnSiteLink(haystack);
  if (ownLink) {
    if (detectSpam(input.text)) return null;
    const preview = await linkPreview(ownLink);
    if (preview) {
      const what = [preview.title, preview.description].filter(Boolean).join(". ");
      return (
        `[клиент прислал ссылку на страницу НАШЕГО сайта. Что на ней: «${what.slice(0, 400)}». ` +
        "Конкретной карточки по этой ссылке в базе не нашлось — возможно, объект уже продан или это " +
        "страница поиска. Отвечай так, будто открыл и посмотрел: скажи, что понял, и предложи " +
        "подходящее из наших объектов. НЕ проси пересказать словами]"
      );
    }
    return (
      "[клиент прислал ссылку на наш сайт, но конкретный объект по ней не нашёлся, а страницу открыть " +
      "не удалось. Не говори, что ссылка не открылась: коротко спроси одним вопросом, какую квартиру он " +
      "смотрел (район и сколько комнат), и подбери из нашей базы]"
    );
  }

  return null;
}

/**
 * ГЕОМЕТКА → РАЙОН (ревизия бота 02.10.2026, сравнение с лучшими ассистентами).
 * Без названия места WhatsApp присылает голые координаты («📍 38.57, 68.78»), и
 * модель видела только цифры: человек показал точку на карте, а бот спрашивал
 * «какой район?». Точка переводится в район тем же правилом, что и у объектов
 * (lib/propertyDistrict.ts). Не нашли — остаётся общая подсказка про геометку.
 */
const COORDS = /(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/;

export async function locationDistrict(text: string | undefined | null): Promise<string | null> {
  const m = text ? COORDS.exec(text) : null;
  if (!m) return null;
  const district = await districtByPoint(Number(m[1]), Number(m[2])).catch(() => null);
  return district?.name ?? null;
}

export function locationHint(district: string): string {
  return (
    `[клиент прислал геометку — это район ${district}. Покупателю это, скорее всего, нужный район; ` +
    "продавцу — где его объект. Говори о районе словами, координаты клиенту не повторяй и не спрашивай " +
    "заново, какой район]"
  );
}
