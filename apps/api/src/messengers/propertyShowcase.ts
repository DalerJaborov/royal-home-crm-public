import { prisma } from "../db.js";
import type { ShowcaseResult } from "../ai/showcaseResult.js";
export type { ShowcaseResult };
export { recordExposures } from "../lib/propertyExposures.js";
import { traceResolution } from "../lib/botTurnTrace.js";
import { DEFAULT_PHOTOS_PER_OFFER } from "../ai/photoOffer.js";
import type { PropertyCard, StoredAttachment } from "../ai/shared.js";
import { PROPERTY_TYPE_LABELS } from "../ai/agencyVoice.js";
import { crmPublicBase, publicUploadUrl } from "../lib/crmPublicUrl.js";
import { describeError } from "../lib/describeError.js";
import { messagePhotoPath } from "../lib/messagePhoto.js";
import { siteListingUrl } from "../lib/siteListingUrl.js";
import { botOfferableWhere, botOfferLink } from "../lib/propertyMatch.js";
import { logSystemError } from "../lib/systemError.js";
import { customerTransportInput, resolveCustomerEndpoint, type CustomerTransportHint, type CustomerTransportReference } from "../lib/customerConversationScope.js";
import {
  linkConversationPropertyByChannel,
} from "../lib/propertyVoice/linkConversation.js";
import { isInstagramLink } from "../lib/instagramLink.js";
import { photoGapMs, sleep } from "./humanPacing.js";
import { clientSharedPostCodes, isClientOwnSharedPost } from "./clientSharedPosts.js";
import {
  asMetaChannel,
  isMetaChannelEnabled,
  sendImage,
  sendLocation,
  sendMessage,
  showReadAndTyping,
  type MetaChannel,
} from "./meta.js";

/**
 * Бот показывает объект клиенту прямо в переписке.
 *
 * Решение «пора показать» принимает модель (см. ai/photoOffer.ts), а этот модуль
 * отвечает за всё остальное: найти объект, собрать снимки, отправить их в канал и
 * вернуть то, что нужно записать в переписку CRM.
 *
 * Фотографии берутся ТОЛЬКО из нашей базы (Property.photos). Старой телеграм-базы
 * объектов больше нет — агенты заводят квартиры прямо в CRM, и другого источника
 * снимков у бота быть не должно.
 *
 * СПОСОБ ПОКАЗА ЗАВИСИТ ОТ КАНАЛА, потому что «естественно» в каждом своё:
 *  - Instagram, и у объекта есть наша публикация (instagramUrl ведёт именно на
 *    instagram.com) — уходит ССЫЛКА НА ПОСТ.
 *    Там весь альбом и видео, ссылка открывается внутри самого приложения, и человек
 *    видит живой пост с реакциями. Это сильнее набора картинок;
 *  - Instagram без публикации — фотографии, как везде;
 *  - WhatsApp и Messenger — наоборот, ФОТОГРАФИИ прямо в чат плюс ссылка на карточку
 *    сайта. Ссылка на Instagram отсюда означала бы уход в другое приложение, и половина
 *    клиентов туда просто не дойдёт.
 *
 * Главное правило — НЕ РОНЯТЬ ХОД. Показ приятен, но текст ответа важнее: если Meta не
 * забрала картинку, публичный адрес CRM не настроен или у объекта вовсе нет фото, клиент
 * обязан получить обычный ответ. Поэтому наружу отсюда не летит ни одного исключения, а
 * каждый отказ уходит в журнал через logSystemError — молчаливый провал означал бы, что
 * фотографии не доходят месяцами, а на экране здоровья зелено.
 */

/** Тип содержимого по расширению: и Meta, и браузер CRM должны знать, что это картинка. */
const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

/** Одно фото, готовое к отправке. */
export interface SendablePhoto {
  /** Абсолютный адрес JPEG-версии — по нему картинку забирает Meta со своих серверов. */
  publicUrl: string;
  /** Оригинал относительным путём — так фотография показывается внутри CRM. */
  path: string;
  mime: string;
}


const NOTHING: ShowcaseResult = { attachments: [], link: null, deliveryStatus: "not_sent" };

function mediaDeliveryStatus(attachments: StoredAttachment[], linkMid?: string | null): "sent" | "unknown" {
  return attachments.some((attachment) => !!attachment.mid) || !!linkMid ? "sent" : "unknown";
}

