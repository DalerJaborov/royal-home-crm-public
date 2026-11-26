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
import os from "node:os";
import path from "node:path";
import { prisma } from "../db.js";
import { loadCredentials } from "../messengers/meta.js";
import { personalInstagramPublisher, publishViaInstagramPublisher, resolveInstagramPublisher } from "./instagramPublisher.js";
import {
  publishInstagramStory,
  publishInstagramStoryImage,
  checkInstagramPublishingLimit,
  publishFacebookStoryImage,
  publishFacebookStoryVideo,
} from "./socialPublish.js";
import { publicUploadUrl } from "./crmPublicUrl.js";
import { probeVideoDimensions, cutVideoSegment, overlayCardOnVideo, STORY_OVERLAY_SEC } from "./ffmpeg.js";
import { videoHandoffDir } from "../upload.js";
import { logSystemError } from "./systemError.js";
import { generateStoryCard, generateStoryCardOverlay, pickStoryLanguage, type GenerateStoryCardOptions } from "./video/storyCard.js";
import { enqueueBackgroundJob } from "../jobs/enqueue.js";
import { describeError } from "./describeError.js";
import { clipHasPriceInFrame } from "./clipPriceInFrame.js";
import { narrationFactsCurrent } from "./propertyNarration.js";
import { automationSwitchOn } from "./automationSwitches.js";
import { isMetaAuthFailureText } from "./channelKeyAlarm.js";

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
  /** История создана у Meta и ждёт обработки (дозавершит фоновый проход контейнеров): повторять публикацию нельзя —
   *  выйдет вторая (ревью 25.11.2026). */
  pending?: boolean;
  /** Часть не вышла, потому что Meta не смогла скачать наш файл (18.11.2026, объект №208):
   *  повтор пройдёт сам — его ставит lib/videoHandoff.ts (jobs/socialPublishRetry.ts). */
  retriable?: boolean;
  /** Ключ Instagram мёртв (401/190) или аккаунт помечен «доступ потерян» (дверь #432): повторять нельзя — в Meta
   *  этим ключом не ходим, пока человек не заменит маркер. Отметку и тревогу ставит дверь, не вызывающий. */
  keyDead?: boolean;
  /** История вышла (или ждёт у Meta) готовым роликом, а не фото-карточкой. */
  video?: boolean;
}

/** Отказ из-за мёртвого ключа: по признаку двери или по тексту ответа Meta (401, 190/102 про маркер). */
export function isStoryKeyDead(summary: Pick<StoriesPublishSummary, "keyDead" | "error">): boolean {
  return summary.keyDead === true || (!!summary.error && isMetaAuthFailureText(summary.error));
}

