/**
 * ИСТОРИИ INSTAGRAM (21.09.2026, владелец: «сделай нам истории, чтобы были») —
 * оркестрация над механикой Graph API из socialPublish.ts (publishInstagramStory,
 * checkInstagramPublishingLimit): решает КОГДА и ЧТО публиковать, режет длинный
 * ролик на части и пишет журнал PropertyStoryPost. socialPublish.ts сам ничего
 * не знает про Property — эта граница ответственности уже установлена
 * publishApprovedPost/videoHandoff.ts, здесь она сохранена.
 *
 * ИМЯ ФАЙЛА СОХРАНЕНО (28.09.2026, чтобы не ломать импорты), НО МОДУЛЬ ТЕПЕРЬ
 * ВЕДЁТ ОБЕ ПЛОЩАДКИ: во всех четырёх сценариях (видео-сегменты, «цена
 * снижена», «продано», карточка объекта) следом за Instagram то же самое
 * медиа уходит ЕЩЁ и в Page Stories Facebook (publishFacebookStoryVideo/
 * publishFacebookStoryImage, socialPublish.ts), если включён
 * Settings.facebookStoriesEnabled и заданы pageId/pageToken. Facebook
 * ПОВЕРХ Instagram, никогда вместо него: выключенные истории Instagram (и
 * не форсированный вызов) не публикуют вообще ничего, Facebook — только
 * бонус к уже идущей публикации. Отказ Facebook не трогает результат
 * Instagram и не входит в StoriesPublishSummary. Кулдаун повторов
 * (publishCardStory ниже) считается ПО ПАРЕ (kind, channel) — иначе
 * Facebook, включённый позже Instagram, никогда не получил бы свою историю.
 *
 * ИСТОРИИ — НЕ ПУБЛИКАЦИЯ В ЛЕНТЕ. Property.publishedChannels/publishedPostIds
 * этой публикацией НЕ трогаются (см. докстринг PropertyStoryPost в schema.prisma) —
 * от тех полей зависит повторная публикация, снятие постов и выход объекта в
 * продажу, а история исчезает сама через 24 часа и ничего из этого не значит.
 *
 * ВЫЗЫВАЕТСЯ ДВУМЯ ПУТЯМИ:
 *  - автоматически, сразу после успешной публикации Reels — lib/videoHandoff.ts::
 *    publishHandoffResult, ТОЛЬКО если Settings.instagramStoriesEnabled;
 *  - вручную, кнопкой «Выложить в истории» в карточке объекта — POST
 *    /properties/:id/instagram-stories-publish (routes/properties/videos.ts),
 *    рубильник не спрашивает (params.force), ровно как ручная публикация TikTok
 *    не спрашивает autoPublishEnabled. Settings.facebookStoriesEnabled force
 *    НЕ обходит — это не «обкатать автомат», а отдельное согласие показывать
 *    сторис на Странице вообще.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db.js";
import { loadCredentials, instagramTokenIdentity } from "../messengers/meta.js";
import {
  publishInstagramStory,
  publishInstagramStoryImage,
  checkInstagramPublishingLimit,
  publishFacebookStoryImage,
  publishFacebookStoryVideo,
} from "./socialPublish.js";
import { publicUploadUrl } from "./crmPublicUrl.js";
import { probeVideoDimensions, cutVideoSegment } from "./ffmpeg.js";
import { videoHandoffDir } from "../upload.js";
import { logSystemError } from "./systemError.js";
import { generateStoryCard, type GenerateStoryCardOptions } from "./video/storyCard.js";
import { describeError } from "./describeError.js";

/** Meta принимает в историю ролик не длиннее 60 секунд. */
const MAX_STORY_PART_SEC = 60;

/**
 * ОКНО ПРОДОЛЖЕНИЯ ОБОРВАННОЙ СЕРИИ (22.09.2026, класс «страховка ставится ПОСЛЕ
 * окна, которое должна страховать»). Серия из нескольких частей публикуется
 * минутами: каждая часть режется ffmpeg, грузится к Meta и ждёт обработки.
 * Перезапуск процесса посреди (автовыкат идёт по каждому мержу в main, их бывает
 * двадцать в день) обрывал серию НАВСЕГДА и молча: части 1-2 в Instagram, части
 * 3-4 нет, повтор задания в истории уже не заходил (он видел Instagram
 * опубликованным и пропускал канал целиком). Часть, опубликованная в этом окне,
 * считается частью ТЕКУЩЕЙ серии — её не публикуем заново, а продолжаем с
 * недостающих.
 *
 * Два часа: серия из четырёх частей укладывается в минуты даже при самой
 * медленной обработке у Meta, а сутки взяли бы уже вчерашнюю серию по тому же
 * объекту (истории живут 24 часа, владелец выкладывает их повторно).
 */