/**
 * Сколько один и тот же объект не показывается собеседнику повторно.
 *
 * Раньше предохранителя не было вовсе: единственной защитой от второго показа было
 * то, что модель ВИДИТ в переписке реплику с фотографиями. Но история обрезается до
 * последних сорока реплик, ход бывает параллельным (клиент пишет в двух каналах), а
 * модель просто ошибается — и клиент получал те же три снимка второй раз. Для него
 * это признак робота, для нас — лишние сообщения в лимите переписок Meta.
 *
 * Неделя, а не «навсегда»: за один цикл поиска (а это дни, а не часы) человек
 * прекрасно помнит присланную квартиру, и повтор внутри недели — всегда наша ошибка.
 * Через неделю разговор обычно начинается заново, объект успевает подешеветь или
 * освободиться, и второй показ уже уместен — навечно запрещать его значило бы, что
 * вернувшемуся через месяц клиенту бот отказывается показать ту самую квартиру,
 * ради которой он и вернулся.
 */
const SHOW_AGAIN_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Умеет ли канал отправить фотографии прямо в переписку.
 *
 * Ровно то же условие, по которому showPropertyToClient решает, работать ему или
 * молча вернуть пустоту, — но вынесенное наружу, чтобы ПРОМТ знал о нём заранее.
 * Иначе модель обещает снимки в канале, где их не отправить (см. ai/photoOffer.ts).
 */
export function canShowPhotos(channel: string): boolean {
  return asMetaChannel(channel) !== null;
}

/**
 * Умеет ли канал показать карточку объекта (23.08.2026) — шире, чем canShowPhotos:
 * у Meta это настоящие фотографии в чат, у сайта — карточка с одним снимком. НЕ
 * путать с canShowPhotos напрямую в остальном коде: гид покупателя (файл, см.
 * describeShowcase в conversation.ts) остаётся Meta-only — доставки файла в чат на
 * сайте не построено, и обещать его было бы враньём.
 */
export function canShowPropertyCard(channel: string): boolean {
  return asMetaChannel(channel) !== null || channel === "WEBSITE";
}

/**
 * Объекты, снимки которых этот собеседник уже получал и повторно не получит.
 *
 * Нужно промту, а не отправке: код и так не отправит второй раз, но модель об этом
 * не знает и пишет «ана расмҳояш». Пустой список при отказе базы — то же решение, что
 * и в wasShownRecently: лучше возможный повтор, чем сорванный ход.
 */
export async function recentlyShownShortIds(channel: string, recipientId: string, transport?: CustomerTransportHint): Promise<number[]> {
  // canShowPropertyCard, не canShowPhotos: у сайта карточка — тот же полноценный
  // показ, что и фото у Meta, и повторять его так же незачем (см. showPropertyToClient).
  if (!canShowPropertyCard(channel)) return [];
  try {
    const endpoint = await resolveCustomerEndpoint(customerTransportInput(channel, recipientId, transport));
    const marks = await prisma.shownProperty.findMany({
      where: {
        endpointScopeId: endpoint.endpointScopeId,
        channel,
        recipientId,
        sentAt: { gte: new Date(Date.now() - SHOW_AGAIN_AFTER_MS) },
      },
      select: { shortId: true },
      orderBy: { sentAt: "desc" },
      // Предел выборки: за неделю показов у одного собеседника единицы, но роут,
      // возвращающий массив, обязан иметь потолок — иначе однажды он вернёт всё.
      take: 20,
    });
    return marks.map((m) => m.shortId);
  } catch (err) {
    void logSystemError("meta", `Отметки показов не прочитаны: ${describeError(err)}`);
    return [];
  }
}

/**
 * ПОКАЗАННОЕ В ДРУГИХ КАНАЛАХ ТОГО ЖЕ ЧЕЛОВЕКА (ревизия бота 02.10.2026, сравнение
 * с лучшими ассистентами). Отметки показов живут по каналу, а человек один:
 * написал в Instagram, через неделю — в WhatsApp, и получал тот же объект, что уже
 * видел. Досье (ContactProfile) связывает его переписки; по нему и собираем.
 */
export async function shownShortIdsInOtherChannels(
  profileId: string | null | undefined,
  channel: string,
  recipientId: string
): Promise<number[]> {
  if (!profileId) return [];
  try {
    const others = await prisma.botConversation.findMany({
      where: { contactProfileId: profileId, NOT: { channel: channel as never, subscriberId: recipientId } },
      select: { channel: true, subscriberId: true },
      take: 10,
    });
    if (others.length === 0) return [];
    const marks = await prisma.shownProperty.findMany({
      where: {
        OR: others.map((o) => ({ channel: o.channel, recipientId: o.subscriberId })),
        sentAt: { gte: new Date(Date.now() - SHOW_AGAIN_AFTER_MS) },
      },
      select: { shortId: true },
      orderBy: { sentAt: "desc" },
      take: 20,
    });
    return marks.map((m) => m.shortId);
  } catch (err) {
    void logSystemError("meta", `Показы в других каналах не прочитаны: ${describeError(err)}`);
    return [];
  }
}