/** force bypasses scheduling switches, never the property's privacy boundary. */
async function storyPublicationBlock(propertyId: string): Promise<string | null> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId }, select: { offSite: true, deletedAt: true },
  });
  if (!property || property.deletedAt) return "Объект не найден или удалён — истории не опубликованы";
  if (property.offSite) return "Объект только для своих клиентов — публикация в историях запрещена";
  return null;
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
  const blocked = await storyPublicationBlock(propertyId);
  if (blocked) return { ...empty, error: blocked };
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { instagramStoriesEnabled: true, facebookStoriesEnabled: true },
  });
  if (!options?.force && !settings?.instagramStoriesEnabled) return empty;

  // ОДНА ИСТОРИЯ ВМЕСТО ДВУХ (25.11.2026, №214: в 13:24 вышла «цена снижена», в 13:47 следом тот же ролик отдельной
  // историей). «Цена снижена» и «продано» теперь выходят САМИМ РОЛИКОМ с карточкой поверх (publishCardStory,
  // video) — если такая история по объекту вышла недавно, автоматическую историю того же ролика не повторяем.
  // Ручная кнопка (force) и дозавершение оборванной серии (resumeOnly) этого правила не знают.
  if (!options?.force && !options?.resumeOnly) {
    const recentEvent = await prisma.propertyStoryPost.findFirst({
      where: {
        propertyId,
        channel: "INSTAGRAM",
        kind: { in: [PRICE_DROP_STORY_KIND, SOLD_STORY_KIND] },
        publishedAt: { gte: new Date(Date.now() - EVENT_STORY_DEDUP_WINDOW_MS) },
      },
      select: { id: true },
    });
    // Задание «история по событию» ещё ждёт или идёт (ждёт озвучку/перевыпуск ролика) — автоисторию ролика не выкладываем:
    // иначе новый ролик выходит первым, а «цена снижена» следом (тот же сценарий №214).
    const pendingEventJob = await prisma.backgroundJob.findFirst({
      where: {
        type: PROPERTY_STATUS_STORY_JOB_TYPE,
        dedupeKey: { in: [`${PROPERTY_STATUS_STORY_JOB_TYPE}:${PRICE_DROP_STORY_KIND}:${propertyId}`, `${PROPERTY_STATUS_STORY_JOB_TYPE}:${SOLD_STORY_KIND}:${propertyId}`] },
        status: { in: ["PENDING", "RUNNING"] },
      },
      select: { id: true },
    });
    if (recentEvent || pendingEventJob) return empty;
  }

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

  // Чем и в какой аккаунт — одна дверь (22.11.2026, lib/instagramPublisher.ts).
  const resolved = await resolveInstagramPublisher(creds.igToken);
  if (!resolved.ok) {
    void logSystemError("meta", `Истории Instagram (объект ${propertyId}): не удалось определить аккаунт — ${resolved.error}`);
    return { attempted: true, publishedParts: 0, totalParts: 0, error: resolved.error };
  }
  // Серия частей идёт одним ключом; отказ ключа компании до контейнера переводит её на личный.
  let publisher = resolved;

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
  let limit = await checkInstagramPublishingLimit(publisher.igUserId, publisher.token);
  if (!limit.ok && publisher.route === "company") {
    // Ключу компании Meta не ответила даже на лимит (права, ключ) — это только чтение: один раз
    // спрашиваем личным ключом и, если он жив, публикуем серию им (ревью #391, пункт 1).
    const personal = await personalInstagramPublisher(publisher);
    if (personal.ok) {
      publisher = personal;
      limit = await checkInstagramPublishingLimit(publisher.igUserId, publisher.token);
    }
  }
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
      const attempt = await publishViaInstagramPublisher(publisher, (igUserId, token) =>
        publishInstagramStory(propertyId, igUserId, token, videoUrl, i)
      );
      const result = attempt.result;
      publisher = attempt.publisher;
      if (!result.ok) {
        // pending (случай №111) — контейнер жив у Meta и сохранён на дозавершение
        // (см. savePendingInstagramContainer в socialPublish.ts), это не отказ:
        // не логируем второй раз тем же «не удалась», просто останавливаем эту
        // серию частей здесь же, как и при честном отказе — следующая часть всё
        // равно не может уйти, не зная, опубликуется ли эта.
        if (!result.pending) {
          void logSystemError(
            "meta",
            `Истории Instagram (объект ${propertyId}), часть ${i + 1}/${segments.length}: ${result.retriable ? "Meta не смогла скачать ролик, повторим сами через несколько минут — " : ""}${result.error}`
          );
        }
        return {
          attempted: true,
          publishedParts,
          totalParts: segments.length,
          error: result.error,
          ...(result.retriable ? { retriable: true } : {}),
        };
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
/** Историю-ролик «цена снижена»/«продано» не дублируем автоматической историей того же ролика в течение этого окна. */
const EVENT_STORY_DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000;

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
export async function publishPropertyPriceDropStory(
  propertyId: string,
  priceWasText: string,
  priceWasTjs?: number | null,
  options: { video?: boolean } = {}
): Promise<StoriesPublishSummary> {
  return publishCardStory({
    propertyId,
    kind: PRICE_DROP_STORY_KIND,
    label: "цена снижена",
    cooldownMs: PRICE_DROP_COOLDOWN_MS,
    cardOptions: { priceWasText, priceWasTjs },
    video: options.video,
  });
}

/** Тип фонового задания «история по событию объекта»: цена снижена или продано, готовым роликом с карточкой. */
export const PROPERTY_STATUS_STORY_JOB_TYPE = "property-status-story";
/** Пауза перед историей «цена снижена»: за это время озвучка успевает наложить голос с новой ценой на ролик (на №214 — около минуты). */
export const PRICE_DROP_STORY_DELAY_MS = 6 * 60 * 1000;
/** Попыток задания: пока озвучка накладывается — ждём (по 3 минуты), на последней публикуем всё равно. */
export const PRICE_DROP_STORY_MAX_ATTEMPTS = 6;

/**
 * «ЦЕНА СНИЖЕНА» ИСТОРИЕЙ-РОЛИКОМ (25.11.2026, владелец: «подождать, когда ролик приготовится, и просто наложить
 * «цена снижена»»). Мгновенной картинки больше нет: ставим задание на несколько минут вперёд — оно дождётся, пока
 * озвучка пересоберёт ролик (jobs/propertyStatusStory.ts), и выложит сам ролик с карточкой первые секунды. Нет
 * ролика — задание выложит фото-карточку. Вызывается из `reportPublishedPriceChange`, как раньше прямой вызов.
 */
export async function queuePropertyPriceDropStory(propertyId: string, priceWasText: string, priceWasTjs?: number | null): Promise<void> {
  await enqueueBackgroundJob({
    type: PROPERTY_STATUS_STORY_JOB_TYPE,
    payload: { propertyId, kind: PRICE_DROP_STORY_KIND, priceWasText, priceWasTjs: priceWasTjs ?? null, queuedAt: Date.now() },
    maxAttempts: PRICE_DROP_STORY_MAX_ATTEMPTS,
    // Несколько снижений подряд схлопываются в одну историю (самая ранняя «была» цена остаётся — владелец видит полное падение).
    dedupeKey: `${PROPERTY_STATUS_STORY_JOB_TYPE}:${PRICE_DROP_STORY_KIND}:${propertyId}`,
    runAt: new Date(Date.now() + PRICE_DROP_STORY_DELAY_MS),
  });
}

const soldStoryDedupeKey = (propertyId: string) => `${PROPERTY_STATUS_STORY_JOB_TYPE}:${SOLD_STORY_KIND}:${propertyId}`;

/** Ручная печать «продано» историей-роликом: то же задание без паузы и без ожидания озвучки (`force` — кнопка человека). */
export async function queuePropertySoldStory(propertyId: string): Promise<boolean> {
  const payload = { propertyId, kind: SOLD_STORY_KIND, priceWasText: null, priceWasTjs: null, queuedAt: Date.now(), force: true };
  // Автоистория по этому объекту ещё ждёт своей паузы (тот же ключ очереди): кнопка человека превращает её в ручную —
  // сейчас и в обход рубильников. Иначе постановка ниже — no-op, и кнопка молча ждала бы автомат (до 10 минут).
  await prisma.backgroundJob.updateMany({
    where: { dedupeKey: soldStoryDedupeKey(propertyId), status: "PENDING" },
    data: { payload, runAt: new Date() },
  });
  const queued = await enqueueBackgroundJob({
    type: PROPERTY_STATUS_STORY_JOB_TYPE,
    payload,
    maxAttempts: 3,
    dedupeKey: soldStoryDedupeKey(propertyId),
  });
  return queued.enqueued;
}

/** Пауза автоистории «продано»: ошибочную отметку «продан» успевают вернуть, и печать на живом объекте не выходит. */
export const SOLD_AUTO_STORY_DELAY_MS = 10 * 60_000;
/** Статусы, из которых продажа — новость для подписчиков: объект был в продаже. Из «снят» и из конвейера — нет. */
const SOLD_AUTO_STORY_FROM: ReadonlySet<string> = new Set(["AVAILABLE", "RESERVED"]);

/** Продажа старше этого — уже не новость: ночная сверка может закрыть объект по сделке недельной давности. */
export const SOLD_AUTO_STORY_FRESH_MS = 48 * 60 * 60_000;

export type AutoSoldStoryOutcome = "queued" | "switch-off" | "stories-off" | "not-on-sale" | "stale" | "private" | "already" | "error";

/**
 * ИСТОРИЯ «ПРОДАНО» САМА ПРИ ПРОДАЖЕ (26.11.2026, владелец: «да» на автоисторию). Зовётся ТОЛЬКО из
 * lib/propertyLeftSale.ts::closeWorkAfterLeavingSale(…, "sold", from) — туда сходятся все пути продажи (карточка,
 * помощник и заявки через changePropertyStatus, закрытие сделки, ночная сверка). `from` — статус ДО продажи.
 *
 * Ставит то же задание, что кнопка «Продано» (jobs/propertyStatusStory.ts), но не ручное: `force` нет — значит, его
 * гейтят рубильник автоисторий Instagram (instagramStoriesEnabled) и суточный ограничитель, а задание перед
 * публикацией ещё раз читает статус и выключатель. Один раз на объект: история «продано» уже выходила (любой
 * кнопкой) — не ставим, и задание проверяет это ещё раз. Пауза SOLD_AUTO_STORY_DELAY_MS.
 */
export async function queueAutoPropertySoldStory(
  propertyId: string,
  from: string | null,
  /** Когда продали на деле (закрытие сделки); null — неизвестно, истории нет. По умолчанию — сейчас (продажа идёт сейчас). */
  saleAt: Date | null = new Date()
): Promise<AutoSoldStoryOutcome> {
  if (!(await automationSwitchOn("storySoldAutoEnabled"))) return "switch-off";
  if (!from || !SOLD_AUTO_STORY_FROM.has(from)) return "not-on-sale";
  if (!saleAt || Date.now() - saleAt.getTime() > SOLD_AUTO_STORY_FRESH_MS) return "stale";
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { instagramStoriesEnabled: true } });
  if (!settings?.instagramStoriesEnabled) return "stories-off";
  if (await storyPublicationBlock(propertyId)) return "private";
  if (await soldStoryEverPublished(propertyId)) return "already";
  const queued = await enqueueBackgroundJob({
    type: PROPERTY_STATUS_STORY_JOB_TYPE,
    payload: { propertyId, kind: SOLD_STORY_KIND, priceWasText: null, priceWasTjs: null, queuedAt: Date.now(), auto: true },
    maxAttempts: 3,
    dedupeKey: soldStoryDedupeKey(propertyId),
    runAt: new Date(Date.now() + SOLD_AUTO_STORY_DELAY_MS),
  });
  return queued.enqueued ? "queued" : "error";
}