const SERIES_RESUME_WINDOW_MS = 2 * 60 * 60 * 1000;
const VIDEO_STORY_KIND = "VIDEO";

export interface StorySegmentPlan {
  startSec: number;
  durationSec: number;
}

/**
 * Делит длительность ролика на последовательные части не длиннее 60 секунд —
 * чистая арифметика, вынесена отдельно ради теста без реального ffmpeg.
 *
 * РОВНЫМИ частями, а не «60 + остаток»: ролик 67.5 с, порезанный как 60+7.5,
 * оставил бы зрителю почти пустую последнюю историю на пять кадров — с ровным
 * делением (2 части по 33.75 с) обе части нормальной длины. `durationSec <= 0`
 * либо `maxPartSec <= 0` возвращает пустой план — вызывающий код обязан сам
 * решить, что это отказ (probeVideoDimensions не смог определить длительность),
 * а не публиковать ролик нулевой длины.
 */
export function planStorySegments(durationSec: number, maxPartSec: number = MAX_STORY_PART_SEC): StorySegmentPlan[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || !Number.isFinite(maxPartSec) || maxPartSec <= 0) return [];
  if (durationSec <= maxPartSec) return [{ startSec: 0, durationSec }];
  const partCount = Math.ceil(durationSec / maxPartSec);
  const partLen = durationSec / partCount;
  return Array.from({ length: partCount }, (_, i) => ({ startSec: i * partLen, durationSec: partLen }));
}

export interface StoriesPublishSummary {
  /** false — рубильник выключен и это не ручной вызов, либо не настроен Instagram. */
  attempted: boolean;
  publishedParts: number;
  totalParts: number;
  error?: string;
}

/**
 * `localVideoPath` — путь вида `/uploads/handoff/xxx.mp4` (тот же формат, что
 * принимает publishApprovedPost). Части режутся во временные файлы рядом (в
 * videoHandoffDir) и удаляются после публикации вне зависимости от исхода.
 *
 * Останавливается на первой неудавшейся части (не долбит Graph API дальше —
 * пункт задачи про лимит публикаций тот же довод: если Meta отказала один раз
 * подряд, вероятность, что следующая часть пройдёт, невысока, а очередь
 * отказов в журнале читать тяжелее одной понятной записи). Уже опубликованные
 * части остаются опубликованными — истории нельзя «откатить», и это ожидаемо.
 */