/** Refuse a possible duplicate if history cannot be checked. The text reply
 * remains available and is reconciled against not_sent, without borrowing history. */
async function wasShownRecently(channel: string, recipientId: string, shortId: number, endpointScopeId: string): Promise<boolean> {
  try {
    const mark = await prisma.shownProperty.findUnique({
      where: { endpointScopeId_recipientId_shortId: { endpointScopeId, recipientId, shortId } },
      select: { sentAt: true },
    });
    if (mark && Date.now() - mark.sentAt.getTime() < SHOW_AGAIN_AFTER_MS) return true;
    const [policy] = await prisma.$queryRaw<{ contractVersion: string }[]>`SELECT "contractVersion" FROM "CustomerRuntimePolicy" WHERE "id" = 'singleton'`;
    if (policy?.contractVersion === "scoped") return false;
    // Gate A still has the old global index. An unknown recent mark suppresses
    // a possible duplicate conservatively; it does not become customer memory.
    const legacy = await prisma.shownProperty.findUnique({ where: { channel_recipientId_shortId: { channel, recipientId, shortId } },
      select: { sentAt: true, endpointScopeId: true } });
    return !!legacy && ((legacy.endpointScopeId !== null && legacy.endpointScopeId !== endpointScopeId) ||
      Date.now() - legacy.sentAt.getTime() < SHOW_AGAIN_AFTER_MS);
  } catch (err) {
    void logSystemError("meta", `Отметка показа объекта №${shortId} не прочитана: ${describeError(err)}`);
    return true;
  }
}

/**
 * Отмечает объект показанным. upsert, а не create: отметка старше недели должна
 * обновиться, а не упереться в уникальный ключ.
 *
 * Заодно подчищаем просроченные отметки этого же собеседника — они уже ничего не
 * значат, а расти таблице без предела незачем. Отдельный ночной job ради трёх строк
 * заводить не стоит, а отказ уборки на сам показ влиять не должен.
 */
async function markShown(channel: string, recipientId: string, shortId: number, transport: CustomerTransportReference): Promise<void> {
  const { endpointScopeId } = transport;
  const now = new Date();
  try {
    await prisma.$transaction(async tx => {
      await resolveCustomerEndpoint(customerTransportInput(channel, recipientId, transport), tx);
      const [policy] = await tx.$queryRaw<{ contractVersion: string }[]>`SELECT "contractVersion" FROM "CustomerRuntimePolicy" WHERE "id" = 'singleton' FOR SHARE`;
      if (policy?.contractVersion === "scoped") {
        await tx.shownProperty.upsert({ where: { endpointScopeId_recipientId_shortId: { endpointScopeId, recipientId, shortId } },
          update: { sentAt: now }, create: { channel, recipientId, shortId, endpointScopeId, sentAt: now } });
        return;
      }
      const legacy = await tx.shownProperty.findUnique({ where: { channel_recipientId_shortId: { channel, recipientId, shortId } },
        select: { id: true, endpointScopeId: true } });
      if (legacy) {
        // This stamp represents a NEW observed send in the current scope. It
        // neither reclassifies the old history nor overwrites another account.
        const changed = await tx.shownProperty.updateMany({ where: { id: legacy.id,
          OR: [{ endpointScopeId: null }, { endpointScopeId }] }, data: { endpointScopeId, sentAt: now } });
        if (!changed.count) throw new Error("Shown-property mark belongs to another account");
      } else await tx.shownProperty.create({ data: { channel, recipientId, shortId, endpointScopeId, sentAt: now } });
    });
    await prisma.shownProperty.deleteMany({
      where: { channel, recipientId, endpointScopeId, sentAt: { lt: new Date(now.getTime() - SHOW_AGAIN_AFTER_MS) } },
    });
  } catch (err) {
    // Не роняем ход: фотографии клиент уже получил, а без отметки худшее, что будет, —
    // возможный повтор. Молчать об этом всё же нельзя: если таблица недоступна, повторы
    // пойдут по всем диалогам сразу.
    void logSystemError("meta", `Показ объекта №${shortId} не отмечен: ${describeError(err)}`);
  }
}

