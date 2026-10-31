/**
 * ИСПРАВИТЬ УЖЕ ВЫПУЩЕННЫЙ РОЛИК (19.09.2026, владелец: «что нам делать, если
 * ошибся монтажёр или агент неправильно заполнил карточку, чтобы не проходить
 * весь путь заново и не заполнять карточку второй раз»).
 *
 * Поводом был разбор перемешанных описаний двух квартир одного продавца
 * (docs/video-text-mixup-19-09.md): к моменту, когда ошибку заметили, ролики
 * уже висели во всех соцсетях, а единственным способом что-то поправить было
 * «позовите администратора».
 *
 * ЧЕТЫРЕ ДЕЙСТВИЯ, И НИ ОДНО ИЗ НИХ НЕ ТРОГАЕТ ПОЛЯ КАРТОЧКИ:
 *
 * 1. `sendBackToMontajer` — вернуть объект монтажёру с теми же данными.
 * 2. приём нового готового ролика — `openForManualFinalVideo` + обычный
 *    `receiveEditedVideo` (routes/properties/videos.ts).
 * 3. `removeFromSocial` — снять посты там, где площадка это позволяет.
 * 4. `refreshPublishedCaptions` — пересобрать подпись из карточки и разослать
 *    её в те посты, которые поддаются правке.
 *
 * ГЛАВНОЕ ПРАВИЛО ФАЙЛА: НЕ ВРАТЬ ПРО ТО, ЧЕГО МЫ НЕ СДЕЛАЛИ. Instagram и
 * TikTok не дают ни удалить, ни переписать вышедший пост (подробности —
 * socialPublish.ts::deleteFacebookVideo и publishedListingSync.ts). Поэтому
 * каждая функция здесь возвращает не только «что получилось», но и `manual` —
 * список того, что человеку придётся убрать или поправить руками, со ссылкой.
 * Отрапортовать «удалено отовсюду», оставив ролик в Instagram, хуже, чем
 * честно сказать про две сети: неверный ролик тогда просто останется висеть,
 * а в CRM будет написано, что его нет.
 */
import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { updatePublishedMarks } from "./publishedMarks.js";
import { isYoutubeScopeError, reportYoutubeScopeMissing, YOUTUBE_SCOPE_MISSING_SHORT } from "./youtubeScope.js";
import { decryptSecretSafe } from "../crypto.js";
import { loadCredentials } from "../messengers/meta.js";
import { deleteChannelMessage, editMessageCaption } from "../telegram/api.js";
import {
  deleteFacebookVideo,
  deleteInstagramMedia,
  deleteYouTubeVideo,
  deleteThreadsPost,
  findInstagramMediaIdByPermalink,
  resolveInstagramBusinessAccountId,
  updateFacebookVideoDescription,
  updateYouTubeDescription,
  type InstagramPermalinkSearchResult,
  type YouTubeCredentials,
} from "./socialPublish.js";
import {
  reelsCaptionValuesFromProperty,
  generateReelsCaptionFromTemplates,
  rewriteCaptionFacts,
  withPostFooter,
  applyContactFooter,
  type ReelsCaptionValues,
} from "./reelsCaptionTemplate.js";
import type { MoneyContext } from "./money.js";
import { loadMoneyContext } from "./money.js";
import { hasVideoHistory } from "@royal-home/shared";
import {
  queueVideoHandoffInTx,
  buildMontajerMessageText,
  withPropertyLock,
  dispatchToEditor,
  videoHandoffPublishDedupeKey,
  isHandoffPublishRunning,
  HANDOFF_PUBLISH_RUNNING_ERROR,
} from "./videoHandoff.js";
import { tiktokPublishRetryDedupeKey } from "../jobs/tiktokPublishRetryPolicy.js";
import { logTimeline } from "./timeline.js";
import { localVideoDelete } from "./localVideoStorage.js";
import { propertyOwnerAgentId } from "./propertyOwner.js";
import { sendPushToAgent } from "../push.js";
import { VIDEO_REMAKE_REASON_LABELS, type VideoRemakeReason } from "@royal-home/shared";

/** Каналы, где ПОДПИСЬ поддаётся правке из кода (refreshPublishedCaptions ниже) —
 *  используется только для CHANNELS_EDITABLE_FROM_CRM (подсказка в карточке).
 *  С 20.09.2026 это НЕ то же самое, что «id храним в publishedPostIds»: Instagram
 *  туда тоже пишется (removeFromSocial умеет снимать Reels), но правка caption
 *  Graph API по-прежнему не поддерживает — поэтому в этом списке его нет. */
const EDITABLE_CHANNELS = ["FACEBOOK", "TELEGRAM", "YOUTUBE"] as const;

/** Что человеку придётся сделать руками, и куда для этого идти. */
export interface ManualStep {
  channel: "INSTAGRAM" | "TIKTOK" | "THREADS";
  /** Прямая ссылка на пост, если она у нас есть. У TikTok её нет никогда:
   *  Content Posting API не возвращает пригодного адреса, и в карточке он не
   *  хранится (см. schema.prisma, publishedPostIds). У Threads ссылка ЕСТЬ
   *  (publishedPostIds.THREADS_URL) — здесь она появляется только для
   *  ПРАВКИ ТЕКСТА (Threads не поддерживает её вовсе), не для снятия: снятие
   *  Threads делает removeFromSocial через API (см. deleteThreadsPost). */
  url: string | null;
  reason: string;
}

export interface SocialRemovalResult {
  removed: string[];
  failed: { channel: string; error: string }[];
  manual: ManualStep[];
  /** Канал вычеркнут, но не потому что мы его сняли — Meta сказала, что объекта
   *  там уже нет (случай №112, см. socialPublish.ts::isGhostObjectError). Тот же
   *  список removed для дальнейшей публикации, отдельная честная строка для
   *  человека: «удалено» и «уже не было» — разные вещи. */
  notes: { channel: string; note: string }[];
  /** Снятие НЕ начиналось, и почему (25.09.2026, Б3): прямо сейчас идёт
   *  публикация ролика (она записала бы канал поверх «снятого», и старый ролик
   *  вышел бы после «удалили») или объект в корзине. Роут отвечает 409. */
  blocked?: string;
}

export async function youtubeCredentials(): Promise<YouTubeCredentials> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { youtubeClientId: true, youtubeClientSecret: true, youtubeRefreshToken: true },
  });
  return {
    clientId: settings?.youtubeClientId ?? undefined,
    clientSecret: decryptSecretSafe(settings?.youtubeClientSecret ?? null) ?? undefined,
    refreshToken: decryptSecretSafe(settings?.youtubeRefreshToken ?? null) ?? undefined,
  };
}

/** Что останется делать руками при данном наборе опубликованных каналов.
 *
 * `instagramReason` — 20.09.2026: РАЗНЫЕ причины для РАЗНЫХ случаев, раньше
 * был один и тот же текст на все. Токен `metaIgManageToken` не задан — старый
 * текст «не даёт удалять» верен буквально: мы даже не пробовали, программного
 * пути нет вовсе. Токен задан, а канал всё равно остался ручным — это уже НЕ
 * «Instagram не даёт», это «мы не нашли/не смогли проверить этот конкретный
 * пост» (не дочитали ленту, нет ссылки в карточке, сам запрос на удаление
 * отказал) — врать про ограничение площадки в этом случае значит повторить
 * ту же ошибку, ради починки которой написан весь файл. Без переданной
 * причины используется старый текст — так и должно быть, когда токена нет. */
function manualSteps(
  channels: string[],
  instagramUrl: string | null,
  instagramReason?: string,
  /** Прямая ссылка на ролик TikTok, если её удалось собрать — см. tiktokPostUrl. */
  tiktokUrl?: string | null,
  /** Прямая ссылка на пост Threads — уже готовая (publishedPostIds.THREADS_URL,
   *  сохраняется при публикации, см. lib/videoHandoff.ts), в отличие от TikTok
   *  собирать её не нужно. */
  threadsUrl?: string | null
): ManualStep[] {
  const steps: ManualStep[] = [];
  if (channels.includes("INSTAGRAM")) {
    steps.push({
      channel: "INSTAGRAM",
      url: instagramUrl,
      reason:
        instagramReason ??
        "Instagram не даёт удалять и переписывать вышедшие Reels через программу — только в приложении.",
    });
  }
  if (channels.includes("TIKTOK")) {
    steps.push({
      channel: "TIKTOK",
      // Ссылка ЕСТЬ, даже когда удалить нельзя (22.09.2026, docs/TASKS.md,
      // раздел от 20.09). Удаления у TikTok не даёт никто, но найти нужный
      // ролик среди чужих руками — отдельная работа, и раньше человек делал её
      // каждый раз заново: в списке стоял `url: null`, хотя id ролика мы
      // получаем при публикации и храним в publishedPostIds.TIKTOK.
      url: tiktokUrl ?? null,
      reason: "TikTok не даёт удалять и переписывать вышедшие видео через программу — только в приложении.",
    });
  }
  if (channels.includes("THREADS")) {
    // Снятие Threads поддерживает API (см. removeFromSocial ниже) — сюда канал
    // попадает ТОЛЬКО ради правки текста, которую Threads не даёт вовсе.
    // Если снятие уже случилось раньше в этом же заходе, вызывающая сторона
    // передаёт отфильтрованный список каналов, и эта ветка не сработает.
    steps.push({
      channel: "THREADS",
      url: threadsUrl ?? null,
      reason: "Threads не поддерживает редактирование текста опубликованного поста — только в приложении.",
    });
  }
  return steps;
}