export async function publishPropertyInstagramStories(
  propertyId: string,
  localVideoPath: string,
  options?: { force?: boolean; resumeOnly?: boolean }
): Promise<StoriesPublishSummary> {
  const empty: StoriesPublishSummary = { attempted: false, publishedParts: 0, totalParts: 0 };
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { instagramStoriesEnabled: true, facebookStoriesEnabled: true },
  });
  if (!options?.force && !settings?.instagramStoriesEnabled) return empty;

  // force обходит только рубильник, а не проверку ролика модератором: ролик на
  // проверке («без Одобрить в сети не выйдет», lib/clipReview.ts) не уходит в
  // истории и у будущего вызывающего, который забудет гейт сам (аудит 04.10.2026, PUB09).
  if (options?.force) {
    const review = await prisma.property.findUnique({ where: { id: propertyId }, select: { clipReviewStatus: true } });
    if (review?.clipReviewStatus === "PENDING") {
      return { attempted: false, publishedParts: 0, totalParts: 0, error: "Ролик ждёт проверки модератора — истории не опубликованы" };
    }
  }

  // Части текущей серии, уже успевшие уйти в Instagram (см.
  // SERIES_RESUME_WINDOW_MS). Запрос дешёвый и идёт до всякой сети: в режиме
  // продолжения, когда продолжать нечего, дальше идти незачем вовсе.
  // channel: "INSTAGRAM" (28.09.2026) — теперь в этом же окне могут лежать и
  // строки FACEBOOK (см. ниже): без фильтра уже вышедшая в Facebook, но не в
  // Instagram часть считалась бы «сделанной» и Instagram пропустил бы её.
  const alreadyPublished = await prisma.propertyStoryPost.findMany({
    where: {
      propertyId,
      kind: VIDEO_STORY_KIND,
      channel: "INSTAGRAM",
      publishedAt: { gte: new Date(Date.now() - SERIES_RESUME_WINDOW_MS) },
    },
    select: { partIndex: true },
  });
  const donePartIndexes = new Set(alreadyPublished.map((r) => r.partIndex));
  // resumeOnly — вызов «доделай, если что-то оборвалось» (lib/videoHandoff.ts
  // зовёт его на каждой попытке публикации). Нетронутую серию он НЕ начинает:
  // иначе повтор задания через неделю выложил бы истории заново сам по себе.
  if (options?.resumeOnly && donePartIndexes.size === 0) return empty;

  const creds = await loadCredentials();
  if (!creds.igToken) {
    const error = "Instagram не подключён — нечем публиковать истории";
    void logSystemError("meta", `Истории Instagram (объект ${propertyId}): ${error}`);
    return { attempted: true, publishedParts: 0, totalParts: 0, error };
  }

  const identity = await instagramTokenIdentity(creds.igToken);
  if (!identity.ok) {
    void logSystemError("meta", `Истории Instagram (объект ${propertyId}): не удалось определить аккаунт — ${identity.error}`);
    return { attempted: true, publishedParts: 0, totalParts: 0, error: identity.error };
  }

  // Facebook (28.09.2026) — ПОВЕРХ Instagram, под своим тумблером, всегда
  // проверяемым (в отличие от instagramStoriesEnabled его не обходит force —
  // «под своим тумблером» значит именно это). Отказ здесь не мешает Instagram:
  // просто ниже не публикуем и в Facebook.
  const facebookReady = !!settings?.facebookStoriesEnabled && !!creds.pageId && !!creds.pageToken;

  if (!localVideoPath.startsWith("/uploads/")) {
    const error = "Путь к ролику не из /uploads — нечем публиковать истории";
    void logSystemError("meta", `Истории Instagram (объект ${propertyId}): ${error}`);
    return { attempted: true, publishedParts: 0, totalParts: 0, error };
  }
  const videoDiskPath = path.join(videoHandoffDir, path.basename(localVideoPath));
  const dims = await probeVideoDimensions(videoDiskPath);
  if (!dims || dims.durationSec <= 0) {
    const error = "Не удалось определить длительность ролика — истории не опубликованы";
    void logSystemError("meta", `Истории Instagram (объект ${propertyId}): ${error}`);
    return { attempted: true, publishedParts: 0, totalParts: 0, error };
  }

  const segments = planStorySegments(dims.durationSec);
  // Продолжение: остались только недостающие части, лимит спрашиваем под них.
  const partsLeft = segments.filter((_, i) => !donePartIndexes.has(i)).length;
  if (partsLeft === 0) {
    return { attempted: true, publishedParts: donePartIndexes.size, totalParts: segments.length };
  }
  const limit = await checkInstagramPublishingLimit(identity.id, creds.igToken);
  if (limit.ok && limit.remaining < partsLeft) {
    const error = `Исчерпан дневной лимит публикаций Meta (осталось ${limit.remaining}, нужно ${partsLeft}) — попробуем позже`;
    void logSystemError("meta", `Истории Instagram (объект ${propertyId}): ${error}`);
    return { attempted: true, publishedParts: 0, totalParts: segments.length, error };
  }
  if (!limit.ok) {
    // Не смогли спросить лимит — не молчим и не долбим Graph API вслепую сериями:
    // честно останавливаемся, тот же принцип, что при исчерпанном лимите.
    void logSystemError("meta", `Истории Instagram (объект ${propertyId}): не удалось проверить лимит публикаций — ${limit.error}`);
    return { attempted: true, publishedParts: 0, totalParts: segments.length, error: limit.error };
  }

  const singlePart = segments.length === 1;
  // Уже опубликованные части текущей серии считаем своими: для вызывающего кода
  // «две из четырёх были, две доложили» — это четыре из четырёх, а не две.
  let publishedParts = donePartIndexes.size;

  for (let i = 0; i < segments.length; i++) {
    // Эта часть уже в Instagram — второй раз её не публикуем и даже не режем.
    if (donePartIndexes.has(i)) continue;
    const segment = segments[i];
    const partPath = singlePart
      ? videoDiskPath
      : path.join(videoHandoffDir, `${path.basename(localVideoPath, path.extname(localVideoPath))}-story-${i}.mp4`);
    const partPublicPath = singlePart ? localVideoPath : `/uploads/handoff/${path.basename(partPath)}`;
    try {
      if (!singlePart) {
        const cut = await cutVideoSegment(videoDiskPath, partPath, segment.startSec, segment.durationSec);
        if (!cut) {
          const error = `Не удалось нарезать часть ${i + 1}/${segments.length} ролика на историю`;
          void logSystemError("meta", `Истории Instagram (объект ${propertyId}): ${error}`);
          return { attempted: true, publishedParts, totalParts: segments.length, error };
        }
      }
      const videoUrl = publicUploadUrl(partPublicPath);
      if (!videoUrl) {
        const error = "Не настроен CRM_PUBLIC_URL — Meta неоткуда забрать историю";
        void logSystemError("meta", `Истории Instagram (объект ${propertyId}): ${error}`);
        return { attempted: true, publishedParts, totalParts: segments.length, error };
      }
      const result = await publishInstagramStory(propertyId, identity.id, creds.igToken, videoUrl, i);
      if (!result.ok) {
        // pending (случай №111) — контейнер жив у Meta и сохранён на дозавершение
        // (см. savePendingInstagramContainer в socialPublish.ts), это не отказ:
        // не логируем второй раз тем же «не удалась», просто останавливаем эту
        // серию частей здесь же, как и при честном отказе — следующая часть всё
        // равно не может уйти, не зная, опубликуется ли эта.
        if (!result.pending) {
          void logSystemError("meta", `Истории Instagram (объект ${propertyId}), часть ${i + 1}/${segments.length}: ${result.error}`);
        }
        return { attempted: true, publishedParts, totalParts: segments.length, error: result.error };
      }
      await prisma.propertyStoryPost.create({
        data: { propertyId, channel: "INSTAGRAM", mediaId: result.postId ?? "", partIndex: i },
      });
      publishedParts++;

      // Facebook — ЕЩЁ туда же, тем же файлом (28.09.2026). Отказ Facebook НЕ
      // трогает результат Instagram (не входит в publishedParts/error выше) —
      // ровно как задание требует. Своя запись PropertyStoryPost, свой канал.
      if (facebookReady) {
        try {
          const fbResult = await publishFacebookStoryVideo(creds.pageId!, creds.pageToken!, videoUrl);
          if (fbResult.ok) {
            await prisma.propertyStoryPost.create({
              data: { propertyId, channel: "FACEBOOK", mediaId: fbResult.postId ?? "", partIndex: i },
            });
          } else {
            void logSystemError(
              "meta",
              `Сторис Facebook (объект ${propertyId}), часть ${i + 1}/${segments.length} не удалась: ${fbResult.error}`
            );
          }
        } catch (err) {
          void logSystemError(
            "meta",
            `Сторис Facebook (объект ${propertyId}), часть ${i + 1}/${segments.length} не удалась: ${describeError(err)}`
          );
        }
      }
    } catch (err) {
      const error = describeError(err);
      void logSystemError("meta", `Истории Instagram (объект ${propertyId}), часть ${i + 1}/${segments.length}: ${error}`);
      return { attempted: true, publishedParts, totalParts: segments.length, error };
    } finally {
      if (!singlePart) {
        await fs.unlink(partPath).catch(() => {});
      }
    }
  }

  return { attempted: true, publishedParts, totalParts: segments.length };
}