/** История «продано» по объекту уже выходила в Instagram (кнопкой или автоматом). */
export async function soldStoryEverPublished(propertyId: string): Promise<boolean> {
  const row = await prisma.propertyStoryPost.findFirst({
    where: { propertyId, kind: SOLD_STORY_KIND, channel: "INSTAGRAM" },
    select: { id: true },
  });
  return !!row;
}

/**
 * История этого вида по объекту уже создана у Meta и ждёт обработки. Контейнер намеренно остаётся ждать и при
 * сбое `media_publish` (lib/socialPublish.ts), и его дозавершит фоновый проход раз в несколько минут — повторная
 * публикация или фото-запасной путь выложили бы ВТОРУЮ историю (ревью 25.11.2026).
 */
async function hasPendingStoryContainer(propertyId: string, kind: string): Promise<boolean> {
  const row = await prisma.pendingInstagramContainer.findFirst({
    where: { propertyId, kind: "STORY", storyKind: kind, status: "PENDING", createdAt: { gte: new Date(Date.now() - 3 * 60 * 60 * 1000) } },
    select: { id: true },
  });
  return !!row;
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
  options: { force?: boolean; video?: boolean } = {}
): Promise<StoriesPublishSummary> {
  return publishCardStory({
    propertyId,
    kind: SOLD_STORY_KIND,
    label: "продано",
    cooldownMs: SOLD_COOLDOWN_MS,
    // Без цены (решение владельца 25.11.2026: цены нет в будущих роликах и историях) — и на ролике, и на фото.
    cardOptions: { soldStamp: true, hidePrice: true },
    force: options.force ?? false,
    video: options.video,
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
  /** `video` — готовым роликом с карточкой БЕЗ цены (ежедневная подборка, 26.11.2026); иначе фото-карточка. */
  options: { force?: boolean; video?: boolean } = {}
): Promise<StoriesPublishSummary> {
  return publishCardStory({
    propertyId,
    kind: CARD_STORY_KIND,
    label: "карточка объекта",
    cooldownMs: CARD_COOLDOWN_MS,
    // Без цены и роликом, и запасной фото-карточкой (решение владельца 25.11.2026).
    cardOptions: { hidePrice: true },
    force: options.force ?? false,
    video: options.video,
  });
}

/**
 * Годится ли готовый ролик объекта для истории-РОЛИКА карточки без цены — по полям, без ffmpeg и сети: ежедневная
 * подборка (lib/dailyStories.ts) отбирает по нему, кому вообще пробовать ролик (предел роликов за прогон не тратится
 * на объекты без ролика). Окончательно решает publishCardVideoStory (формат кадра, длина, голос).
 */
export function cardVideoClipUsable(p: {
  videoHandoffFinalPath: string | null;
  videoHandoffStatus: string;
  clipReviewStatus: string;
  videoHandoffLastFactsText: string | null;
}): boolean {
  if (!p.videoHandoffFinalPath || !p.videoHandoffFinalPath.startsWith("/uploads/")) return false;
  if (p.videoHandoffStatus !== "RECEIVED" || p.clipReviewStatus === "PENDING") return false;
  // Решение владельца 25.11.2026: в ролике цену не показываем — старый ролик с ценой в кадре в подборку не идёт.
  return !clipHasPriceInFrame(p);
}

type StoryPublisher = Extract<Awaited<ReturnType<typeof resolveInstagramPublisher>>, { ok: true }>;

/**
 * ГОЛОС В РОЛИКЕ НАЗЫВАЕТ ТЕКУЩУЮ ЦЕНУ? (26.11.2026, ревью #445, класс №214). История «цена снижена» роликом
 * допустима, только если озвучка, которая РЕАЛЬНО звучит в готовом ролике, собрана по нынешним фактам (цена
 * входит в факты озвучки с 11.11.2026). Иначе под плашкой «Цена снижена 870 000» голос скажет «890 000».
 *
 * Какая версия звучит: наложенная CRM (`videoMasterNarrationVersionId`), а если голос вклеивал монтажёр —
 * последняя доставленная ему (`PropertyNarrationDelivery` SENT). Ролик уже вышел — новая озвучка без человека
 * не утверждается (lib/narrationAutoFlow.ts, «одно утверждение»), поэтому одной «последней одобренной» мало.
 *
 * - `WAIT_NEWER` — есть более новая версия, ещё не легшая в ролик (готовится, ждёт утверждения или наложения),
 *   или звучащую версию не установить, а версии у объекта есть: задание ждёт (jobs/propertyStatusStory.ts),
 *   а при публикации сейчас — фото-карточка;
 * - `STALE` — звучащая версия собрана по старым фактам: фото-карточка;
 * - `OK` — голос с нынешней ценой, либо озвучки у объекта нет вовсе (или выбрано «Без озвучки»).
 */
export type PriceDropVoiceCheck = "OK" | "STALE" | "WAIT_NEWER";
export async function priceDropVoiceCheck(propertyId: string): Promise<PriceDropVoiceCheck> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      type: true, rooms: true, areaSqm: true, floor: true, totalFloors: true, price: true, currency: true, landAreaSotka: true,
      district: { select: { name: true } }, narrationOff: true, videoMasterNarrationVersionId: true,
    },
  });
  if (!property) return "STALE";
  if (property.narrationOff) return "OK";
  const versionSelect = { id: true, revision: true, factsHash: true, factsSnapshot: true } as const;
  let voice = property.videoMasterNarrationVersionId
    ? await prisma.propertyNarrationVersion.findUnique({ where: { id: property.videoMasterNarrationVersionId }, select: versionSelect })
    : null;
  if (!voice) {
    const delivered = await prisma.propertyNarrationDelivery.findFirst({
      where: { propertyId, status: "SENT" },
      orderBy: { createdAt: "desc" },
      select: { version: { select: versionSelect } },
    });
    voice = delivered?.version ?? null;
  }
  const newer = await prisma.propertyNarrationVersion.findFirst({
    where: { propertyId, status: { not: "FAILED" }, ...(voice ? { revision: { gt: voice.revision } } : {}) },
    select: { id: true },
  });
  // Есть версия новее звучащей (или звучащую не установить, а версии есть) — она ещё может лечь в ролик: ждём.
  if (newer) return "WAIT_NEWER";
  if (!voice) return "OK"; // озвучек у объекта нет — голоса с ценой в ролике нет
  return narrationFactsCurrent(voice, property) ? "OK" : "STALE";
}