/**
 * Записывает в журнал, что объект реально ушёл этому человеку.
 *
 * Отдельно от markShown нарочно. markShown — предохранитель отправки: живёт
 * неделю и сам себя стирает, потому что «не слать те же фото дважды» через
 * неделю уже неверно. Здесь — история, и стирать её нельзя: на ней держится
 * правило владельца от 11.08.2026 «бот показал объект — лид уходит хозяину
 * объекта». Если бы запись жила в той же таблице, недельная уборка тихо
 * отменяла бы правило ровно тогда, когда клиент возвращается подумавши.
 *
 * clientId у показа бота почти всегда неизвестен: бот показывает объекты РАНЬШЕ,
 * чем узнаёт телефон, то есть раньше, чем карточка клиента вообще заводится —
 * мост тогда пара (канал, собеседник), карточка привяжется задним числом
 * (см. leads.ts, createLeadFromChannel). Ручная отправка агентом из карточки
 * клиента (routes/clients/matching.ts::send-properties) карточку уже знает —
 * ей есть смысл передать clientId сразу, необязательный параметр.
 *
 * Отказ записи ход не роняет: фотографии клиент уже получил, и разрывать из-за
 * журнала живой разговор нельзя. Но и молчать нельзя — без этих строк правило
 * перестаёт срабатывать, а выглядеть это будет как «CRM раздаёт лиды не тем».
 *
 * Экспортирована (31.08.2026), чтобы ручная отправка объекта агентом переиспользовала
 * этот же Prisma-вызов вместо второй копии — до этого она писала только обычную
 * хронологию (Interaction) и правило «own_property_shown» на неё не срабатывало.
 */
export async function recordExposure(
  channel: string,
  recipientId: string,
  propertyId: string,
  shortId: number,
  kind: "PHOTO" | "LINK",
  clientId?: string,
  transport?: CustomerTransportHint
): Promise<void> {
  try {
    const endpoint = await resolveCustomerEndpoint(customerTransportInput(channel, recipientId, transport));
    await prisma.propertyExposure.create({
      data: { channel, recipientId, propertyId, shortId, kind, clientId, endpointScopeId: endpoint.endpointScopeId },
    });
    // «Голос рынка»: показ объекта — след в диалоге (lib/propertyVoice). Не ждём и
    // не роняем: хелпер сам пишет отказ в журнал и ничего не бросает.
    void linkConversationPropertyByChannel({ channel, recipientId, transport: endpoint, propertyId, source: "EXPOSURE" });
  } catch (err) {
    void logSystemError("meta", `Показ объекта №${shortId} не записан в журнал: ${describeError(err)}`);
  }
}


/**
 * Привязывает показы этой переписки к появившейся карточке клиента.
 *
 * Вызывается один раз — в момент, когда из разговора родился лид. До этого
 * записи журнала висят на паре (канал, собеседник): бот показывает объекты
 * раньше, чем узнаёт телефон, и именно те, ранние, показы и есть самые ценные —
 * клиент выбирал по ним.
 *
 * Отказ не роняет приём заявки: карточка клиента важнее журнала. Но записать
 * отказ обязательно — без привязки правило «свой объект» промахнётся молча.
 */
export async function linkExposuresToClient(
  channel: string,
  recipientId: string,
  clientId: string,
  transport?: CustomerTransportHint
): Promise<void> {
  try {
    const endpoint = await resolveCustomerEndpoint(customerTransportInput(channel, recipientId, transport));
    await prisma.propertyExposure.updateMany({
      where: { channel, recipientId, endpointScopeId: endpoint.endpointScopeId, clientId: null },
      data: { clientId },
    });
  } catch (err) {
    void logSystemError("meta", `Показы объектов не привязаны к клиенту: ${describeError(err)}`);
  }
}

/**
 * То же самое свойство «объект существует, доступен, опубликован» (см.
 * findShowableProperty ниже), но с полями под карточку сайта — цена, площадь,
 * комнаты, район, адрес — которые Meta-показу не нужны, а тут единственный
 * источник данных.
 */
async function findCardProperty(shortId: number) {
  return prisma.property.findFirst({
    // Что ботам можно предлагать — одно правило с подборкой (lib/propertyMatch.ts, P0-5).
    where: { shortId, status: "AVAILABLE", AND: [botOfferableWhere()] },
    select: {
      id: true,
      shortId: true,
      publishedOnSite: true,
      siteListingId: true,
      instagramUrl: true,
      type: true,
      rooms: true,
      price: true,
      currency: true,
      areaSqm: true,
      address: true,
      district: { select: { name: true } },
      // Владелец 23.08.2026: «сделай так, чтобы можно было все смотреть в
      // карточке» — виджету нужна вся галерея, не только обложка. Разумный
      // потолок, а не все подряд: у части объектов фотографий за полсотни, и
      // отдавать их все раздуло бы каждый опрос виджета без всякой пользы.
      photos: { orderBy: { order: "asc" }, take: 12, select: { url: true } },
    },
  });
}

/** Формат ровно как в подборке объектов промта (ai/leadQualifier.ts,
 *  searchMatchingProperties) — один и тот же объект не должен выглядеть по-разному
 *  в тексте бота и в собственной карточке под этим же текстом. */