/**
 * Прямая ссылка на вышедший ролик TikTok — `https://www.tiktok.com/@{имя}/video/{id}`.
 *
 * Обе половины у нас уже есть и просто не встречались: id ролика приходит в
 * ответе о статусе публикации (`publicaly_available_post_id`) и ложится в
 * `publishedPostIds.TIKTOK`, имя автора сохраняется при подключении кабинета
 * (`Settings.tiktokCreatorUsername`). Нет любой из половин — честный `null`,
 * а не собранная наугад ссылка: та вела бы в никуда.
 */
async function tiktokPostUrl(postId: string | undefined): Promise<string | null> {
  if (!postId) return null;
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { tiktokCreatorUsername: true },
  });
  const username = settings?.tiktokCreatorUsername?.trim();
  if (!username) return null;
  return `https://www.tiktok.com/@${username.replace(/^@/, "")}/video/${postId}`;
}

/** Маркер удаления Instagram (Facebook Login, graph.facebook.com) — НЕ metaIgToken
 *  (переписка, graph.instagram.com через прокси). См. Settings.metaIgManageToken
 *  в schema.prisma и докстринг deleteInstagramMedia в socialPublish.ts. */
export async function instagramManageToken(): Promise<string | null> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaIgManageToken: true },
  });
  return decryptSecretSafe(settings?.metaIgManageToken ?? null);
}

/**
 * Telegram отвечает на удаление уже удалённого сообщения «Bad Request: message to
 * delete not found». Отличаем именно этот текст: «message can't be deleted» (нет
 * прав, сообщение слишком старое для группы) — настоящий отказ, и вычёркивать
 * канал по нему нельзя, пост на месте.
 */
export function isTelegramMessageGone(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err ?? "");
  return /message to delete not found/i.test(text);
}

/**
 * СНЯТЬ ПОСТЫ ОБЪЕКТА ИЗ СОЦСЕТЕЙ.
 *
 * Снятые каналы вычёркиваются из `publishedChannels` и `publishedPostIds` — и
 * это не бухгалтерия, а условие того, что следующий ролик туда вообще уедет:
 * публикация пропускает каналы, уже перечисленные в `publishedChannels`
 * (videoHandoff.ts::publishHandoffResult, `skipChannels: alreadyPublished`).
 * Канал, который снять не удалось, из списка НЕ вычёркивается: иначе второй
 * ролик встал бы рядом с первым вместо того, чтобы его заменить.
 */