/** Вертикальный кадр 9:16 с допуском: карточка рисуется под него, на горизонтальный ролик её не наложить. */
export function isStoryAspect(width: number, height: number): boolean {
  return height > 0 && Math.abs(width / height - 9 / 16) < 0.03;
}

/**
 * ИСТОРИЯ-РОЛИК С КАРТОЧКОЙ (25.11.2026): готовый ролик объекта (звук сохраняется), первые секунды поверх него —
 * карточка «цена снижена» / печать «продано» (тот же слой, что на фото-истории, прозрачный). Возвращает итог
 * публикации или `null` — «ролика нет / не подошёл / Instagram отказал, ничего не опубликовав»: вызывающий
 * публикует обычную фото-карточку. ffmpeg занимает десятки секунд — звать только из фонового задания.
 *
 * Берётся только сданный ролик (`RECEIVED`): пока ролик у монтажёра или на проверке модератора, лежащий файл —
 * прежний, и выкладывать его в историю нельзя (правило `publishPropertyInstagramStories`).
 */
async function publishCardVideoStory(p: {
  propertyId: string;
  kind: string;
  label: string;
  cardOptions: GenerateStoryCardOptions;
  publisher: StoryPublisher;
  facebookReady: boolean;
  creds: Awaited<ReturnType<typeof loadCredentials>>;
}): Promise<StoriesPublishSummary | null> {
  const { propertyId, kind, label, cardOptions, publisher, facebookReady, creds } = p;
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { videoHandoffFinalPath: true, videoHandoffStatus: true, clipReviewStatus: true, videoHandoffLastFactsText: true },
  });
  const clipPath = property?.videoHandoffFinalPath;
  if (!property || !clipPath || !clipPath.startsWith("/uploads/")) return null;
  if (property.videoHandoffStatus !== "RECEIVED" || property.clipReviewStatus === "PENDING") return null;
  // Старый ролик с ценой, набранной в кадр (до 25.11.2026): карточка её не прячет. «Цена снижена» показала бы прежнюю
  // сумму, а в «продано» и подборке цены нет вовсе (решение владельца 25.11.2026) — любой вид берёт фото-карточку.
  if (clipHasPriceInFrame(property)) return null;
  if (kind === PRICE_DROP_STORY_KIND || kind === CARD_STORY_KIND) {
    // Голос в ролике должен называть ТЕКУЩУЮ цену (класс №214): иначе — фото-карточка.
    if ((await priceDropVoiceCheck(propertyId)) !== "OK") return null;
  }

  const clipDisk = path.join(videoHandoffDir, path.basename(clipPath));
  const dims = await probeVideoDimensions(clipDisk);
  if (!dims || dims.durationSec <= 0 || !isStoryAspect(dims.width, dims.height)) return null;
  // Дольше минуты Instagram не берёт целиком, а резать ролик молча (потерять концовку с контактами) нельзя — фото-карточка.
  if (dims.durationSec > MAX_STORY_PART_SEC + 0.5) return null;

  const overlay = await generateStoryCardOverlay(propertyId, cardOptions, { width: dims.width, height: dims.height });
  if (!overlay.ok || !overlay.image) return null;

  const stamp = Date.now();
  const pngPath = path.join(os.tmpdir(), `${propertyId}-${kind.toLowerCase()}-overlay-${stamp}.png`);
  const fileName = `${propertyId}-${kind.toLowerCase()}-story-${stamp}.mp4`;
  const outPath = path.join(videoHandoffDir, fileName);
  let published = false;
  // Контейнер истории ждёт обработки у Meta и ещё будет читать файл по адресу — не удалять, уберёт уборка по возрасту.
  let keepFile = false;
  try {
    await fs.writeFile(pngPath, overlay.image);
    const rendered = await overlayCardOnVideo(clipDisk, pngPath, outPath, { showSec: STORY_OVERLAY_SEC, maxDurationSec: MAX_STORY_PART_SEC });
    if (!rendered.ok) {
      void logSystemError("meta", `История «${label}» (объект ${propertyId}): не удалось наложить карточку на ролик (${rendered.reason}) — выкладываем фото-карточкой`);
      return null;
    }
    const videoUrl = publicUploadUrl(`/uploads/handoff/${fileName}`);
    if (!videoUrl) return null; // дальше фото-путь сам назовёт причину («Не настроен CRM_PUBLIC_URL»)

    const { result } = await publishViaInstagramPublisher(publisher, (igUserId, token) =>
      publishInstagramStory(propertyId, igUserId, token, videoUrl, 0, kind)
    );
    if (!result.ok) {
      // pending — контейнер жив у Meta и сохранён на дозавершение: второй раз (фото) не публикуем. Отказ `media_publish`
      // тоже оставляет контейнер ждать (признака pending в ответе нет) — смотрим на сам контейнер.
      if (result.pending || (await hasPendingStoryContainer(propertyId, kind))) {
        keepFile = true;
        return { attempted: true, publishedParts: 0, totalParts: 1, pending: true, error: result.error, video: true };
      }
      // Мёртвый ключ (дверь #432 его уже отметила): фото-карточкой тем же ключом не пробуем — второй отказ, второй запрос.
      if (result.error && isMetaAuthFailureText(result.error)) {
        return { attempted: true, publishedParts: 0, totalParts: 1, error: result.error, keyDead: true };
      }
      void logSystemError("meta", `История-ролик «${label}» (объект ${propertyId}) не вышла: ${result.error ?? "Instagram отказал без объяснения"} — пробуем фото-карточкой`);
      return null;
    }
    published = true;
    await prisma.propertyStoryPost.create({
      data: { propertyId, channel: "INSTAGRAM", mediaId: result.postId ?? "", partIndex: 0, kind },
    });

    // Facebook — тем же файлом; отказ Facebook итог Instagram не меняет (как у остальных историй).
    if (facebookReady) {
      try {
        const fb = await publishFacebookStoryVideo(creds.pageId!, creds.pageToken!, videoUrl);
        if (fb.ok) {
          await prisma.propertyStoryPost.create({
            data: { propertyId, channel: "FACEBOOK", mediaId: fb.postId ?? "", partIndex: 0, kind },
          });
        } else {
          void logSystemError("meta", `Сторис Facebook «${label}» (объект ${propertyId}) не удалась: ${fb.error}`);
        }
      } catch (err) {
        void logSystemError("meta", `Сторис Facebook «${label}» (объект ${propertyId}) не удалась: ${describeError(err)}`);
      }
    }
    return { attempted: true, publishedParts: 1, totalParts: 1, video: true };
  } catch (err) {
    const error = describeError(err);
    void logSystemError("meta", `История-ролик «${label}» (объект ${propertyId}): ${error}`);
    // Уже опубликовано в Instagram — фото вторым постом не добавляем.
    return published ? { attempted: true, publishedParts: 1, totalParts: 1, error, video: true } : null;
  } finally {
    await fs.unlink(pngPath).catch(() => {});
    if (!keepFile) await fs.unlink(outPath).catch(() => {});
  }
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
  /** Выложить готовым роликом объекта с карточкой поверх (ffmpeg, десятки секунд) — только из фонового задания. */
  video?: boolean;
}): Promise<StoriesPublishSummary> {
  const { propertyId, kind, label, force = false } = params;
  // Язык надписей по очереди (25.11.2026): русский и таджикский через одну историю; явно заданный не трогаем.
  const language = params.cardOptions.lang ?? pickStoryLanguage(await prisma.propertyStoryPost.count({
    where: { channel: "INSTAGRAM", kind: { in: [PRICE_DROP_STORY_KIND, SOLD_STORY_KIND, CARD_STORY_KIND] } },
  }));
  const cardOptions: GenerateStoryCardOptions = { ...params.cardOptions, lang: language };
  const { cooldownMs } = params;
  const fail = (error: string): StoriesPublishSummary => {
    void logSystemError("meta", `История «${label}» (объект ${propertyId}): ${error}`);
    return { attempted: true, publishedParts: 0, totalParts: 1, error };
  };
  const empty: StoriesPublishSummary = { attempted: false, publishedParts: 0, totalParts: 1 };
  const blocked = await storyPublicationBlock(propertyId);
  if (blocked) return { ...empty, error: blocked };
  // Такая история уже ждёт обработки у Meta — второй раз не выкладываем, даже ручной кнопкой.
  if (await hasPendingStoryContainer(propertyId, kind)) return { attempted: true, publishedParts: 0, totalParts: 1, pending: true };

  // Settings читаем всегда (не только при !force) — facebookStoriesEnabled
  // «под своим тумблером» проверяется НЕЗАВИСИМО от force, см. докстринг
  // модуля выше и publishPropertyInstagramStories.
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { instagramStoriesEnabled: true, facebookStoriesEnabled: true, instagramStoryVideoEnabled: true },
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

  // Аккаунт помечен «доступ потерян» (дверь #432) и пути через ключ компании нет — в Meta не идём вовсе (не бомбим).
  const publisher = await resolveInstagramPublisher(creds.igToken, { respectAccessLost: true });
  if (!publisher.ok) {
    if (publisher.accessLost) {
      void logSystemError("meta", `История «${label}» не опубликована: ${publisher.error}`, { dedupKey: "story-instagram-access-lost" });
      return { attempted: true, publishedParts: 0, totalParts: 1, error: publisher.error, keyDead: true };
    }
    const failed = fail(`не удалось определить аккаунт — ${publisher.error}`);
    return isMetaAuthFailureText(publisher.error) ? { ...failed, keyDead: true } : failed;
  }

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

  // Рубильник «История готовым роликом» (26.11.2026, по умолчанию включён): выключен — прежняя фото-карточка.
  if (params.video && settings?.instagramStoryVideoEnabled !== false) {
    const videoOutcome = await publishCardVideoStory({ propertyId, kind, label, cardOptions, publisher, facebookReady, creds });
    if (videoOutcome) return videoOutcome;
    // null — ролика нет или он не подошёл, либо Instagram отказал, ничего не опубликовав: идём к фото-карточке.
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

    const { result } = await publishViaInstagramPublisher(publisher, (igUserId, token) =>
      publishInstagramStoryImage(propertyId, igUserId, token, imageUrl, kind)
    );
    let outcome: StoriesPublishSummary;
    if (!result.ok) {
      outcome = result.pending || (await hasPendingStoryContainer(propertyId, kind))
        ? { attempted: true, publishedParts: 0, totalParts: 1, pending: true, error: result.error }
        : fail(result.error ?? "Instagram отказал без объяснения");
      if (!outcome.pending && result.error && isMetaAuthFailureText(result.error)) outcome = { ...outcome, keyDead: true };
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