/** Не публиковать вторую историю «цена снижена» по тому же объекту чаще, чем
 *  раз в сутки — владелец, 21.09.2026, просил именно это ограничение, а не
 *  «одна история на объект навсегда» (цена может снижаться много раз). */
const PRICE_DROP_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PRICE_DROP_STORY_KIND = "PRICE_DROP";

/** Печать «продано» на объекте — событие разовое, но объект могут снять с
 *  продажи и продать заново; сутки повтора берём те же, что у снижения цены. */
const SOLD_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SOLD_STORY_KIND = "SOLD";

/** Обычная карточка объекта в историях — вид журнала и ограничение повтора
 *  отдельно от «продано»: карточку выкладывают, пока объект продаётся, и
 *  делать это раз в сутки нормально. */
const CARD_STORY_KIND = "CARD";
const CARD_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * ИСТОРИЯ «ЦЕНА СНИЖЕНА» (21.09.2026, решение владельца — первая из
 * оставшихся идей по историям). Вызывается ТОЛЬКО из
 * lib/publishedListingSync.ts::syncPublishedPriceChange, и ТОЛЬКО когда цена
 * реально снизилась (сравнение — на стороне вызывающего кода, эта функция
 * такого не проверяет и не обязана: единственный вызывающий код уже решил
 * этот вопрос, вторую копию сравнения заводить незачем).
 *
 * Картинка, не ролик — используется инфраструктура историй-картинок из
 * `publishInstagramStoryImage` (socialPublish.ts) и рендер `generateStoryCard`
 * (lib/video/storyCard.ts), а не отдельный путь публикации.
 *
 * Объект без единой фотографии — не ошибка пользователя: `generateStoryCard`
 * сама пишет в logSystemError и возвращает честный отказ, эта функция просто
 * не публикует историю и не паникует (то же поведение, что и у видео-историй
 * при недоступном ffprobe).
 */