export async function removeFromSocial(
  propertyId: string,
  only?: string[],
  opts: { insidePublishJob?: boolean } = {}
): Promise<SocialRemovalResult> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { id: true, deletedAt: true, publishedChannels: true, publishedPostIds: true, instagramUrl: true },
  });
  if (!property) return { removed: [], failed: [{ channel: "—", error: "Объект не найден" }], manual: [], notes: [] };
  // ЗАМОК ПРОТИВ ИДУЩЕЙ ПУБЛИКАЦИИ (25.09.2026, Б3). Задание публикации пишет
  // вышедший канал в конце своего шага: снятие посреди него вычеркнуло бы
  // канал, а задание вписало бы его обратно — и старый ролик вышел бы уже
  // после «удалили». Удалённый объект — не наш: его посты разбирают из корзины.
  // Само задание публикации (insidePublishJob) снимает старые посты ДО своего
  // шага публикации — это не гонка с ним, а его же первый шаг.
  if (property.deletedAt) return { removed: [], failed: [], manual: [], notes: [], blocked: "Объект удалён — снимать его посты отсюда нельзя." };
  if (!opts.insidePublishJob && (await isHandoffPublishRunning(propertyId))) {
    return { removed: [], failed: [], manual: [], notes: [], blocked: HANDOFF_PUBLISH_RUNNING_ERROR };
  }

  // `only` — снять только выбранные сети (05.10.2026, владелец: «чтобы можно было
  // галочками выбрать, из какой именно»). Без него — все, как раньше. Невыбранные
  // остаются в карточке нетронутыми: запись ниже вычёркивает только снятые.
  const publishedAll = property.publishedChannels ?? [];
  const channels = only ? publishedAll.filter((c) => only.includes(c)) : publishedAll;
  const postIds = (property.publishedPostIds ?? {}) as Record<string, string>;
  const removed: string[] = [];
  const failed: { channel: string; error: string }[] = [];
  const notes: { channel: string; note: string }[] = [];
  let instagramCleared = false;
  // Непустая, только когда токен Instagram задан, но канал всё равно остаётся
  // ручным — честная причина ВМЕСТО стандартного «Instagram не даёт удалять»
  // (см. докстринг manualSteps).
  let instagramManualReason: string | undefined;
  // Дополнительные чаты Telegram: что реально снято, что отказало, снят ли основной пост.
  const telegramExtraDone: string[] = [];
  const telegramExtraFailed: string[] = [];
  let telegramMainRemoved = false;

  // ЭТОТ КЛАСС БАГА (20.09.2026, п.3 задания): канал числится в
  // publishedChannels, а его id в publishedPostIds отсутствует — старая
  // версия просто пропускала блок целиком (`&& postIds.X`), не оставляя ни
  // записи в failed, ни строки в журнале. Со стороны это неотличимо от
  // «канал давно снят» — то самое молчание, ради которого правится весь
  // файл. FACEBOOK/YOUTUBE/TELEGRAM ниже теперь явно объясняют себя в этом
  // случае — попадают в failed и, значит, в общий logSystemError в конце.
  if (channels.includes("FACEBOOK")) {
    if (!postIds.FACEBOOK) {
      failed.push({ channel: "FACEBOOK", error: "в карточке нет сохранённого id поста Facebook — снять нечем" });
    } else {
      const creds = await loadCredentials();
      if (!creds.pageToken) failed.push({ channel: "FACEBOOK", error: "Facebook не подключён в Настройках" });
      else {
        let res = await deleteFacebookVideo(postIds.FACEBOOK, creds.pageToken);
        // Первая попытка отказала (не «объекта нет» — тот случай уже ok:true выше) —
        // пробуем запасной идентификатор того же поста (post_id, см. случай №112 в
        // socialPublish.ts). Одного видео id иногда мало: у поста страницы video id
        // и post_id — разные объекты Graph API.
        if (!res.ok && postIds.FACEBOOK_POST) {
          const videoError = res.error;
          const fallback = await deleteFacebookVideo(postIds.FACEBOOK_POST, creds.pageToken);
          // «Поста нет», когда само ВИДЕО только что отказало по другой причине, —
          // не повод вычеркнуть канал (23.09.2026). Видео — отдельный объект
          // Страницы: пост могли убрать, а ролик остался висеть во вкладке
          // «Видео», и «поста уже не было» стало бы неправдой, после которой
          // следующий ролик встал бы рядом с живым первым. Честнее оставить
          // канал в failed с настоящей причиной отказа видео.
          res = fallback.ok && fallback.ghost ? { ok: false, error: videoError } : fallback;
        }
        if (res.ok) {
          removed.push("FACEBOOK");
          if (res.ghost) notes.push({ channel: "FACEBOOK", note: "поста уже не было" });
        } else {
          failed.push({ channel: "FACEBOOK", error: res.error ?? "неизвестная ошибка" });
        }
      }
    }
  }

  if (channels.includes("YOUTUBE")) {
    if (!postIds.YOUTUBE) {
      failed.push({ channel: "YOUTUBE", error: "в карточке нет сохранённого id видео YouTube — снять нечем" });
    } else {
      const res = await deleteYouTubeVideo(await youtubeCredentials(), postIds.YOUTUBE);
      if (res.ok) {
        removed.push("YOUTUBE");
        // 404 — видео уже не было: то же честное «уже не было», что у Facebook и
        // Instagram, а не «удалено» (23.09.2026 — раньше YouTube молча писал
        // «удалено» о том, чего не существовало).
        if (res.ghost) notes.push({ channel: "YOUTUBE", note: "видео уже не было" });
      } else {
        failed.push({ channel: "YOUTUBE", error: res.error ?? "неизвестная ошибка" });
      }
    }
  }

  if (channels.includes("TELEGRAM")) {
    // ДОПОЛНИТЕЛЬНЫЕ ЧАТЫ (26.09.2026) — вложенный объект внутри publishedPostIds,
    // отдельное приведение типа (см. lib/socialPublish.ts::mergeTelegramExtraPostIds).
    const telegramExtraIds = (postIds as unknown as Record<string, unknown>).TELEGRAM_EXTRA as Record<string, string> | undefined;
    const hasExtra = !!telegramExtraIds && Object.keys(telegramExtraIds).length > 0;
    let mainRemoved = false;

    if (!postIds.TELEGRAM) {
      if (!hasExtra) {
        failed.push({ channel: "TELEGRAM", error: "в карточке нет сохранённого id сообщения Telegram — снять нечем" });
      } else {
        // ОСНОВНОЙ КАНАЛ НЕ БЫЛ НАСТРОЕН (26.09.2026) — публикация шла только в
        // дополнительные чаты, у основного естественно нет id, это не отказ.
        mainRemoved = true;
      }
    } else {
      const settings = await prisma.settings.findUnique({
        where: { id: "singleton" },
        select: { telegramChannelId: true },
      });
      const channelId = settings?.telegramChannelId?.trim();
      if (!channelId) failed.push({ channel: "TELEGRAM", error: "Канал Telegram не указан в Настройках" });
      else {
        try {
          await deleteChannelMessage(channelId, Number(postIds.TELEGRAM));
          mainRemoved = true;
        } catch (err) {
          // «Сообщения нет» — цель уже достигнута, тот же фантом, что у Facebook
          // (isGhostObjectError), Instagram и YouTube (404). До 23.09.2026 здесь это
          // был отказ: пост, удалённый из канала руками, навсегда держал канал
          // «занятым», и следующий ролик в Telegram уже не уезжал вовсе
          // (публикация пропускает каналы из publishedChannels).
          if (isTelegramMessageGone(err)) {
            mainRemoved = true;
            notes.push({ channel: "TELEGRAM", note: "сообщения уже не было" });
          } else {
            failed.push({ channel: "TELEGRAM", error: err instanceof Error ? err.message : String(err) });
          }
        }
      }
    }

    // ДОПОЛНИТЕЛЬНЫЕ ЧАТЫ — снимаем независимо от исхода основного канала;
    // отказ одного чата не мешает остальным и не влияет на mainRemoved (владелец
    // 24.09.2026: не ломать существующую логику основного канала).
    if (hasExtra) {
      for (const [chatId, messageId] of Object.entries(telegramExtraIds!)) {
        if (!messageId) {
          telegramExtraDone.push(chatId);
          continue;
        }
        try {
          await deleteChannelMessage(chatId, Number(messageId));
          telegramExtraDone.push(chatId);
        } catch (err) {
          if (isTelegramMessageGone(err)) {
            telegramExtraDone.push(chatId);
          } else {
            telegramExtraFailed.push(chatId);
            void logSystemError(
              "telegram",
              `Снятие из дополнительного чата Telegram ${chatId} (объект ${propertyId}) не удалось: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }
    }

    telegramMainRemoved = mainRemoved;
    if (mainRemoved && telegramExtraFailed.length === 0) removed.push("TELEGRAM");
    // НЕ ВСЁ СНЯТО (аудит 04.10.2026, PUB06): основной пост ушёл, а дополнительный чат
    // отказал (таймаут, 429). Раньше это только логировалось, а TELEGRAM_EXTRA стирался
    // вместе с каналом: ответ говорил «снято», сообщение висело в чате, и id для
    // повторного снятия больше не существовало. Теперь канал остаётся в карточке с
    // id упавших чатов, а честный отказ идёт в failed — повтор добьёт остаток.
    else if (mainRemoved) {
      failed.push({
        channel: "TELEGRAM",
        error: `не снято из дополнительных чатов: ${telegramExtraFailed.join(", ")} — повторите снятие`,
      });
    }
  }

  // INSTAGRAM (20.09.2026) — см. socialPublish.ts::deleteInstagramMedia. Токен не
  // задан — канал остаётся в manualSteps() ниже без единой строки в failed: это
  // НЕ отказ, это тот же список «руками», что был всегда (п.1 задания —
  // единственный случай, где журнал ЗАКОННО молчит).
  if (channels.includes("INSTAGRAM")) {
    const manageToken = await instagramManageToken();
    if (manageToken) {
      // Media id мог быть сохранён при публикации (videoHandoff.ts, объекты после
      // 20.09.2026) — для более старых ищем по permalink (Property.instagramUrl).
      let mediaId = postIds.INSTAGRAM || null;
      let searchIncompleteReason: string | null = null;
      if (!mediaId) {
        if (!property.instagramUrl) {
          // Токен есть, а ссылки на пост в карточке нет вовсе — искать нечем ни
          // по id, ни по permalink. Раньше это молча падало в manualSteps()
          // без единой записи — тот же класс бага, что и у FACEBOOK/YOUTUBE/
          // TELEGRAM выше, только для INSTAGRAM он был в самом первом отчёте
          // владельца (карточка №112).
          searchIncompleteReason = "в карточке нет ссылки на пост Instagram — нечем искать";
        } else {
          const creds = await loadCredentials();
          const igUserId = creds.pageId ? await resolveInstagramBusinessAccountId(manageToken, creds.pageId) : null;
          if (!igUserId) {
            searchIncompleteReason = "не удалось определить business-аккаунт Instagram по Странице Facebook";
          } else {
            const search: InstagramPermalinkSearchResult = await findInstagramMediaIdByPermalink(
              igUserId,
              manageToken,
              property.instagramUrl
            );
            if (search.status === "found") mediaId = search.mediaId;
            else if (search.status === "incomplete") searchIncompleteReason = search.reason;
            // search.status === "not_found" — лента дочитана до конца, поста в
            // ней нет: обрабатывается ниже как фантом (mediaId остаётся null,
            // searchIncompleteReason тоже — это ЕДИНСТВЕННЫЙ путь к ветке
            // «вычёркиваем как поста уже не было»).
          }
        }
      }

      if (mediaId) {
        const res = await deleteInstagramMedia(mediaId, manageToken);
        if (res.ok) {
          removed.push("INSTAGRAM");
          instagramCleared = true;
          if (res.ghost) notes.push({ channel: "INSTAGRAM", note: "поста уже не было" });
        } else {
          failed.push({ channel: "INSTAGRAM", error: res.error ?? "неизвестная ошибка" });
          instagramManualReason = `Пост нашли, но снять через API не удалось (${res.error ?? "неизвестная ошибка"}) — уберите в приложении.`;
        }
      } else if (searchIncompleteReason) {
        // ГЛАВНОЕ МЕСТО ЗАДАЧИ: «не нашли» ≠ «точно нет». Обход не дочитан —
        // канал НЕ вычёркиваем, причина уходит и в failed (→ общий
        // logSystemError ниже), и человеку — честным текстом, а не старым
        // «Instagram не даёт» (он есть, мы просто не проверили).
        failed.push({ channel: "INSTAGRAM", error: searchIncompleteReason });
        instagramManualReason = `Токен для удаления настроен, но мы не нашли этот пост в ленте аккаунта (не дочитали её: ${searchIncompleteReason}) — проверьте и уберите в приложении.`;
      } else {
        // Лента дочитана целиком (findInstagramMediaIdByPermalink дошла до
        // paging.next === null), искомой ссылки в ней нет — тот же фантом,
        // что и у Facebook (isGhostObjectError): пост удалили руками в
        // приложении. Канал свободен для следующей публикации.
        removed.push("INSTAGRAM");
        instagramCleared = true;
        notes.push({ channel: "INSTAGRAM", note: "поста уже не было" });
      }
    }
  }

  // THREADS (23.09.2026) — в отличие от TikTok, снятие поддерживает API
  // (DELETE /{post_id}, см. deleteThreadsPost в lib/socialPublish.ts). Тот же
  // класс бага, что у FACEBOOK/YOUTUBE/TELEGRAM выше: канал числится в
  // publishedChannels, а id в publishedPostIds.THREADS нет — явная запись в
  // failed, а не тихий пропуск.
  if (channels.includes("THREADS")) {
    if (!postIds.THREADS) {
      failed.push({ channel: "THREADS", error: "в карточке нет сохранённого id поста Threads — снять нечем" });
    } else {
      const settings = await prisma.settings.findUnique({
        where: { id: "singleton" },
        select: { threadsAccessToken: true },
      });
      const threadsToken = decryptSecretSafe(settings?.threadsAccessToken ?? null);
      if (!threadsToken) {
        failed.push({ channel: "THREADS", error: "Threads не подключён в Настройках" });
      } else {
        const res = await deleteThreadsPost(threadsToken, postIds.THREADS);
        if (res.ok) {
          removed.push("THREADS");
          if (res.ghost) notes.push({ channel: "THREADS", note: "поста уже не было" });
        } else {
          failed.push({ channel: "THREADS", error: res.error ?? "неизвестная ошибка" });
        }
      }
    }
  }

  const telegramPartial = telegramExtraFailed.length > 0 && telegramMainRemoved;
  if (removed.length > 0 || telegramPartial) {
    // ДЕЛЬТА К СВЕЖЕЙ КАРТОЧКЕ, а не снимок, прочитанный в начале (аудит 04.10.2026,
    // PUB06/PUB07): за время сетевых вызовов параллельная публикация могла сохранить
    // новый id или канал, и запись всего старого publishedPostIds стёрла бы его.
    // Канал вычёркиваем, только если его id в карточке всё тот же, что мы сняли.
    await updatePublishedMarks(propertyId, (current) => {
      const sameId = (c: string) => current.postIds[c] === (postIds as Record<string, unknown>)[c];
      const done = removed.filter(sameId);
      const nextPostIds = { ...current.postIds };
      for (const c of done) delete nextPostIds[c];
      // FACEBOOK_POST — второй идентификатор того же поста (см. PublishResult.
      // secondaryPostId в socialPublish.ts), а не отдельный канал — вычёркиваем
      // вместе с FACEBOOK, иначе он остался бы мёртвой строкой в publishedPostIds.
      if (done.includes("FACEBOOK")) delete nextPostIds.FACEBOOK_POST;
      // THREADS_URL — permalink того же поста под своим ключом (см.
      // applySucceededPublishResults в lib/videoHandoff.ts), не отдельный канал.
      if (done.includes("THREADS")) delete nextPostIds.THREADS_URL;
      // Дополнительные чаты: из TELEGRAM_EXTRA убираем только реально снятые;
      // упавшие остаются с id для повторного снятия (PUB06). Пустой ключ стираем
      // (26.09.2026, п.4 задания «после снятия убрать ключ»).
      if (telegramExtraDone.length > 0 || done.includes("TELEGRAM")) {
        const rest = { ...((nextPostIds.TELEGRAM_EXTRA as Record<string, string> | undefined) ?? {}) };
        for (const chatId of telegramExtraDone) delete rest[chatId];
        if (Object.keys(rest).length > 0) nextPostIds.TELEGRAM_EXTRA = rest;
        else delete nextPostIds.TELEGRAM_EXTRA;
      }
      // Основной пост Telegram снят, а канал остаётся из-за упавшего доп. чата: его id
      // больше не нужен, повтор увидит «основной не настроен, есть доп. чаты».
      if (telegramPartial && sameId("TELEGRAM")) delete nextPostIds.TELEGRAM;
      return {
        channels: current.channels.filter((c) => !done.includes(c)),
        postIds: nextPostIds,
        // instagramUrl — «объект показан в Instagram», и на нём же висит одно из
        // условий выхода в продажу (propertyPipeline.ts::blockersForSale). Пока
        // пост в Instagram реально висит, ссылку не трогаем; снятый — очищаем,
        // иначе повторная публикация решила бы, что там всё ещё что-то есть.
        ...(instagramCleared && done.includes("INSTAGRAM") ? { data: { instagramUrl: null } } : {}),
      };
    });
  }
  if (failed.length > 0) {
    void logSystemError(
      "meta",
      `Объект ${propertyId}: снятие публикаций — ${failed.map((f) => `${f.channel}: ${f.error}`).join("; ")}`
    );
  }

  // Ссылку собираем ДО фильтра ниже: id ролика в postIds остаётся, даже если
  // канал уже вычеркнут, а нужна она именно тем каналам, что остались ручными.
  const tiktokUrl = await tiktokPostUrl(postIds.TIKTOK);

  // Снятые API-каналы (сейчас может быть и INSTAGRAM, и THREADS) не должны
  // попадать в ручной список следом — manualSteps() без фильтра решил бы, что
  // канал всегда «только руками», даже когда мы его только что удалили сами.
  return {
    removed,
    failed,
    manual: manualSteps(
      channels.filter((c) => !removed.includes(c)),
      instagramCleared ? null : property.instagramUrl,
      instagramManualReason,
      tiktokUrl,
      postIds.THREADS_URL
    ),
    notes,
  };
}

export type SendBackResult =
  | {
      ok: true;
      queued: boolean;
      message: string;
      social?: SocialRemovalResult;
      /** Ролик ждал проверки модератора и этим возвратом отклонён (25.09.2026,
       *  lib/clipReview.ts): вызывающий гасит кнопки у модераторов в Telegram. */
      clipReviewWasPending?: boolean;
    }
  | {
      ok: false;
      error: string;
      /** true — объект изменился после того, как вызывающий его видел (`options.guard`). */
      stale?: true;
    };

/**
 * «УДАЛЕНО В ПРИЛОЖЕНИИ» (24.09.2026) — человек снял пост руками там, где программа
 * не может: TikTok всегда, Instagram без ключа удаления. До этого такой канал
 * оставался в `publishedChannels` навсегда, и при замене ролика новый туда уже не
 * уходил — публикация пропускает каналы, где старый стоит. Кнопка вычёркивает
 * канал ровно так же, как `removeFromSocial` вычёркивает снятый программой.
 *
 * Сами проверить, что пост удалён, мы не можем (у TikTok нет такого запроса), —
 * верим человеку, и поэтому кнопка только у кабинета маркетинга. Пока идёт
 * публикация, вычёркивать нельзя: она допишет каналы поверх, и отметка потеряется.
 *
 * `willPublish` — уйдёт ли новый ролик туда сам: да, если его публикация ещё ждёт
 * своего часа; иначе туда выкладывают кнопкой (для TikTok — «Опубликовать в TikTok»).
 */
export async function markRemovedByHand(
  propertyId: string,
  channel: "INSTAGRAM" | "TIKTOK"
): Promise<{ ok: true; changed: boolean; willPublish: boolean; publishRunning: boolean } | { ok: false; status: number; error: string }> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { deletedAt: true, publishedChannels: true, publishedPostIds: true },
  });
  if (!property || property.deletedAt) return { ok: false, status: 404, error: "Объект не найден или удалён" };

  const job = await prisma.backgroundJob.findUnique({
    where: { dedupeKey: videoHandoffPublishDedupeKey(propertyId) },
    select: { status: true },
  });
  // ИДУЩАЯ ПУБЛИКАЦИЯ ОТМЕТКУ НЕ БЛОКИРУЕТ (05.10.2026, владелец удалил пост в Instagram
  // руками, а CRM отвечала «идёт публикация»). Задание читает список сетей один раз на
  // старте (skipChannels), а каналы дописывает по свежему состоянию карточки
  // (applySucceededPublishResults) — вычеркнутый здесь канал оно не вернёт. Ролик в эту
  // сеть уйдёт при следующем проходе задания или кнопкой «Опубликовать сейчас».
  const publishRunning = await isHandoffPublishRunning(propertyId);
  const willPublish = job?.status === "PENDING";

  const channels = property.publishedChannels ?? [];
  if (!channels.includes(channel)) return { ok: true, changed: false, willPublish, publishRunning };

  // Условная запись по свежей карточке, а не снимок (аудит 04.10.2026, PUB07).
  await updatePublishedMarks(propertyId, (current) => {
    if (!current.channels.includes(channel)) return null;
    const postIds = { ...current.postIds };
    delete postIds[channel];
    return {
      channels: current.channels.filter((c) => c !== channel),
      postIds,
      // Та же причина, что в removeFromSocial: ссылка на Instagram — признак
      // «объект там показан», снятый пост её не держит.
      ...(channel === "INSTAGRAM" ? { data: { instagramUrl: null } } : {}),
    };
  });
  return { ok: true, changed: true, willPublish, publishRunning };
}

/**
 * ВЕРНУТЬ ОБЪЕКТ МОНТАЖЁРУ — С ПРИЧИНОЙ (20.09.2026, решение владельца: «чтобы
 * просто так не ходил, а причину чтобы я указал, зачем, чтобы он тоже
 * прочитал»). Поля карточки объекта по-прежнему не трогаются вообще — заполнять
 * её второй раз не надо, надо перемонтировать ролик по указанной причине.
 *
 * Сырое видео после выхода объекта в продажу удаляется уборкой
 * (lib/propertyVideoCleanup.ts — гигабайты исходников не живут на сервере
 * вечно). Поэтому «нечего отправлять» — обычный, а не исключительный случай, и
 * отвечать на него надо понятным человеку текстом, а не пустой отправкой,
 * после которой монтажёр ждёт файл, которого нет.
 *
 * CARD_DATA_CHANGED — НЕ брак монтажёра (isVideoRemakeEditorFault, @royal-home/
 * shared): Property.videoRemakeCount растёт при любой причине (это просто
 * «сколько раз объект уходил на монтаж»), а отдельного счётчика вины монтажёра
 * здесь намеренно нет — владелец 20.09.2026 отменил уведомления и алармы по
 * числу заходов («сколько хочет, столько и кругов будет идти»), список причин
 * в VideoRemakeRequest остаётся источником правды, если статистика понадобится
 * позже.
 *
 * ЧЕТЫРЕ ДЫРЫ, ЗАКРЫТЫЕ 24.09.2026 (docs/agent-briefs/send-back-api-24-09.md):
 * 1. Обе проверки рубильника (videoHandoffEnabled И videoMontajerAgentId) —
 *    ДО транзакции, понятным текстом. «Честность после» из задания здесь
 *    закрыта СИЛЬНЕЕ, чем текстом отказа: сама постановка в очередь
 *    (queueVideoHandoffInTx) теперь выполняется ВНУТРИ той же транзакции,
 *    что и проверка рубильника (см. п.2) — статус физически не может
 *    остаться NONE после успешного коммита, ветку «отказ уже после записи»
 *    доказывать не от чего.
 * 2. Проверка состояния + транзакция + САМА ПОСТАНОВКА В ОЧЕРЕДЬ
 *    (queueVideoHandoffInTx) — под одним withPropertyLock(propertyId, …).
 *    Первая версия правки оборачивала в замок только проверку состояния и
 *    создание VideoRemakeRequest, а queueVideoHandoff звала уже ПОСЛЕ
 *    снятия замка (своей отдельной транзакцией) — в открывшуюся между
 *    коммитом и этим вызовом щель успевал проскочить второй параллельный
 *    запрос (видел статус ещё NONE) и заводил вторую VideoRemakeRequest;
 *    поймано тестом «два параллельных запроса» на этой же правке. Перенос
 *    смены статуса ВНУТРЬ замка закрывает гонку целиком: к моменту, когда
 *    второй запрос получает доступ к строке, статус уже QUEUED/SENT_TO_EDITOR.
 * 3. Возврат монтажёру объекта, который у него ни разу не был (нет
 *    videoHandoffFinalPath и нет ни одной публикации), — отказ: это работа
 *    «Отправить на монтаж», а не «Вернуть монтажёру».
 * 4. removeFromSocial: true снимает старый ролик из соцсетей тем же
 *    removeFromSocial, что у кнопки «Убрать из соцсетей» — СНАРУЖИ замка
 *    (сетевые вызовы к Facebook/Instagram/YouTube/Telegram под замком
 *    объекта держать нельзя), но до дозвона монтажёру в Telegram. Неудача
 *    снятия не отменяет возврат монтажёру.
 */
export async function sendBackToMontajer(
  propertyId: string,
  requestedById: string,
  reason: VideoRemakeReason,
  comment?: string | null,
  replaceVideoIds?: string[] | null,
  /** removeFromSocial: true — снять старые посты сейчас; "on-new-video" — когда
   *  выйдет новый ролик (задание публикации, replaceOldPostsBeforeRemakePublish). */
  options?: {
    removeFromSocial?: boolean | "on-new-video";
    /**
     * УСЛОВИЕ ЗАПИСИ (31.10.2026, ИИ-помощник, П3): `Property.videoRemakeCount` растёт при
     * каждом возврате, поэтому «счётчик всё ещё тот, что видел человек в превью» значит
     * «объект никто не отправлял на перемонтаж с тех пор». Проверяется ПОД замком, до
     * записи; расхождение — отказ с `stale: true`. REST поле не передаёт.
     */
    guard?: { videoRemakeCount: number };
    /**
     * ПРОВЕРКА БЕЗ ЗАПИСИ (31.10.2026, ИИ-помощник, П3): прогоняет все отказы функции
     * (занят монтажёром, продан, нет истории ролика, нет исходников, рубильник) под тем же
     * замком и возвращает `ok` ДО первой записи. Превью помощника показывает отказ
     * теми же словами, что и настоящая отправка, а не своей копией условий.
     */
    dryRun?: boolean;
  }
): Promise<SendBackResult> {
  const replacing = replaceVideoIds && replaceVideoIds.length > 0 ? [...new Set(replaceVideoIds)] : null;

  type Prepared = {
    title: string;
    sellerClientId: string | null;
    removedStorageKeys: string[];
    queueOutcome: { dispatch: false } | { dispatch: true; propertyId: string; montajerAgentId: string };
    clipReviewWasPending: boolean;
  };
  type LockResult = { ok: true; data: Prepared } | { ok: true; dryRun: true } | { ok: false; error: string; stale?: true };

  // ВСЁ, ЧТО РЕШАЕТ СУДЬБУ ЭТОГО ОБЪЕКТА (проверка состояния + запись), — под
  // одним замком (п.2): второй параллельный вызов, пришедший, пока первый ещё
  // не закоммитился, видит уже обновлённое состояние и получает тот же отказ,
  // а не создаёт вторую заявку на перемонтаж.
  const lockResult: LockResult = await withPropertyLock(propertyId, async (tx) => {
    const property = await tx.property.findUnique({
      where: { id: propertyId },
      select: {
        id: true,
        title: true,
        deletedAt: true,
        status: true,
        videoHandoffStatus: true,
        videoHandoffFinalPath: true,
        publishedChannels: true,
        instagramUrl: true,
        sellerClientId: true,
        clipReviewStatus: true,
        videoRemakeCount: true,
        _count: { select: { videos: true } },
      },
    });
    if (!property || property.deletedAt) return { ok: false, error: "Объект не найден или удалён." };
    if (options?.guard && property.videoRemakeCount !== options.guard.videoRemakeCount) {
      return { ok: false, error: "Объект уже отправляли на перемонтаж после показа превью — проверьте ещё раз.", stale: true };
    }
    if (property.videoHandoffStatus === "QUEUED" || property.videoHandoffStatus === "SENT_TO_EDITOR") {
      return { ok: false, error: "Объект уже у монтажёра или стоит в очереди — второй раз отправлять нечего." };
    }
    /**
     * ЗАМОК ПРОТИВ ИДУЩЕЙ ПУБЛИКАЦИИ (25.09.2026, Б3) — для любого возврата, не
     * только «со снятием из соцсетей». Идущее задание допубликует старый ролик
     * в оставшиеся сети, а в конце освободит место монтажёра (releaseQueueIfClear)
     * и может вывести объект в продажу — поверх только что вставшего на монтаж.
     * Минута ожидания честнее. Тем же tx: под замком объекта.
     */
    if (await isHandoffPublishRunning(propertyId, tx)) {
      return { ok: false, error: HANDOFF_PUBLISH_RUNNING_ERROR };
    }
    /**
     * ЗАДАНИЕ F (24.09.2026, аудит «монтажёр ↔ CRM ↔ соцсети»): раньше функция
     * смотрела только на videoHandoffStatus, не на судьбу самого объекта —
     * проданный или снятый с продажи объект можно было отправить на перемонтаж
     * так же, как живой. SOLD/WITHDRAWN — «мёртвые» статусы (PropertyStatus,
     * schema.prisma): в SOLD правки объекта заморожены логикой продажи, а
     * WITHDRAWN — сознательный отказ агента от дальнейшей рекламы; ни тому, ни
     * другому новый ролик уже не нужен.
     */
    if (property.status === "SOLD" || property.status === "WITHDRAWN") {
      const label = property.status === "SOLD" ? "продан" : "снят с продажи";
      return { ok: false, error: `Объект ${label} — отправлять его на перемонтаж нет смысла.` };
    }

    // П.3: «Вернуть монтажёру» имеет смысл только для объекта, который у
    // монтажёра УЖЕ был — либо получен готовый ролик, либо что-то опубликовано.
    // Для объекта, который на монтаже ещё не был вовсе, это «Отправить на
    // монтаж» (requeueVideoHandoff), а не эта функция.
    // Следом прошлого ролика считаются и ссылка, вписанная руками, и статус «в продаже»
    // (старые объекты не хранят ни сетей, ни файла; 07.10.2026, решение владельца).
    if (!hasVideoHistory(property)) {
      return {
        ok: false,
        error: "Объект ещё не был у монтажёра — используйте «Отправить на монтаж».",
      };
    }

    /**
     * ЗАМЕНА ИСХОДНИКА (22.09.2026). Новые ролики к этому моменту уже лежат в
     * PropertyVideo — их собрал upload-sessions/complete. Проверяем, что каждый id
     * реально принадлежит ЭТОМУ объекту: иначе чужой id стал бы способом стереть
     * исходники объекта, не загрузив ничего взамен.
     */
    if (replacing) {
      const found = await tx.propertyVideo.count({ where: { id: { in: replacing }, propertyId } });
      if (found !== replacing.length) {
        return { ok: false, error: "Новый исходник не найден среди роликов объекта — загрузите его ещё раз." };
      }
    } else if (property._count.videos === 0) {
      return {
        ok: false,
        error: "Исходные ролики этого объекта уже удалены с сервера после публикации. Загрузите новый исходник в окне «Вернуть монтажёру» — и объект уйдёт монтажёру с ним.",
      };
    }

    // П.1: ОБЕ проверки рубильника — ДО любой записи, понятным текстом.
    // Раньше здесь проверялся только videoHandoffEnabled, а отсутствие
    // назначенного монтажёра ловил queueVideoHandoff уже ПОСЛЕ транзакции:
    // logSystemError и молчаливый return, а эта функция всё равно отвечала
    // ok:true — «Отправлено монтажёру» при объекте, которого никто не получил.
    const settings = await tx.settings.findUnique({
      where: { id: "singleton" },
      select: { videoHandoffEnabled: true, videoMontajerAgentId: true },
    });
    if (!settings?.videoHandoffEnabled) {
      return { ok: false, error: "Передача монтажёру выключена в Настройках." };
    }
    if (!settings.videoMontajerAgentId) {
      return { ok: false, error: "Монтажёр не назначен в Настройках → Публикации." };
    }
    if (options?.dryRun) return { ok: true, dryRun: true };

    const reasonLabel = VIDEO_REMAKE_REASON_LABELS[reason];
    // Тот же builder, что и настоящая отправка/превью (buildMontajerMessageText,
    // lib/videoHandoff.ts) — записываем СЕЙЧАС, пока факты карточки те же, что
    // увидит монтажёр: если место занято и отправка ушла в очередь, dispatchToEditor
    // выполнится позже уже по данным на объекте, но текст здесь и там совпадёт,
    // пока карточку не поправили между постановкой в очередь и реальной отправкой.
    const messageText = await buildMontajerMessageText(propertyId, { reason, comment });

    /**
     * ОДНА ТРАНЗАКЦИЯ (тот же замок, что и проверки выше): удаление строк
     * старых исходников при замене, счётчик, заявка на перемонтаж И сама
     * постановка в очередь (queueVideoHandoffInTx — п.2, докстринг выше).
     * Файлы старых исходников удаляются с диска только ПОСЛЕ коммита: откат
     * транзакции не должен оставить строки, указывающие на уже стёртые файлы.
     */
    let removedStorageKeys: string[] = [];
    if (replacing) {
      const old = await tx.propertyVideo.findMany({
        where: { propertyId, id: { notIn: replacing } },
        select: { id: true, storageKey: true },
      });
      if (old.length > 0) {
        await tx.propertyVideo.deleteMany({ where: { id: { in: old.map((v) => v.id) } } });
      }
      removedStorageKeys = old.map((v) => v.storageKey);
    }
    /**
     * СТАРЫЙ СЛОТ ГАСНЕТ ВМЕСТЕ С ВОЗВРАТОМ (25.09.2026, Б6). Раньше час выхода
     * прежнего ролика и его ждущее задание переживали возврат: задание в свой
     * час выпускало в сети ролик, отправленный на переделку, а карточка и
     * «Расписание» держали строку «Публикация запланирована». Теперь — в той же
     * транзакции: слот и причина обнуляются, ждущие задания публикации и
     * отложенного повтора TikTok удаляются, недоделанный Reels прошлого ролика
     * отменяется. Сам файл (videoHandoffFinalPath) остаётся — признак «ждёт
     * перемонтаж» несёт статус передачи (QUEUED/SENT_TO_EDITOR ниже), а файл
     * заменит приём нового ролика (finishReceivingVideo убирает прежний).
     */
    /**
     * РОЛИК НА ПРОВЕРКЕ МОДЕРАТОРА (25.09.2026, lib/clipReview.ts) — возврат и
     * есть решение «Вернуть монтажёру»: откуда бы его ни нажали (Telegram,
     * блок проверки или обычное окно «Вернуть монтажёру» в карточке), проверка
     * закрывается здесь же, той же транзакцией, а не вторым путём рядом.
     */
    const clipReviewWasPending = property.clipReviewStatus === "PENDING";
    await tx.property.update({
      where: { id: propertyId },
      data: {
        videoRemakeCount: { increment: 1 },
        scheduledPublishAt: null,
        scheduledPublishReason: null,
        ...(clipReviewWasPending
          ? {
              clipReviewStatus: "REJECTED" as const,
              clipReviewDecidedAt: new Date(),
              clipReviewDecidedById: requestedById,
              clipReviewComment: comment ? `${reasonLabel}: ${comment}` : reasonLabel,
            }
          : {}),
      },
    });
    await tx.backgroundJob.deleteMany({
      where: {
        dedupeKey: { in: [videoHandoffPublishDedupeKey(propertyId), tiktokPublishRetryDedupeKey(propertyId)] },
        status: "PENDING",
      },
    });
    await tx.pendingInstagramContainer.updateMany({
      where: { propertyId, status: "PENDING", kind: "REEL" },
      data: { status: "CANCELLED", resolvedAt: new Date(), error: "Ролик возвращён монтажёру — Reels прежнего ролика отменён" },
    });
    await tx.videoRemakeRequest.create({
      data: {
        propertyId,
        reason,
        comment: comment ?? null,
        requestedById,
        messageText,
        replaceOldPostsOnPublish: options?.removeFromSocial === "on-new-video",
      },
    });

    if (property.sellerClientId) {
      await logTimeline({
        clientId: property.sellerClientId,
        // Актор — кто фактически нажал «Вернуть монтажёру» (requireAuth гарантирует
        // req.agent на роуте) — НЕ владелец объекта по умолчанию, см. lib/timeline.ts.
        actor: { kind: "agent", agentId: requestedById },
        type: "STATUS_CHANGE",
        propertyId: property.id,
        notes:
          `Объект «${property.title}» возвращён монтажёру на переделку. Причина: ${reasonLabel}.` +
          (comment ? ` Комментарий: ${comment}` : "") +
          (replacing ? " Исходник заменён новым." : ""),
      });
    }

    // П.2: статус переводится в QUEUED/SENT_TO_EDITOR ЗДЕСЬ, тем же tx —
    // видео уже заменены (если replaceVideoIds), заявка уже создана, так что
    // к моменту дозвона монтажёру (снаружи, после коммита) propertyVideo уже
    // в финальном виде. montajerAgentId берём из settings, уже прочитанных
    // выше в ЭТОЙ ЖЕ транзакции — без повторного чтения, без второго окна гонки.
    //
    // В НАЧАЛО ОЧЕРЕДИ (24.09.2026, владелец: «чтобы очередь всегда была
    // соблюдена»): переделка уже сданного ролика не ждёт за новыми объектами,
    // но и место чужого держателя не отбирает — встаёт первой среди ждущих,
    // а файлы уходят, только когда место дойдёт до неё (releaseQueueIfClear).
    const queueOutcome = await queueVideoHandoffInTx(tx, propertyId, settings.videoMontajerAgentId, { reason, comment }, "front");

    return {
      ok: true,
      data: { title: property.title, sellerClientId: property.sellerClientId, removedStorageKeys, queueOutcome, clipReviewWasPending },
    };
  });

  if (!lockResult.ok) return lockResult;
  if ("dryRun" in lockResult) return { ok: true, queued: false, message: "Проверка пройдена, ничего не записано." };
  for (const key of lockResult.data.removedStorageKeys) void localVideoDelete(key);

  // П.4 (24.09.2026): снять старый ролик из соцсетей тем же removeFromSocial,
  // что у кнопки «Убрать из соцсетей» — не изобретать вторую копию логики
  // удаления. Сетевые вызовы (Facebook/Instagram/YouTube/Telegram) идут ВНЕ
  // замка объекта (он уже снят — транзакция выше закоммичена), но раньше
  // дозвона монтажёру ниже. Неудача снятия НЕ отменяет возврат монтажёру:
  // removeFromSocial сам пишет неудачные каналы в failed и в logSystemError,
  // мы только прокидываем итог наружу.
  const social = options?.removeFromSocial === true ? await removeFromSocial(propertyId) : undefined;

  // Дозвон монтажёру (Telegram, сеть) — вне замка, как и в queueVideoHandoff
  // (videoHandoff.ts): держать advisory-лок объекта на время сетевого похода
  // незачем. queued/message ниже читаются из queueOutcome, а не повторным
  // запросом статуса — п.2 делает его заранее известным и точным.
  const { queueOutcome } = lockResult.data;
  if (queueOutcome.dispatch) await dispatchToEditor(queueOutcome.propertyId, queueOutcome.montajerAgentId);
  const queued = !queueOutcome.dispatch || queueOutcome.propertyId !== propertyId;

  return {
    ok: true,
    queued,
    message: queued ? "Поставлено в очередь монтажёру." : "Отправлено монтажёру.",
    ...(social ? { social } : {}),
    ...(lockResult.data.clipReviewWasPending ? { clipReviewWasPending: true } : {}),
  };
}

/**
 * СТАРЫЕ ПОСТЫ УХОДЯТ, КОГДА ВЫХОДИТ НОВЫЙ РОЛИК (30.10.2026, владелец: «когда выйдет
 * новый»). Возврат по смене цены или данных карточки (`removeFromSocial: "on-new-video"`)
 * оставляет старый ролик висеть, пока монтажёр работает, — объект всё это время виден.
 * Зовёт задание публикации нового ролика ПЕРЕД публикацией (jobs/videoHandoffPublish.ts):
 *
 *  1. снимает старые посты тем же removeFromSocial, что у кнопки «Убрать из соцсетей»;
 *  2. Instagram и TikTok, которые снять нельзя (только руками), вычёркивает из
 *     `publishedChannels` — иначе публикация пропустила бы их, и новая цена туда не
 *     попала бы; хозяину объекта уходит пуш со ссылками на старые посты;
 *  3. канал, где снятие отказало по сбою, остаётся в карточке: новый ролик туда не
 *     выйдет, зато не встанет дублем рядом со старым (причина — в журнале).
 *
 * Отметка `oldPostsReplacedAt` ставится один раз: повтор задания после сбоя сети не
 * снимает уже вышедший НОВЫЙ ролик. Возвращает null, если замены не просили.
 */
export async function replaceOldPostsBeforeRemakePublish(
  propertyId: string
): Promise<{ social: SocialRemovalResult; manual: ManualStep[] } | null> {
  const request = await prisma.videoRemakeRequest.findFirst({
    where: { propertyId, replaceOldPostsOnPublish: true, oldPostsReplacedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!request) return null;
  // Отметка ДО сетевых вызовов: упади задание посреди снятия — повтор не пойдёт снимать
  // второй раз то, что могло уже стать новым роликом.
  const claimed = await prisma.videoRemakeRequest.updateMany({
    where: { propertyId, replaceOldPostsOnPublish: true, oldPostsReplacedAt: null },
    data: { oldPostsReplacedAt: new Date() },
  });
  if (claimed.count === 0) return null;

  const social = await removeFromSocial(propertyId, undefined, { insidePublishJob: true });
  const manual = social.manual.filter((s) => s.channel === "INSTAGRAM" || s.channel === "TIKTOK");
  if (manual.length > 0) {
    const leave = manual.map((s) => s.channel as string);
    await updatePublishedMarks(propertyId, (current) => {
      const nextPostIds = { ...current.postIds };
      for (const c of leave) delete nextPostIds[c];
      return {
        channels: current.channels.filter((c) => !leave.includes(c)),
        postIds: nextPostIds,
        ...(leave.includes("INSTAGRAM") ? { data: { instagramUrl: null } } : {}),
      };
    });
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { shortId: true, title: true, intakeAgentId: true, assignedAgentId: true, createdById: true },
    });
    const body = manual.map((s) => `${s.channel === "INSTAGRAM" ? "Instagram" : "TikTok"}: ${s.url ?? "найдите старый ролик в приложении"}`).join("\n");
    void logSystemError(
      "meta",
      `Объект №${property?.shortId ?? propertyId}: вышел перемонтированный ролик, старый удалите руками — ${body.replace(/\n/g, "; ")}`,
      { dedupKey: "Объект №…: вышел перемонтированный ролик, старый удалите руками" }
    );
    const ownerId = property ? propertyOwnerAgentId(property) : null;
    if (ownerId && property) {
      void sendPushToAgent(ownerId, {
        title: `Новый ролик №${property.shortId} выходит — удалите старый`,
        body: `${property.title}\n${body}`,
        url: `/properties/${property.shortId}`,
        tag: `remake-old-posts-${propertyId}`,
      }).catch(() => {});
    }
  }
  return { social, manual };
}

/**
 * ОТКРЫТЬ ОБЪЕКТ ДЛЯ РУЧНОЙ ЗАГРУЗКИ ГОТОВОГО РОЛИКА.
 *
 * Готовый ролик мог прийти мимо бота — в WhatsApp, на флешке, от другого
 * монтажёра. Приёмник у него тот же (`receiveEditedVideo`), но тот требует
 * `SENT_TO_EDITOR`: объект должен «ждать» файл. Эта функция и создаёт такое
 * ожидание, ничего больше не меняя.
 */
export async function openForManualFinalVideo(propertyId: string): Promise<{ ok: boolean; error?: string }> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { deletedAt: true, videoHandoffStatus: true },
  });
  if (!property || property.deletedAt) return { ok: false, error: "Объект не найден или удалён." };
  if (property.videoHandoffStatus === "SENT_TO_EDITOR") return { ok: true };
  /**
   * ПРОШЛЫЙ РОЛИК ЕЩЁ ПУБЛИКУЕТСЯ — ЗАМЕНУ НЕ ОТКРЫВАЕМ (24.09.2026, проверка
   * готового ролика по классам). Задание публикации держит путь к прежнему
   * файлу и читает его минутами (YouTube, TikTok, Telegram — с диска), а приём
   * нового этот файл удаляет. Постановка нового задания при RUNNING — пустая
   * (jobs/enqueue.ts не трогает исполняющееся), так что новый ролик не ушёл бы
   * никуда, а у прежнего отвалились бы оставшиеся сети. Минута ожидания честнее.
   */
  if (await isHandoffPublishRunning(propertyId)) {
    return { ok: false, error: "Прошлый ролик этого объекта прямо сейчас уходит в сети — подождите пару минут и загрузите новый." };
  }
  /**
   * РУЧНОЕ ОЖИДАНИЕ НЕ ЗАНИМАЕТ МЕСТО МОНТАЖЁРА (23.09.2026, жалоба владельца:
   * «в CRM написано, что объект у монтажёра, а тот ничего не получил», и очередь
   * за ним стояла, пока объект не сняли с монтажа руками).
   *
   * Раньше здесь ставился голый SENT_TO_EDITOR — ровно то же, что у настоящей
   * передачи. Загрузка, которая упала или была брошена (большой файл, обрыв
   * сети, закрытая вкладка; докачка с середины открывает ожидание уже на старте
   * сессии), оставляла объект «у монтажёра» навсегда: очередь за ним стояла,
   * монтажёру ничего не уходило, досылать было нечего, а сторож досылки видел
   * доставку прошлого круга и молчал. Отметка videoHandoffManualSince выводит
   * такой объект из очереди (EDITOR_HOLDER_WHERE, lib/videoHandoff.ts), а
   * брошенное ожидание снимает сторож lib/videoHandoffRedelivery.ts.
   */
  await prisma.property.update({
    where: { id: propertyId },
    // videoHandoffSentAt — время начала ожидания: по нему бот выбирает, к какому
    // объекту привязать входящий файл, и «самый старый SENT_TO_EDITOR» без даты
    // сортировался бы никак.
    data: { videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffSentAt: new Date(), videoHandoffManualSince: new Date() },
  });
  return { ok: true };
}

export interface CaptionRefreshResult {
  caption: string;
  updated: string[];
  failed: { channel: string; error: string }[];
  manual: ManualStep[];
}

/**
 * ПЕРЕСОБРАТЬ ПОДПИСЬ ИЗ КАРТОЧКИ И РАЗОСЛАТЬ В ВЫШЕДШИЕ ПОСТЫ.
 *
 * Для случая «агент неправильно заполнил карточку»: поля поправили, а посты
 * остались со старым текстом. Родственник publishedListingSync.ts (там та же
 * рассылка, но узко — при смене цены, точечной заменой строки). Здесь подпись
 * собирается ЗАНОВО из текущих полей, потому что поправить могли что угодно, а
 * не только цену.
 *
 * Надпись ВНУТРИ кадра этим не меняется никогда — это работа монтажёра
 * (sendBackToMontajer). Обещать обратное значило бы повторить ровно ту ошибку,
 * из-за которой весь этот файл появился.
 */
export async function refreshPublishedCaptions(
  propertyId: string,
  opts: { keepStoredCaption?: boolean } = {}
): Promise<CaptionRefreshResult> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: {
      district: true,
      // Внутренние номера — из них собирается код агента в подвале подписи
      // (см. codesFooterFor). Агент у объекта меняется, и подпись обязана
      // догонять: иначе клиент назовёт код человека, который объект уже не ведёт.
      assignedAgent: { select: { fullName: true, phone: true, sipExtension: true } },
      intakeAgent: { select: { fullName: true, phone: true, sipExtension: true } },
      createdBy: { select: { fullName: true, phone: true } },
    },
  });
  if (!property) return { caption: "", updated: [], failed: [{ channel: "—", error: "Объект не найден" }], manual: [] };
  // Агент в концовке — тот же порядок, что при создании и «Перегенерировать».
  const captionAgent = property.intakeAgent ?? property.assignedAgent ?? property.createdBy ?? null;

  const money = await loadMoneyContext();
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { reelsCaptionTemplates: true, telegramChannelId: true },
  });
  // «Готово» после правки шлёт подпись, которую PATCH уже переписал точечно
  // (rewriteStoredCaptionAfterEdit ниже): у неё живые фразы ИИ и шаблон дня
  // публикации. Пересборка с нуля — только кнопкой «Обновить подписи», и тоже
  // одним и тем же шаблоном для объекта (seed — id), а не случайным.
  const captionBase =
    opts.keepStoredCaption && property.reelsCaption?.trim()
      ? property.reelsCaption
      : generateReelsCaptionFromTemplates(
          captionValuesOf(property, property.district?.name ?? "", money),
          settings?.reelsCaptionTemplates,
          property.id
        );
  // Подвал с номером объекта — последним, уже по сохранённому номеру. Дальше по
  // функции в сети уходит ИМЕННО эта строка: подпись в карточке и подпись под
  // постом обязаны совпадать до символа. withPostFooter идемпотентен, поэтому
  // сохранённая подпись с подвалом не получит второй.
  // Концовка с агентом (25.09.2026) ставится и на сохранённую подпись: так
  // «Обновить подписи» доносит смену агента или его номера до вышедших постов.
  const caption = withPostFooter(applyContactFooter(captionBase, captionAgent), property.shortId);
  await prisma.property.update({ where: { id: propertyId }, data: { reelsCaption: caption } });

  const channels = property.publishedChannels ?? [];
  const postIds = (property.publishedPostIds ?? {}) as Record<string, string>;
  const updated: string[] = [];
  const failed: { channel: string; error: string }[] = [];
  let scopeReported = false;

  // Тот же класс бага, что в removeFromSocial (п.3 задания, 20.09.2026): канал
  // числится в publishedChannels, а id в publishedPostIds нет — раньше блок
  // просто пропускался (`&& postIds.X`) без записи в failed и без журнала.
  if (channels.includes("FACEBOOK")) {
    if (!postIds.FACEBOOK) {
      failed.push({ channel: "FACEBOOK", error: "в карточке нет сохранённого id поста Facebook — подпись обновить нечем" });
    } else {
      const creds = await loadCredentials();
      if (!creds.pageToken) failed.push({ channel: "FACEBOOK", error: "Facebook не подключён в Настройках" });
      else {
        const res = await updateFacebookVideoDescription(postIds.FACEBOOK, creds.pageToken, caption);
        res.ok ? updated.push("FACEBOOK") : failed.push({ channel: "FACEBOOK", error: res.error ?? "неизвестная ошибка" });
      }
    }
  }

  if (channels.includes("TELEGRAM")) {
    // ДОПОЛНИТЕЛЬНЫЕ ЧАТЫ (26.09.2026) — та же нетипичная запись, что в
    // removeFromSocial выше (см. lib/socialPublish.ts::mergeTelegramExtraPostIds).
    const telegramExtraIds = (postIds as unknown as Record<string, unknown>).TELEGRAM_EXTRA as Record<string, string> | undefined;
    const hasExtra = !!telegramExtraIds && Object.keys(telegramExtraIds).length > 0;

    if (!postIds.TELEGRAM) {
      if (!hasExtra) {
        failed.push({ channel: "TELEGRAM", error: "в карточке нет сохранённого id сообщения Telegram — подпись обновить нечем" });
      }
      // иначе — основной канал не был настроен (публикация шла только в
      // дополнительные чаты), это не отказ.
    } else if (!settings?.telegramChannelId?.trim()) {
      failed.push({ channel: "TELEGRAM", error: "Канал Telegram не указан в Настройках" });
    } else {
      try {
        await editMessageCaption(settings.telegramChannelId.trim(), Number(postIds.TELEGRAM), caption);
        updated.push("TELEGRAM");
      } catch (err) {
        failed.push({ channel: "TELEGRAM", error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Правим независимо от исхода основного канала; отказ одного чата не
    // мешает остальным и не портит updated/failed основного (владелец
    // 24.09.2026: не ломать существующую логику).
    if (hasExtra) {
      for (const [chatId, messageId] of Object.entries(telegramExtraIds!)) {
        if (!messageId) continue;
        try {
          await editMessageCaption(chatId, Number(messageId), caption);
        } catch (err) {
          void logSystemError(
            "telegram",
            `Обновление подписи в дополнительном чате Telegram ${chatId} (объект ${propertyId}) не удалось: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  }

  if (channels.includes("YOUTUBE")) {
    if (!postIds.YOUTUBE) {
      failed.push({ channel: "YOUTUBE", error: "в карточке нет сохранённого id видео YouTube — подпись обновить нечем" });
    } else {
      // title = description — то же правило, что при публикации и в
      // publishedListingSync.ts: part=snippet заменяет snippet целиком.
      const res = await updateYouTubeDescription(await youtubeCredentials(), postIds.YOUTUBE, caption, caption);
      if (res.ok) updated.push("YOUTUBE");
      else if (isYoutubeScopeError(res.error)) {
        // Нет права у ключа — причина общая для ВСЕХ объектов (lib/youtubeScope.ts):
        // одна суточная строка с рецептом, а не по строке на объект (25.09.2026:
        // обновление концовок дало 30 одинаковых строк за минуту).
        failed.push({ channel: "YOUTUBE", error: YOUTUBE_SCOPE_MISSING_SHORT });
        reportYoutubeScopeMissing();
        scopeReported = true;
      } else failed.push({ channel: "YOUTUBE", error: res.error ?? "неизвестная ошибка" });
    }
  }

  const toLog = failed.filter((f) => !(scopeReported && f.channel === "YOUTUBE"));
  if (toLog.length > 0) {
    void logSystemError(
      "meta",
      `Объект ${propertyId}: обновление подписей — ${toLog.map((f) => `${f.channel}: ${f.error}`).join("; ")}`
    );
  }

  return {
    caption,
    updated,
    failed,
    manual: manualSteps(channels, property.instagramUrl, undefined, await tiktokPostUrl(postIds.TIKTOK), postIds.THREADS_URL),
  };
}

/** Каналы, которые вообще поддаются правке из кода — для подсказки в карточке. */
export const CHANNELS_EDITABLE_FROM_CRM: readonly string[] = EDITABLE_CHANNELS;

type CaptionSource = {
  type: string;
  rooms: number | null;
  areaSqm: number | string | { toString(): string };
  floor: number | null;
  totalFloors: number | null;
  price: number | string | { toString(): string };
  currency: string;
  condition: string;
  address?: string | null;
  documents?: string | null;
  windowCount?: number | null;
  details?: unknown;
  marketType?: string | null;
  /** Стадия новостройки: у неё вместо «Ремонт: новостройка» в подписи стоит фаза
   *  («черновые работы сделаны») — см. packages/shared/src/propertyFinish.ts. */
  stage?: string | null;
  landAreaSotka?: number | string | { toString(): string } | null;
  amenities?: string[] | null;
};

/** Все поля подписи из строки объекта — одна сборка на «Обновить подписи» и на
 *  точечную правку ниже. Раньше кнопка не передавала адрес, документ, окна и
 *  санузел, и строки с ними молча выпадали из текста. */
function captionValuesOf(p: CaptionSource, districtName: string, money: MoneyContext): ReelsCaptionValues {
  return reelsCaptionValuesFromProperty({
    type: p.type,
    rooms: p.rooms,
    areaSqm: p.areaSqm,
    floor: p.floor,
    totalFloors: p.totalFloors,
    price: p.price,
    currency: p.currency,
    condition: p.condition,
    districtName,
    phone: null,
    address: p.address ?? null,
    documents: p.documents ?? null,
    windowCount: p.windowCount ?? null,
    details: p.details,
    marketType: p.marketType ?? null,
    stage: p.stage ?? null,
    landAreaSotka: p.landAreaSotka ?? null,
    amenities: p.amenities ?? null,
    money,
  });
}

/** Поля объекта, которые видны в подписи ролика. Цены здесь нет: её переписывает
 *  lib/publishedListingSync.ts сразу при смене и сам рассылает в посты. */
export const CAPTION_FACT_FIELDS = [
  "type",
  "rooms",
  "areaSqm",
  "floor",
  "totalFloors",
  "condition",
  "districtId",
  "address",
  "documents",
  "windowCount",
  "details",
  "marketType",
  // Стадия новостройки стоит в подписи вместо ремонта (#780, 23.09.2026) —
  // значит её правка так же обязана переписать текст, как и остальные факты.
  "stage",
  "landAreaSotka",
  "amenities",
] as const;

/**
 * ПРАВКА ОБЪЕКТА ПОСЛЕ ПУБЛИКАЦИИ — ПОДПИСЬ В БАЗЕ ПЕРЕПИСЫВАЕТСЯ СРАЗУ,
 * В ПОСТЫ УХОДИТ ПО «ГОТОВО» (владелец 23.09.2026). Одна правка формы — одна
 * запись; агент поправил три поля тремя сохранениями — в соцсети уходит один
 * вызов на кнопку «Готово», а не три.
 *
 * Возвращает, удалось ли найти в подписи блок фактов. false — подпись правили
 * руками: она остаётся как есть, «Готово» скажет, что её надо поправить вручную.
 */
export async function rewriteStoredCaptionAfterEdit(
  before: CaptionSource & { districtId: string | null; reelsCaption: string | null },
  after: CaptionSource & { id: string; districtId: string | null }
): Promise<boolean> {
  if (!before.reelsCaption?.trim()) return true;
  const ids = [before.districtId, after.districtId].filter((x): x is string => !!x);
  const [districts, money, settings] = await Promise.all([
    ids.length ? prisma.district.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [],
    loadMoneyContext(),
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { reelsCaptionTemplates: true } }),
  ]);
  const name = (id: string | null) => districts.find((d) => d.id === id)?.name ?? "";
  const rewritten = rewriteCaptionFacts(
    before.reelsCaption,
    captionValuesOf(before, name(before.districtId), money),
    captionValuesOf(after, name(after.districtId), money),
    settings?.reelsCaptionTemplates
  );
  if (rewritten === null) return false;
  if (rewritten !== before.reelsCaption) {
    await prisma.property.update({ where: { id: after.id }, data: { reelsCaption: rewritten } });
  }
  return true;
}