function toPropertyCard(property: NonNullable<Awaited<ReturnType<typeof findCardProperty>>>, siteUrl: string): PropertyCard {
  const title = property.rooms ? `${property.rooms}-комн` : PROPERTY_TYPE_LABELS[property.type] ?? property.type;
  const price = `${Number(property.price).toLocaleString("ru-RU")} ${property.currency === "USD" ? "$" : "с."}`;
  const photoUrls = property.photos.map((p) => publicUploadUrl(p.url)).filter((url): url is string => url !== null);
  return {
    shortId: property.shortId,
    title,
    price,
    rooms: property.rooms ?? undefined,
    areaSqm: property.areaSqm ? Number(property.areaSqm) : undefined,
    district: property.district?.name ?? "",
    address: property.address?.trim() || undefined,
    photoUrl: photoUrls[0] ?? null,
    photoUrls,
    // Ссылка — общим botOfferLink: у объекта не с сайта страницы там нет, и прежний
    // запасной by-crm адрес вёл на пустую страницу; вместо неё — пост Instagram.
    siteUrl,
  };
}

/** Объект, который бот собирается показать. Условия те же, что у подборки в промте
 *  (доступен, опубликован, не в Корзине): номер приходит от модели, а она может назвать
 *  и объект, которого в подборке не было. Показать клиенту проданную или скрытую
 *  квартиру хуже, чем не показать ничего, поэтому фильтр повторяется, а не подразумевается. */
async function findShowableProperty(shortId: number, photosPerOffer: number) {
  return prisma.property.findFirst({
    // Что ботам можно предлагать — одно правило с подборкой (lib/propertyMatch.ts, P0-5).
    where: { shortId, status: "AVAILABLE", AND: [botOfferableWhere()] },
    select: {
      id: true,
      publishedOnSite: true,
      siteListingId: true,
      instagramUrl: true,
      lat: true,
      lng: true,
      photos: {
        orderBy: { order: "asc" },
        // Ограничение стоит В ЗАПРОСЕ, а не после него: у объекта бывает и тридцать
        // снимков, и тянуть их все, чтобы выбросить, незачем.
        take: photosPerOffer,
        select: { url: true },
      },
    },
  });
}

/**
 * Публичные адреса снимков объекта — не больше photosPerOffer штук.
 *
 * Наружу уходит НЕ оригинал: CRM хранит фотографии в WebP, а сообщение типа `image`
 * у WhatsApp принимает только JPEG и PNG. Двойник в JPEG готовится один раз и лежит
 * рядом, в той же публичной папке (см. lib/messagePhoto.ts). В переписке CRM при этом
 * остаётся оригинал — браузер показывает WebP без всяких оговорок.
 */
export async function toSendablePhotos(
  photos: { url: string }[],
  photosPerOffer = DEFAULT_PHOTOS_PER_OFFER
): Promise<SendablePhoto[]> {
  const prepared = await Promise.all(
    photos.slice(0, photosPerOffer).map(async (photo) => {
      // Перекодирование — работа с диском, и трёх снимков она не стоит по очереди:
      // порядок здесь сохраняет Promise.all, а не последовательность вызовов.
      const jpegPath = await messagePhotoPath(photo.url);
      // Без публичного адреса CRM ссылку наружу собрать не из чего: Meta забирает
      // картинку сама, и относительный путь для неё бессмыслен.
      const publicUrl = jpegPath ? publicUploadUrl(jpegPath) : null;
      if (!publicUrl) return null;
      const ext = photo.url.split(".").pop()?.toLowerCase() ?? "";
      return { publicUrl, path: photo.url, mime: MIME_BY_EXT[ext] ?? "image/jpeg" };
    })
  );
  return prepared.filter((photo): photo is SendablePhoto => photo !== null);
}

/**
 * Показывает объект клиенту в его канале и возвращает то, что реально ушло.
 *
 * `shortId` необязателен нарочно: вызывающий передаёт сюда решение модели как есть, и
 * «показывать нечего» не должно превращаться в ветку `if` на каждом ходе диалога.
 *
 * Пустой результат — нормальный ответ: канал не наш (у Telegram такой
 * отправки нет), рубильник выключен, объект не найден, отправка не удалась.
 */