export async function publishPropertyPriceDropStory(propertyId: string, priceWasText: string): Promise<StoriesPublishSummary> {
  return publishCardStory({
    propertyId,
    kind: PRICE_DROP_STORY_KIND,
    label: "цена снижена",
    cooldownMs: PRICE_DROP_COOLDOWN_MS,
    cardOptions: { priceWasText },
  });
}

/**
 * ИСТОРИЯ «ПРОДАНО» (21.09.2026, владелец: «типа печать поставить типа продано,
 * как в других компаниях делают»). Та же карточка по главному фото объекта, но
 * с оттиском поверх — рисует `generateStoryCard`, см. SOLD_STAMP_TEXT.
 *
 * `force` ставится ручной кнопкой в карточке объекта: явное действие человека
 * не спрашивает ни рубильника историй, ни суточного ограничения — ровно как у
 * ручной публикации ролика в истории выше.
 *
 * Сам по себе переход объекта в статус «продан» историю НЕ публикует: наружу
 * уходит публикация, а не запись в базе, и решение об этом остаётся за
 * человеком. Автоматический вызов при смене статуса добавим, только если
 * владелец этого попросит.
 */
export async function publishPropertySoldStory(
  propertyId: string,
  options: { force?: boolean } = {}
): Promise<StoriesPublishSummary> {
  return publishCardStory({
    propertyId,
    kind: SOLD_STORY_KIND,
    label: "продано",
    cooldownMs: SOLD_COOLDOWN_MS,
    cardOptions: { soldStamp: true },
    force: options.force ?? false,
  });
}

/**
 * ИСТОРИЯ-КАРТОЧКА ОБЪЕКТА (21.09.2026, владелец: «как быть с объектами, как их
 * в историю добавлять»). Ролик монтажёра для этого не нужен — карточка рисуется
 * по главному фото, а фотографии у объекта есть всегда (MIN_PROPERTY_PHOTOS).
 * До этой кнопки карточка умела попадать в истории только сама, при снижении
 * цены, и объект без ролика в истории не выкладывался вовсе.
 */
export async function publishPropertyCardStory(
  propertyId: string,
  options: { force?: boolean } = {}
): Promise<StoriesPublishSummary> {
  return publishCardStory({
    propertyId,
    kind: CARD_STORY_KIND,
    label: "карточка объекта",
    cooldownMs: CARD_COOLDOWN_MS,
    cardOptions: {},
    force: options.force ?? false,
  });
}

/**
 * Общая механика историй-КАРТИНОК: рубильник, ограничение повторов, токен,
 * рендер карточки, выкладывание файла под публичный адрес, публикация и запись
 * в журнал. Виды историй («цена снижена», «продано») различаются только
 * `kind`, названием в журнале ошибок и настройками карточки — второй копии
 * этих шестидесяти строк на каждый новый вид быть не должно.
 *
 * Объект без единой фотографии — не ошибка пользователя: `generateStoryCard`
 * сама пишет в logSystemError и возвращает честный отказ, эта функция просто
 * не публикует историю и не паникует (то же поведение, что и у видео-историй
 * при недоступном ffprobe).
 */