export async function showPropertyToClient(
  channel: string,
  recipientId: string,
  shortId: number | null | undefined,
  /**
   * Что бот уже писал этому человеку в последних сообщениях. Нужно ровно для
   * одного: не отправить ссылку, которая уже уходила. 01.08 клиент получил один и
   * тот же адрес дважды подряд — сначала модель дала его текстом, а следом код
   * приложил его же к фотографиям. Модели запрещено повторять ссылку в СВОЁМ
   * тексте, но про ссылку, отправленную ходом РАНЬШЕ, она знать не может.
   */
  recentBotText = "",
  /** Сколько снимков отправить (Настройки → Бот). Приходит снаружи, а не читается
   *  здесь: это же число уже ушло в промт, и обещание «до N штук» обязано совпасть
   *  с тем, что клиент реально получит. */
  photosPerOffer = DEFAULT_PHOTOS_PER_OFFER,
  /** Маркер аккаунта, в который написал клиент (messengers/accounts.ts): фотографии
   *  и ссылка обязаны уйти тем же аккаунтом, что и текст ответа. */
  accountToken?: string,
  /**
   * Рубильник ссылок бота (Настройки → Бот, capabilities.links). Выключен — ни ссылку
   * на публикацию Instagram, ни адрес карточки сайта не шлём: показ идёт одними
   * фотографиями (CHANNEL-NEW-32). Раньше этот путь о рубильнике не знал, и ссылки
   * уходили в обход запрета, который держит обычный текст ответа.
   */
  canSendLinks = true,
  transport?: CustomerTransportHint
): Promise<ShowcaseResult> {
  if (!shortId) return NOTHING;
  let capturedTransport: CustomerTransportReference;
  try {
    capturedTransport = await resolveCustomerEndpoint(customerTransportInput(channel, recipientId, transport));
  } catch (error) {
    void logSystemError("meta", `Аккаунт показа объекта не определён: ${describeError(error)}`);
    return NOTHING;
  }
  const { endpointScopeId } = capturedTransport;

  /**
   * ЧАТ НА САЙТЕ — КАРТОЧКА ВМЕСТО ФОТО+ССЫЛКИ (владелец 23.08.2026: «карточка с
   * фото, ценой и прочей важной информацией, чтобы не выходя из чата клиент мог
   * узнать, а потом кнопка, если хочет посмотреть объект»).
   *
   * Отдельная ветка ДО проверки Meta-канала (сайт им не является и попал бы в
   * молчаливый пропуск ниже). Предохранитель от повторного показа (wasShownRecently/
   * markShown) и запись для отчётов (recordExposure) — те же самые функции, что и у
   * Meta: одна неделя без повтора верна для любого канала одинаково, а разная логика
   * в двух местах разошлась бы молча при первой же правке одного из них.
   */
  if (channel === "WEBSITE") {
    try {
      if (await wasShownRecently(channel, recipientId, shortId, endpointScopeId)) return NOTHING;
      const property = await findCardProperty(shortId);
      traceResolution("showcase", property?.id);
      if (!property) return NOTHING;
      // Ни страницы на сайте, ни поста — карточке вести некуда, ссылку не придумываем:
      // объект остаётся в тексте ответа, карточки под ним нет.
      const siteUrl = botOfferLink(property, "site");
      if (!siteUrl) return NOTHING;
      await markShown(channel, recipientId, shortId, capturedTransport);
      await recordExposure(channel, recipientId, property.id, shortId, "PHOTO", undefined, capturedTransport);
      return { attachments: [], link: null, websiteCard: toPropertyCard(property, siteUrl), deliveryStatus: "prepared" };
    } catch (err) {
      // Тот же принцип, что и у Meta-ветки ниже: показ приятен, но ронять ход
      // нельзя — клиент получит обычный текстовый ответ без карточки.
      void logSystemError("meta", `Карточка объекта №${shortId} для сайта не собрана: ${describeError(err)}`);
      return NOTHING;
    }
  }

  // Показываем только туда, куда ходим сами. У прочих каналов такого вызова нет
  // вовсе, и молчаливый пропуск здесь честнее выдуманной поддержки.
  const metaChannel = asMetaChannel(channel);
  if (!metaChannel) return NOTHING;

  // Provider acceptance survives a later local statistics/history failure.
  let observed: ShowcaseResult = NOTHING;
  try {
    if (!(await isMetaChannelEnabled(metaChannel))) return NOTHING;

    // Предохранитель от второго показа — до всякой работы: и до выборки объекта с
    // фотографиями, и до перекодирования снимков. Возвращаем not_sent: финальный
    // текст не должен обещать отправленные фотографии, если отправки не было.
    if (await wasShownRecently(metaChannel, recipientId, shortId, endpointScopeId)) return NOTHING;

    const property = await findShowableProperty(shortId, photosPerOffer);
    traceResolution("showcase", property?.id);
    if (!property) return NOTHING;

    // Instagram + своя публикация: пост сильнее набора картинок, и ссылка на него
    // открывается внутри приложения, не уводя человека никуда.
    //
    // ПРОВЕРЯЕМ, что это действительно адрес Instagram, а не просто заполненное поле.
    // Схема требует от instagramUrl лишь быть URL, и у части объектов там лежит
    // ссылка на Telegram — видео-обзор снят и выложен туда. Такая ссылка, отправленная
    // в директ Instagram, для клиента мертва: приложение уводит его на страницу, куда
    // он не заходил и часто вовсе не может. Лучше обычный показ фотографиями ниже.
    if (canSendLinks && metaChannel === "INSTAGRAM" && isInstagramLink(property.instagramUrl)) {
      if (recentBotText.includes(property.instagramUrl)) return NOTHING;
      // Ту же публикацию клиент прислал нам сам (25.09.2026, см.
      // messengers/clientSharedPosts.ts): слать её обратно — вернуть человеку его
      // же рилс. Он её уже смотрит, ответ бота текстом про объект и так уходит.
      if (isClientOwnSharedPost(property.instagramUrl, clientSharedPostCodes(metaChannel, recipientId))) return NOTHING;
      const postLink = await sendLink(metaChannel, recipientId, property.instagramUrl, shortId, accountToken, capturedTransport);
      if (!postLink.ok) return NOTHING;
      observed = { attachments: [], link: property.instagramUrl, linkMid: postLink.mid,
        deliveryStatus: postLink.mid ? "sent" : "unknown" };
      // Ссылка на пост — это тот же показ объекта, и повторять её так же незачем.
      await markShown(metaChannel, recipientId, shortId, capturedTransport);
      await recordExposure(metaChannel, recipientId, property.id, shortId, "LINK", undefined, capturedTransport);
      return observed;
    }

    // Публичный адрес CRM проверяем ОТДЕЛЬНО и ПЕРВЫМ. Без него ни у одной фотографии
    // не будет внешнего адреса, и раньше это выглядело в журнале как «подходящих
    // фотографий нет» — то есть как проблема конкретного объекта. На деле не уходит
    // НИ ОДНА фотография НИ ПО ОДНОМУ объекту, и чинится это одной строкой в
    // окружении, а не карточкой. Разница между «у этой квартиры нет снимков» и «показ
    // не работает вообще» — это разница между «ну и ладно» и «чините сегодня».
    if (!crmPublicBase()) {
      void logSystemError(
        "meta",
        "Фотографии объектов не отправляются НИ ОДНОМУ клиенту: не задан CRM_PUBLIC_URL — " +
          "внешний адрес CRM, по которому Meta забирает картинку. Пока он пуст, бот показывает только ссылки."
      );
      return NOTHING;
    }

    const photos = await toSendablePhotos(property.photos, photosPerOffer);
    if (photos.length === 0) {
      // Здесь остаётся честное «у этого объекта нечего показать»: либо в карточке нет
      // ни одного снимка, либо ни один не удалось перекодировать в JPEG.
      void logSystemError("meta", `Объект №${shortId} не показан: подходящих фотографий нет`);
      return NOTHING;
    }

    const attachments: StoredAttachment[] = [];
    for (const photo of photos) {
      try {
        // Строго по очереди, а не Promise.all: клиент должен увидеть снимки в том же
        // порядке, в каком они лежат в карточке, а пачку одновременных запросов к
        // одному получателю Meta считает поводом придержать отправку.
        //
        // Между снимками — пауза и «печатает…»: человек за телефоном выбирает и
        // прикладывает следующую фотографию несколько секунд, а не выкладывает три
        // штуки в одну секунду. Перед ПЕРВОЙ паузы нет нарочно: клиент только что
        // попросил фото, и ждать неизвестно чего он не должен.
        if (attachments.length > 0) await humanGap(metaChannel, recipientId, accountToken, capturedTransport);
        const mid = await sendImage(metaChannel, recipientId, photo.publicUrl, accountToken, capturedTransport);
        attachments.push({ kind: "image", url: photo.path, mime: photo.mime, ...(mid ? { mid } : {}) });
        observed = { attachments, link: null, deliveryStatus: mediaDeliveryStatus(attachments) };
      } catch {
        // Причину уже записал sendImage. Останавливаемся на первом отказе: если Meta не
        // смогла забрать одну нашу картинку, остальные она не заберёт тем более, а
        // очередь неудачных запросов только задержит текстовый ответ клиенту.
        break;
      }
    }
    if (attachments.length === 0) return NOTHING;

    // Отмечаем ДО ссылки: фотографии уже у клиента, и повторять их нельзя независимо
    // от того, дойдёт ли ссылка на карточку.
    await markShown(metaChannel, recipientId, shortId, capturedTransport);
    // Фотографии — уже полноценный показ: клиент видел именно эту квартиру,
    // дошла ли следом ссылка на карточку или нет.
    await recordExposure(metaChannel, recipientId, property.id, shortId, "PHOTO", undefined, capturedTransport);

    // Геометка — сразу за фотографиями, ДО ссылки на сайт: клиент чаще всего
    // сначала смотрит снимки и хочет понять, где это, а не читает карточку сайта.
    // Только WhatsApp: у Instagram/Messenger Send API нет типа сообщения "location".
    let locationLink: string | null = null;
    let locationMid: string | undefined;
    if (metaChannel === "WHATSAPP" && property.lat != null && property.lng != null) {
      const lat = Number(property.lat);
      const lng = Number(property.lng);
      const mapsLink = `https://maps.google.com/?q=${lat},${lng}`;
      if (!recentBotText.includes(mapsLink)) {
        try {
          await humanGap(metaChannel, recipientId, accountToken, capturedTransport);
          const mid = await sendLocation(recipientId, lat, lng, undefined, undefined, accountToken, capturedTransport);
          locationLink = mapsLink;
          locationMid = mid ?? undefined;
          observed = { ...observed, locationLink, locationMid };
        } catch {
          // Причину уже записал sendLocation. Показ фотографий уже состоялся —
          // отсутствие геометки не повод откатывать или прерывать остальной ход.
        }
      }
    }

    // Одна ссылка на карточку сайта следом за фотографиями — там подробности, которых
    // в трёх снимках нет. Отправка ссылки не обязана удаться: фото уже у клиента.
    const siteUrl = canSendLinks ? siteListingUrl(property) : null;
    if (!siteUrl) return { attachments, link: null, locationLink, locationMid, deliveryStatus: mediaDeliveryStatus(attachments) };
    // Ссылка уже уходила этому человеку — второй раз она не нужна. Фотографии при
    // этом отправлены: их он ещё не видел, а адрес карточки видел.
    if (recentBotText.includes(siteUrl)) return { attachments, link: null, locationLink, locationMid, deliveryStatus: mediaDeliveryStatus(attachments) };
    await humanGap(metaChannel, recipientId, accountToken, capturedTransport);
    const siteLink = await sendLink(metaChannel, recipientId, siteUrl, shortId, accountToken, capturedTransport);
    return { attachments, link: siteLink.ok ? siteUrl : null, linkMid: siteLink.mid, locationLink, locationMid,
      deliveryStatus: mediaDeliveryStatus(attachments, siteLink.mid) };
  } catch (err) {
    // Сюда попадает всё незапланированное (недоступная база, отсутствующие ключи). Ход
    // диалога это ронять не должно: клиент получит текст, как раньше.
    void logSystemError("meta", `Объект №${shortId} не показан: ${describeError(err)}`);
    return observed;
  }
}

/**
 * Пауза между двумя сообщениями показа с индикатором «печатает…».
 *
 * Индикатор ставится ПЕРЕД сном и не ожидается (`void`): отправка предыдущего
 * сообщения гасит его, а показывать «печатает…» после паузы было бы поздно — клиент
 * увидел бы его вместе со следующей картинкой. Отказ Meta по индикатору наружу не
 * летит (см. showReadAndTyping), поэтому косметика не может сорвать показ.
 *
 * Тот же приём, что между двумя «пузырями» текста в routes/webhooks.ts — включая
 * его ограничение: у WhatsApp индикатор привязан к идентификатору входящего сообщения
 * (см. showReadAndTyping), а сюда он не доходит, и там остаётся только пауза. Пауза —
 * главное: именно залп из трёх картинок в одну секунду и выдаёт робота.
 */
async function humanGap(channel: MetaChannel, recipientId: string, accountToken: string | undefined, transport: CustomerTransportReference): Promise<void> {
  void showReadAndTyping(channel, recipientId, undefined, true, accountToken, transport);
  await sleep(photoGapMs());
}

/** Ссылка отдельным сообщением. Отказ не бросаем: причину уже записал sendMessage, а
 *  срывать из-за неё остальной ход нельзя. `mid` — тем же приёмом, что и у
 *  фотографий (17.08.2026, «воронка отправляет дважды»): без него эхо этой же
 *  ссылки неотличимо от ручного ответа сотрудника. */
async function sendLink(
  channel: MetaChannel,
  recipientId: string,
  url: string,
  shortId: number,
  accountToken: string | undefined,
  transport: CustomerTransportReference
): Promise<{ ok: boolean; mid: string | null }> {
  try {
    const mid = await sendMessage(channel, recipientId, url, accountToken, { transport });
    return { ok: true, mid };
  } catch {
    void logSystemError("meta", `Ссылка на объект №${shortId} не отправлена в ${channel}`);
    return { ok: false, mid: null };
  }
}