async function publishCardStory(params: {
  propertyId: string;
  kind: string;
  label: string;
  cooldownMs: number;
  cardOptions: GenerateStoryCardOptions;
  force?: boolean;
}): Promise<StoriesPublishSummary> {
  const { propertyId, kind, label, cooldownMs, cardOptions, force = false } = params;
  const fail = (error: string): StoriesPublishSummary => {
    void logSystemError("meta", `История «${label}» (объект ${propertyId}): ${error}`);
    return { attempted: true, publishedParts: 0, totalParts: 1, error };
  };
  const empty: StoriesPublishSummary = { attempted: false, publishedParts: 0, totalParts: 1 };

  // Settings читаем всегда (не только при !force) — facebookStoriesEnabled
  // «под своим тумблером» проверяется НЕЗАВИСИМО от force, см. докстринг
  // модуля выше и publishPropertyInstagramStories.
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { instagramStoriesEnabled: true, facebookStoriesEnabled: true },
  });

  if (!force) {
    if (!settings?.instagramStoriesEnabled) return empty;

    // channel: "INSTAGRAM" (28.09.2026) — кулдаун СВОЕГО канала, не любого:
    // иначе история, уже вышедшая в Facebook, блокировала бы повтор в
    // Instagram (и наоборот), хотя по факту в ЭТОМ канале истории не было.
    const lastIg = await prisma.propertyStoryPost.findFirst({
      where: { propertyId, kind, channel: "INSTAGRAM" },
      orderBy: { publishedAt: "desc" },
    });
    if (lastIg && Date.now() - lastIg.publishedAt.getTime() < cooldownMs) return empty;
  }

  const creds = await loadCredentials();
  if (!creds.igToken) return fail(`Instagram не подключён — нечем публиковать историю «${label}»`);

  const identity = await instagramTokenIdentity(creds.igToken);
  if (!identity.ok) return fail(`не удалось определить аккаунт — ${identity.error}`);

  // Facebook — своя готовность (тумблер + токены) и свой кулдаун, считанный
  // ДО того, как Instagram ниже создаст свою строку PropertyStoryPost: иначе
  // проверка «был ли Facebook недавно» увидела бы только что вставленную
  // строку Instagram и решила бы, что Facebook уже публиковался.
  let facebookReady = !!settings?.facebookStoriesEnabled && !!creds.pageId && !!creds.pageToken;
  if (facebookReady && !force) {
    const lastFb = await prisma.propertyStoryPost.findFirst({
      where: { propertyId, kind, channel: "FACEBOOK" },
      orderBy: { publishedAt: "desc" },
    });
    if (lastFb && Date.now() - lastFb.publishedAt.getTime() < cooldownMs) facebookReady = false;
  }

  const card = await generateStoryCard(propertyId, cardOptions);
  if (!card.ok || !card.image) {
    // Причину рендера generateStoryCard уже записала сама — второй раз не пишем.
    return { attempted: true, publishedParts: 0, totalParts: 1, error: card.error ?? undefined };
  }

  const fileName = `${propertyId}-${kind.toLowerCase()}-${Date.now()}.jpg`;
  const diskPath = path.join(videoHandoffDir, fileName);
  const publicPath = `/uploads/handoff/${fileName}`;
  try {
    await fs.writeFile(diskPath, card.image);

    const imageUrl = publicUploadUrl(publicPath);
    if (!imageUrl) return fail("Не настроен CRM_PUBLIC_URL — Meta неоткуда забрать картинку истории");

    const result = await publishInstagramStoryImage(propertyId, identity.id, creds.igToken, imageUrl, kind);
    let outcome: StoriesPublishSummary;
    if (!result.ok) {
      outcome = result.pending
        ? { attempted: true, publishedParts: 0, totalParts: 1, error: result.error }
        : fail(result.error ?? "Instagram отказал без объяснения");
    } else {
      await prisma.propertyStoryPost.create({
        data: { propertyId, channel: "INSTAGRAM", mediaId: result.postId ?? "", partIndex: 0, kind },
      });
      outcome = { attempted: true, publishedParts: 1, totalParts: 1 };
    }

    // Facebook — ЕЩЁ туда же, тем же файлом (28.09.2026). Отказ здесь НЕ
    // меняет `outcome`, посчитанный выше по Instagram: задание требует, чтобы
    // отказ Facebook не влиял на результат Instagram.
    if (facebookReady) {
      try {
        const fbResult = await publishFacebookStoryImage(creds.pageId!, creds.pageToken!, imageUrl);
        if (fbResult.ok) {
          await prisma.propertyStoryPost.create({
            data: { propertyId, channel: "FACEBOOK", mediaId: fbResult.postId ?? "", partIndex: 0, kind },
          });
        } else {
          void logSystemError("meta", `Сторис Facebook «${label}» (объект ${propertyId}) не удалась: ${fbResult.error}`);
        }
      } catch (err) {
        void logSystemError("meta", `Сторис Facebook «${label}» (объект ${propertyId}) не удалась: ${describeError(err)}`);
      }
    }

    return outcome;
  } catch (err) {
    return fail(describeError(err));
  } finally {
    await fs.unlink(diskPath).catch(() => {});
  }
}
