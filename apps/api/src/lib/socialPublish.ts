import {
  loadCredentials,
  instagramApiUrl,
  instagramRequest,
  instagramTokenIdentity,
  fetchWithRetry,
  GRAPH_VERSION,
} from "../messengers/meta.js";
import fs from "node:fs/promises";
import { openAsBlob } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { publicUploadUrl } from "./crmPublicUrl.js";
import { uploadsDir } from "../upload.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import { prisma } from "../db.js";
import { isTelegramEnabled, sendVideoFile as sendTelegramVideoFile, TELEGRAM_BOT_SEND_LIMIT_BYTES } from "../telegram/api.js";
import { parseTelegramChatIds } from "./telegramChats.js";
import { decryptSecretSafe, encryptSecret } from "../crypto.js";
import { tryRunFfmpeg, runFfmpeg, probeVideoDimensions, probeImageDimensions, probeMediaInfo, type MediaInfo } from "./ffmpeg.js";
import { propertyOwnerAgentId } from "./propertyOwner.js";
import { readOwnerMarks, updateOwnerMarks, type MarksOwner } from "./publishedMarks.js";
import { instagramCollaboratorsFor } from "./instagramCollaborators.js";

/**
 * Публикация готового поста в Instagram/Facebook — docs/publishing-hub-plan-22-08-2026.md.
 *
 * ГРАНИЦА ОТВЕТСТВЕННОСТИ. Код здесь рабочий и полный, не заглушка — но реальный
 * первый вызов на боевых токенах агентства это делает не инженер, а тот, кто
 * увидит результат: публикация в Instagram/Facebook — публичное, видимое всем
 * действие. Settings.autoPublishEnabled по умолчанию выключен; включает и
 * инициирует первую живую публикацию владелец.
 *
 * ПРОКСИ ДЛЯ INSTAGRAM ОБЯЗАТЕЛЕН (см. messengers/meta.ts::instagramApiUrl) —
 * graph.instagram.com недоступен с VPS напрямую, тот же баг, что уже ловили на
 * личных сообщениях. Facebook (graph.facebook.com) идёт напрямую, как и везде
 * в проекте.
 */

export type PublishChannel = "INSTAGRAM" | "FACEBOOK" | "TELEGRAM" | "YOUTUBE" | "TIKTOK" | "THREADS";

export interface PublishResult {
  channel: PublishChannel;
  /**
   * Ключ адреса «канал + аккаунт» (свободные ролики, 12.10.2026): `INSTAGRAM:<id аккаунта>`. Не задан —
   * публикация в аккаунт по умолчанию, как у роликов объектов (ключ равен имени канала).
   */
  destinationKey?: string;
  ok: boolean;
  postId?: string;
  /** Публичная ссылка на пост — заполнена только для Instagram (нужна для
   *  Property.instagramUrl, тот же формат, что раньше вписывал монтажёр вручную). */
  permalink?: string;
  error?: string;
  /** Публикация формально `ok`, но не то, что попросили — пример: TikTok отклонил
   *  прямую публикацию (см. publishTikTokVideo) и ролик ушёл в черновики
   *  («Входящие») вместо ленты. Показывается там же, где успех/отказ канала. */
  note?: string;
  /** ВТОРОЙ идентификатор того же поста (20.09.2026) — сейчас только у Facebook:
   *  `POST /{page-id}/videos` возвращает id ВИДЕО, но у поста страницы есть ещё
   *  `post_id` (вида 122161721733120295, см. fetchFacebookVideoPostId), и в ленте
   *  всё это выходит как Reels (`permalink_url: /reel/...`). Сохраняем оба — при
   *  удалении сперва пробуем video id, при отказе — post id (см. removeFromSocial
   *  в lib/publishedVideoFix.ts и Property.publishedPostIds.FACEBOOK_POST). */
  secondaryPostId?: string;
  /** НЕ ОТКАЗ (случай №111, 21.09.2026, объект №111 — Instagram не успел
   *  обработать контейнер в отведённое окно, пока на публикацию одновременно
   *  ушли два объекта и история). `ok: false` в этом случае означает только
   *  «ещё не опубликовано ПРЯМО СЕЙЧАС», а не «сломано»: контейнер жив у Meta
   *  и сохранён в PendingInstagramContainer — фоновый проход
   *  lib/instagramPendingContainers.ts::runInstagramPendingContainersTick
   *  довершит публикацию сам, как только Meta закончит обработку. Вызывающий
   *  код (videoHandoff.ts::publishHandoffResult) обязан не путать это с
   *  честным отказом: не писать в failedChannels, не показывать красным. */
  pending?: boolean;
  /**
   * НЕ ОТКАЗ, А «НЕ СЕЙЧАС» (23.09.2026, TikTok ответил
   * `spam_risk_too_many_pending_share` на объекте 22.09 в 19:06). Площадка сама
   * говорит: сейчас нельзя, попробуйте позже — лимит на пачку публикаций, на
   * число неподтверждённых черновиков, на частоту запросов. Всё это проходит
   * само, без единой правки в коде и без человека.
   *
   * Разница с `pending` (Instagram): там пост УЖЕ у площадки и дозреет сам, нам
   * остаётся его дождаться. Здесь площадка не приняла НИЧЕГО, и повторить
   * попытку обязаны мы — отдельным отложенным заданием
   * (jobs/tiktokPublishRetry.ts). Считать это обычным отказом значило бы, что
   * ролик не выйдет в TikTok НИКОГДА: канал просто остаётся ненаписанным в
   * publishedChannels, и повторить его некому.
   */
  retriable?: boolean;
  /**
   * ИСХОД НЕИЗВЕСТЕН (аудит 04.10.2026, PUB02) — ролик уже загружен в TikTok, и тот
   * опубликует его сам, но наш опрос статуса не получил определённого ответа
   * (40 попыток «в обработке», сеть, 5xx) либо упал исключением после принятия
   * файла. Это не отказ и не успех: метку незавершённой загрузки (TIKTOK_PENDING)
   * стирать нельзя, иначе следующая попытка загрузит тот же ролик второй раз.
   */
  outcomeUnknown?: boolean;
}

/** Экспортирован (21.09.2026) — lib/instagramPendingContainers.ts переиспользует
 *  тот же таймаут HTTP-запроса на проверку/публикацию контейнера, вместо второй
 *  зашитой константы. */
export const PUBLISH_TIMEOUT_MS = 60_000;

/**
 * ЛЕСЕНКА ОЖИДАНИЯ КОНТЕЙНЕРА (случай №111, 21.09.2026: 20 попыток по 3 секунды
 * — около минуты — не хватило, когда на Meta одновременно легли два объекта
 * (№111, №112) и история; ролик крошечный (22.3 с, 26.8 МБ) — дело не в весе,
 * а в очереди у Meta). Meta нигде не публикует SLA обработки контейнера reels —
 * официальная документация (Instagram Platform → Content Publishing, раздел
 * Reels, developers.facebook.com/docs/instagram-platform/instagram-graph-api/
 * guides/content-publishing, проверено 21.09.2026) только описывает сам протокол
 * (`status_code`: IN_PROGRESS → FINISHED/ERROR) и рекомендует опрашивать не чаще
 * раза в секунду, конкретных цифр по времени не даёт.
 *
 * Частые проверки в начале (обычный случай — ролик готов за секунды, не тратить
 * их на редкий опрос), затем более редкие: 4×3с + 3×5с + 3×10с + 3×15с + 3×20с +
 * 4×30с = 12+15+30+45+60+120 = 282 секунды (≈4 мин 42 с) суммарного ожидания.
 * Если Meta не успела и за это время — не бросаем контейнер (см. PublishResult.
 * pending выше), отдаём его фоновому проходу, который проверяет реже и без
 * ограничения по числу попыток (только по возрасту контейнера, см.
 * INSTAGRAM_CONTAINER_MAX_AGE_MS в lib/instagramPendingContainers.ts).
 */
const CONTAINER_POLL_INTERVALS_MS = [
  3_000, 3_000, 3_000, 3_000,
  5_000, 5_000, 5_000,
  10_000, 10_000, 10_000,
  15_000, 15_000, 15_000,
  20_000, 20_000, 20_000,
  30_000, 30_000, 30_000, 30_000,
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Экспортированы (21.09.2026) — lib/instagramPendingContainers.ts переиспользует
// оба разбора ответа Graph API вместо второй копии.
export async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function graphErrorMessage(body: Record<string, unknown>, fallback: string): string {
  const error = body.error as { message?: string } | undefined;
  return error?.message ?? fallback;
}

/**
 * СОАВТОРЫ INSTAGRAM (26.09.2026) — отличить отказ ИЗ-ЗА `collaborators` (ник не
 * существует, аккаунт приватный, лимит 3 и т.п.) от любого другого отказа
 * создания контейнера. Meta не даёт отдельного кода на это — единственный
 * надёжный признак, что сообщение об ошибке САМО называет поле. Ложноотрицательный
 * результат (не распознали как ошибку соавторов) не опасен — публикация просто
 * не повторится без них и уйдёт в обычный отказ, как до этой функции.
 */
function isCollaboratorsError(body: Record<string, unknown>): boolean {
  const error = body.error as { message?: string; error_user_msg?: string } | undefined;
  const text = `${error?.message ?? ""} ${error?.error_user_msg ?? ""}`.toLowerCase();
  return text.includes("collaborator");
}

/**
 * Обрезка подписи под лимит Instagram (2200 символов, см. publishApprovedPost)
 * без разрезания слова/хештега пополам — `#ИсмоилиСомони` на границе не должен
 * становиться `#ИсмоилиСом`. Байт в байт как .slice(), пока подпись и так
 * укладывается в лимит (подавляющее большинство постов) — тримминг по границе
 * слова работает только на ХВОСТЕ, который иначе обрезался бы. Если рядом с
 * границей нет пробела в пределах разумного (40 символов), режем как раньше —
 * честная обрезка середины слова лучше, чем потеря заметного куска подписи.
 */
export function truncateCaptionSafely(caption: string, max: number): string {
  if (caption.length <= max) return caption;
  const cut = caption.slice(0, max);
  const lastBreak = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  if (lastBreak > max - 40) return cut.slice(0, lastBreak).trimEnd();
  return cut;
}

/**
 * Общий опрос готовности контейнера Meta (status_code) — вынесено из
 * publishInstagramReel (21.09.2026), чтобы у Историй (publishInstagramStory
 * ниже) не завелась вторая копия ровно того же цикла с теми же таймаутами.
 * Возвращает `{ ok: true }`, когда контейнер готов публиковаться;
 * `{ ok: false, pending: false, error }` — Meta отклонила обработку
 * (status_code: ERROR), это честный отказ; `{ ok: false, pending: true, error }`
 * — время ожидания истекло, но контейнер, вероятно, ещё жив (см. PublishResult.
 * pending и CONTAINER_POLL_INTERVALS_MS выше) — вызывающий код обязан не считать
 * это отказом.
 *
 * Экспортирована (28.09.2026) — lib/photoPosts.ts переиспользует тот же цикл
 * опроса для карусели/одиночного фото вместо второй копии тех же таймаутов.
 */
export async function waitForInstagramContainerReady(
  containerId: string,
  token: string
): Promise<{ ok: true } | { ok: false; pending: boolean; error: string }> {
  for (let attempt = 0; attempt < CONTAINER_POLL_INTERVALS_MS.length; attempt++) {
    const statusReq = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/${containerId}?fields=status_code`), token);
    const statusRes = await fetchWithRetry(statusReq.url, { headers: statusReq.headers }, PUBLISH_TIMEOUT_MS);
    const statusBody = await readJson(statusRes);
    const statusCode = statusBody.status_code as string | undefined;
    if (statusCode === "FINISHED") return { ok: true };
    if (statusCode === "ERROR") {
      return { ok: false, pending: false, error: "Meta не смогла обработать видео (status_code: ERROR)" };
    }
    // ПУЛЬС ЖИВОГО ХОЗЯИНА (22.09.2026) — контейнер теперь запоминается ДО этого
    // цикла, а значит его видит и фоновый проход. Отметка «я ещё жив и жду сам»
    // не даёт тому проходу забрать контейнер и опубликовать его ВТОРЫМ, пока
    // здесь идёт своё ожидание; умер процесс — пульс перестаёт обновляться, и
    // контейнер становится свободным через INSTAGRAM_CONTAINER_OWNER_STALE_MS
    // (lib/instagramPendingContainers.ts).
    await touchInstagramContainerHeartbeat(containerId);
    await sleep(CONTAINER_POLL_INTERVALS_MS[attempt]);
  }
  return { ok: false, pending: true, error: "Видео не обработалось за отведённое время ожидания" };
}

/** Отметка «живой процесс всё ещё ждёт этот контейнер» — тем же полем
 *  `lastCheckedAt`, которым фоновый проход отмечает свою проверку: смысл у него
 *  ровно один, «кто-то смотрел на контейнер вот тогда-то». Отдельной колонки под
 *  владельца не заводим: миграции на этом сервере руками (`ops/deploy.sh` их не
 *  накатывает), а `updateMany` по уникальному `containerId` не падает, даже если
 *  запись создать не удалось. Тихо: пульс — не работа, о нём нечего сообщать. */
async function touchInstagramContainerHeartbeat(containerId: string): Promise<void> {
  try {
    await prisma.pendingInstagramContainer.updateMany({
      where: { containerId, status: "PENDING" },
      data: { lastCheckedAt: new Date() },
    });
  } catch {
    // БД моргнула — публикацию это не отменяет, а следующий пульс попробует снова.
  }
}

/** Контейнер доведён живым процессом (опубликован или честно отклонён Meta) —
 *  закрываем запись, чтобы фоновый проход не взялся за него второй раз.
 *  `updateMany`, а не `update`: записи может не быть вовсе (её создание —
 *  best-effort, см. rememberInstagramContainer). */
async function resolveInstagramContainer(
  containerId: string,
  status: "PUBLISHED" | "REJECTED",
  error?: string
): Promise<void> {
  try {
    await prisma.pendingInstagramContainer.updateMany({
      where: { containerId, status: "PENDING" },
      data: { status, resolvedAt: new Date(), ...(error ? { error } : {}) },
    });
  } catch (err) {
    // Худшее последствие — фоновый проход увидит «висящий» PENDING и проверит его
    // сам: у опубликованного контейнера Meta вернёт отказ на повторную публикацию,
    // дубля поста не будет. Поэтому это строка в журнал, а не отказ публикации.
    void logSystemError(
      "meta",
      `Instagram: не удалось закрыть запись контейнера ${containerId} (${status}) — ${describeError(err)}`
    );
  }
}

/**
 * Контейнер создан у Meta — запоминаем его СРАЗУ, ещё до окна ожидания
 * (22.09.2026; до этого запись делалась только если окно истекло — см. ниже).
 * Подхватывает lib/instagramPendingContainers.ts::runInstagramPendingContainersTick,
 * зарегистрированный в общем крон-файле (cron.ts), а не отдельным самодельным
 * планировщиком.
 *
 * ПОЧЕМУ ДО ОКНА, А НЕ ПОСЛЕ (класс «страховка ставится после окна, которое
 * должна страховать»). Ожидание длится до ~4 мин 42 с лесенкой опроса, а с
 * учётом таймаутов самих запросов и дольше. Рестарт контейнера api/worker внутри
 * этого окна (автовыкат идёт по каждому мержу в main, их бывает двадцать в день)
 * убивал публикацию МОЛЧА: ролик у Meta уже загружен и обработан, `creation_id`
 * знал только умерший процесс, и контейнер тихо сгнивал за 24 часа — ни поста,
 * ни строки в журнале. Запись до окна делает эту потерю невозможной: живой
 * процесс по-прежнему доводит публикацию сам и закрывает запись
 * (resolveInstagramContainer), а если он умер — контейнер доведёт фоновый проход.
 *
 * Запись в журнал НАМЕРЕННО не начинается со слов «Публикация в» —
 * routes/properties/list.ts::loadPublishErrorsByChannel ищет именно этот
 * префикс, чтобы показать канал красным в карточке объекта (ОБ-000113); текст
 * ожидания обязан не совпасть с этим фильтром, иначе «ещё обрабатывается»
 * выглядело бы как «сломано».
 *
 * Если СОХРАНИТЬ запись не удалось (БД недоступна и т.п.) — это уже настоящий
 * отказ: контейнер, если не запомнить его id, потерян навсегда, ровно то, что
 * случилось 21.09.2026 на объекте №111 до этой правки.
 */
async function rememberInstagramContainer(
  propertyId: string,
  containerId: string,
  kind: "REEL" | "STORY",
  storyMeta?: { storyKind: string; partIndex: number }
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await prisma.pendingInstagramContainer.create({
      data: {
        propertyId,
        containerId,
        kind,
        storyKind: storyMeta?.storyKind ?? null,
        partIndex: storyMeta?.partIndex ?? null,
      },
    });
  } catch (err) {
    const error = `Публикация в Instagram (объект ${propertyId}) не удалась: контейнер обрабатывается у Meta, но не удалось сохранить его на дозавершение — ${describeError(err)}`;
    return { ok: false, error };
  }
  return { ok: true };
}

/**
 * Контейнер не успел за окно ожидания живого процесса — он уже записан
 * (rememberInstagramContainer выше), остаётся честно сказать это в журнал.
 * Запись НАМЕРЕННО не начинается со слов «Публикация в» —
 * routes/properties/list.ts::loadPublishErrorsByChannel ищет именно этот
 * префикс, чтобы показать канал красным в карточке объекта (ОБ-000113); текст
 * ожидания обязан не совпасть с этим фильтром, иначе «ещё обрабатывается»
 * выглядело бы как «сломано».
 *
 * `remembered` — удалось ли вообще запомнить контейнер. Не удалось И окно
 * истекло — вот это уже настоящий отказ: id знает только этот процесс, и через
 * секунду его не будет знать никто (ровно то, что случилось 21.09.2026 на
 * объекте №111).
 */
function reportPendingInstagramContainer(
  propertyId: string,
  remembered: { ok: true } | { ok: false; error: string }
): { ok: true } | { ok: false; error: string } {
  if (!remembered.ok) {
    void logSystemError("meta", remembered.error);
    return remembered;
  }
  void logSystemError(
    "meta",
    `Instagram (объект ${propertyId}): контейнер ещё обрабатывается у Meta — опубликуем автоматически, как только будет готово.`
  );
  return { ok: true };
}

/**
 * videoUrl обязан быть публично доступным HTTPS-адресом — Graph API сама
 * скачивает видео по нему асинхронно, файл в теле запроса не передаётся.
 * Двухшаговый протокол Reels: создать контейнер → дождаться обработки →
 * опубликовать (`creation_id`).
 *
 * `propertyId` (21.09.2026, случай №111) — только для того, чтобы сохранить
 * контейнер на дозавершение, если Meta не успела за окно ожидания; сама
 * функция по-прежнему ничего не знает про схему Property.
 *
 * `collaborators` (26.09.2026, до 3 ников без `@`, см. lib/instagramCollaborators.ts)
 * — необязательный параметр; пустой/не переданный массив оставляет тело запроса
 * байт в байт таким же, как до этой функции. Если Meta отклонит именно из-за
 * соавтора (ник не существует, аккаунт приватный и т.п.), контейнер создаётся
 * ПОВТОРНО без них — публикация не должна падать из-за необязательного поля,
 * см. isCollaboratorsError.
 */
export async function publishInstagramReel(
  propertyId: string,
  igUserId: string,
  token: string,
  videoUrl: string,
  caption: string,
  coverUrl?: string | null,
  collaborators?: string[],
  /**
   * `ownerText` - как назвать хозяина публикации в журнале (по умолчанию «объект <id>»).
   * `persistPendingContainer: false` - свободный ролик (12.10.2026): таблица ожидающих
   * контейнеров привязана к объекту, доводить такой контейнер фоновому проходу не к чему,
   * поэтому не успевший за окно ожидания Instagram - честный отказ с просьбой повторить.
   */
  opts?: { ownerText?: string; persistPendingContainer?: boolean }
): Promise<PublishResult> {
  try {
    const createReq = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/${igUserId}/media`), token);
    const baseCreateBody = {
      media_type: "REELS" as const,
      video_url: videoUrl,
      caption,
      ...(coverUrl ? { cover_url: coverUrl } : {}),
    };
    let collaboratorsNote: string | undefined;
    let createRes = await fetchWithRetry(
      createReq.url,
      {
        method: "POST",
        headers: { ...createReq.headers, "Content-Type": "application/json" },
        // cover_url приоритетнее thumb_offset (который мы и не задаём) — сгенерированная
        // обложка (lib/video/coverPoster.ts) вместо кадра, который Instagram выберет сам.
        body: JSON.stringify(
          collaborators && collaborators.length > 0 ? { ...baseCreateBody, collaborators } : baseCreateBody
        ),
      },
      PUBLISH_TIMEOUT_MS
    );
    let createBody = await readJson(createRes);
    if (!createRes.ok && collaborators && collaborators.length > 0 && isCollaboratorsError(createBody)) {
      const collaboratorsError = graphErrorMessage(createBody, `HTTP ${createRes.status}`);
      void logSystemError(
        "meta",
        `Instagram (${opts?.ownerText ?? `объект ${propertyId}`}): соавторы отклонены (${collaboratorsError}) — публикуем без них.`
      );
      collaboratorsNote = `соавторы не приняты: ${collaboratorsError}`;
      createRes = await fetchWithRetry(
        createReq.url,
        {
          method: "POST",
          headers: { ...createReq.headers, "Content-Type": "application/json" },
          body: JSON.stringify(baseCreateBody),
        },
        PUBLISH_TIMEOUT_MS
      );
      createBody = await readJson(createRes);
    }
    const containerId = createBody.id as string | undefined;
    if (!createRes.ok || !containerId) {
      return { channel: "INSTAGRAM", ok: false, error: graphErrorMessage(createBody, `HTTP ${createRes.status}`) };
    }

    // Запоминаем контейнер ДО окна ожидания — см. rememberInstagramContainer.
    const remembered: { ok: true } | { ok: false; error: string } =
      opts?.persistPendingContainer === false
        ? {
            ok: false,
            error: "Instagram не успел обработать видео за отведённое время (около 5 минут) — нажмите «Повторить» чуть позже",
          }
        : await rememberInstagramContainer(propertyId, containerId, "REEL");

    const ready = await waitForInstagramContainerReady(containerId, token);
    if (!ready.ok) {
      if (ready.pending) {
        const reported = reportPendingInstagramContainer(propertyId, remembered);
        if (reported.ok)
          return {
            channel: "INSTAGRAM",
            ok: false,
            pending: true,
            error: ready.error,
            ...(collaboratorsNote ? { note: collaboratorsNote } : {}),
          };
        return { channel: "INSTAGRAM", ok: false, error: reported.error };
      }
      // Meta честно отказалась обрабатывать — доводить нечего, закрываем запись,
      // чтобы фоновый проход не ходил к отклонённому контейнеру до истечения суток.
      await resolveInstagramContainer(containerId, "REJECTED", ready.error);
      return { channel: "INSTAGRAM", ok: false, error: ready.error };
    }

    const publishReq = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/${igUserId}/media_publish`), token);
    const publishRes = await fetchWithRetry(
      publishReq.url,
      {
        method: "POST",
        headers: { ...publishReq.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ creation_id: containerId }),
      },
      PUBLISH_TIMEOUT_MS
    );
    const publishBody = await readJson(publishRes);
    const postId = publishBody.id as string | undefined;
    if (!publishRes.ok || !postId) {
      // Запись НАМЕРЕННО остаётся PENDING: контейнер обработан и, скорее всего,
      // ещё публикуем — пусть фоновый проход доведёт его сам.
      return { channel: "INSTAGRAM", ok: false, error: graphErrorMessage(publishBody, `HTTP ${publishRes.status}`) };
    }
    await resolveInstagramContainer(containerId, "PUBLISHED");
    return { channel: "INSTAGRAM", ok: true, postId, ...(collaboratorsNote ? { note: collaboratorsNote } : {}) };
  } catch (err) {
    return { channel: "INSTAGRAM", ok: false, error: describeError(err) };
  }
}

/**
 * ИСТОРИИ INSTAGRAM (21.09.2026, владелец: «сделай нам истории, чтобы были») —
 * тот же двухшаговый протокол контейнера, что и Reels, но `media_type=STORIES`
 * и без caption/cover_url: Meta не даёт добавить в историю через API ни текст,
 * ни ссылку, ни стикер — это ограничение самой платформы, не наше упрощение.
 * Всё, что должно быть на экране, уже впечатано в само видео либо в саму
 * картинку (см. `publishInstagramStoryImage` ниже, 21.09.2026 — Meta принимает
 * в историю `image_url` наравне с `video_url`, тот же контейнер и тот же
 * протокол ожидания, отличается только имя поля в теле запроса).
 *
 * Публикует РОВНО ОДНУ часть — оркестрация нарезки ролика длиннее 60 секунд на
 * несколько последовательных историй и запись PropertyStoryPost живут в
 * lib/instagramStories.ts (эта функция ничего не знает про Property, ровно как
 * publishInstagramReel). `storyMeta` (случай №111) — тот же довод, что у
 * `propertyId` в publishInstagramReel: только чтобы дозавершение фоновым
 * проходом создало PropertyStoryPost с тем же kind/partIndex, что создал бы
 * обычный успешный путь.
 */
async function publishInstagramStoryMedia(
  propertyId: string,
  igUserId: string,
  token: string,
  mediaUrl: string,
  mediaField: "video_url" | "image_url",
  storyMeta: { storyKind: string; partIndex: number }
): Promise<PublishResult> {
  try {
    const createReq = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/${igUserId}/media`), token);
    const createRes = await fetchWithRetry(
      createReq.url,
      {
        method: "POST",
        headers: { ...createReq.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ media_type: "STORIES", [mediaField]: mediaUrl }),
      },
      PUBLISH_TIMEOUT_MS
    );
    const createBody = await readJson(createRes);
    const containerId = createBody.id as string | undefined;
    if (!createRes.ok || !containerId) {
      return { channel: "INSTAGRAM", ok: false, error: graphErrorMessage(createBody, `HTTP ${createRes.status}`) };
    }

    // Запоминаем контейнер ДО окна ожидания — см. rememberInstagramContainer.
    const remembered = await rememberInstagramContainer(propertyId, containerId, "STORY", storyMeta);

    const ready = await waitForInstagramContainerReady(containerId, token);
    if (!ready.ok) {
      if (ready.pending) {
        const reported = reportPendingInstagramContainer(propertyId, remembered);
        if (reported.ok) return { channel: "INSTAGRAM", ok: false, pending: true, error: ready.error };
        return { channel: "INSTAGRAM", ok: false, error: reported.error };
      }
      // Meta честно отказалась обрабатывать — доводить нечего, закрываем запись,
      // чтобы фоновый проход не ходил к отклонённому контейнеру до истечения суток.
      await resolveInstagramContainer(containerId, "REJECTED", ready.error);
      return { channel: "INSTAGRAM", ok: false, error: ready.error };
    }

    const publishReq = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/${igUserId}/media_publish`), token);
    const publishRes = await fetchWithRetry(
      publishReq.url,
      {
        method: "POST",
        headers: { ...publishReq.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ creation_id: containerId }),
      },
      PUBLISH_TIMEOUT_MS
    );
    const publishBody = await readJson(publishRes);
    const postId = publishBody.id as string | undefined;
    if (!publishRes.ok || !postId) {
      // Запись НАМЕРЕННО остаётся PENDING: контейнер обработан и, скорее всего,
      // ещё публикуем — пусть фоновый проход доведёт его сам.
      return { channel: "INSTAGRAM", ok: false, error: graphErrorMessage(publishBody, `HTTP ${publishRes.status}`) };
    }
    await resolveInstagramContainer(containerId, "PUBLISHED");
    return { channel: "INSTAGRAM", ok: true, postId };
  } catch (err) {
    return { channel: "INSTAGRAM", ok: false, error: describeError(err) };
  }
}

export async function publishInstagramStory(
  propertyId: string,
  igUserId: string,
  token: string,
  videoUrl: string,
  partIndex: number = 0
): Promise<PublishResult> {
  return publishInstagramStoryMedia(propertyId, igUserId, token, videoUrl, "video_url", { storyKind: "VIDEO", partIndex });
}

/**
 * История КАРТИНКОЙ (21.09.2026, инфраструктура под «цена снижена» и любые
 * будущие статичные истории — lib/video/storyCard.ts рисует 1080x1920 JPEG).
 * `imageUrl` — тот же контракт, что и у `videoUrl` в `publishInstagramStory`:
 * публично доступный HTTPS-адрес, Meta скачивает файл сама.
 *
 * `storyKind` (баг найден 28.09.2026 при разборе задания на истории Facebook):
 * раньше здесь было зашито `"PRICE_DROP"` для ЛЮБОЙ картинки — история «продано»
 * (SOLD) или карточка объекта (CARD), не успевшая обработаться контейнером Meta
 * в отведённое окно, дозавершалась бы фоновым проходом
 * (lib/instagramPendingContainers.ts) и записала бы себя в PropertyStoryPost
 * как PRICE_DROP. По умолчанию оставлен "PRICE_DROP" — единственный вызывающий
 * код ДО этой правки (publishPropertyPriceDropStory) новый параметр не передаёт.
 */
export async function publishInstagramStoryImage(
  propertyId: string,
  igUserId: string,
  token: string,
  imageUrl: string,
  storyKind: string = "PRICE_DROP"
): Promise<PublishResult> {
  return publishInstagramStoryMedia(propertyId, igUserId, token, imageUrl, "image_url", { storyKind, partIndex: 0 });
}

/**
 * Остаток дневного лимита публикаций Meta (21.09.2026) — документация Meta сама
 * себе противоречит по числам (в разных местах фигурируют и 50, и 100 постов за
 * 24 часа), поэтому вместо зашитой константы спрашиваем сам Graph API перед
 * серией историй. `quota_usage` — сколько уже опубликовано в окне, `quota_total`
 * — потолок этого окна; `remaining` — их разница, не меньше нуля.
 */
export async function checkInstagramPublishingQuota(
  igUserId: string,
  token: string
): Promise<{ ok: true; remaining: number; used: number; total: number } | { ok: false; error: string }> {
  try {
    const req = instagramRequest(
      instagramApiUrl(`/${GRAPH_VERSION}/${igUserId}/content_publishing_limit?fields=config,quota_usage`),
      token
    );
    const res = await fetchWithRetry(req.url, { headers: req.headers }, PUBLISH_TIMEOUT_MS);
    const body = await readJson(res);
    if (!res.ok) return { ok: false, error: graphErrorMessage(body, `HTTP ${res.status}`) };
    const data = (body.data as Array<{ quota_usage?: number; config?: { quota_total?: number } }> | undefined)?.[0];
    const used = data?.quota_usage;
    const total = data?.config?.quota_total;
    if (typeof used !== "number" || typeof total !== "number") {
      return { ok: false, error: "Meta не вернула понятный ответ по лимиту публикаций" };
    }
    return { ok: true, remaining: Math.max(0, total - used), used, total };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/**
 * Прежняя форма ответа (только остаток) — для историй Instagram. Полные цифры (сколько
 * использовано и потолок окна) нужны экрану свободных роликов — их отдаёт
 * `checkInstagramPublishingQuota` выше; здесь тот же запрос, не вторая копия.
 */
export async function checkInstagramPublishingLimit(
  igUserId: string,
  token: string
): Promise<{ ok: true; remaining: number } | { ok: false; error: string }> {
  const quota = await checkInstagramPublishingQuota(igUserId, token);
  return quota.ok ? { ok: true, remaining: quota.remaining } : quota;
}

/**
 * Отметки для страховки от второго поста на странице (см. FACEBOOK_PENDING_KEY).
 * Сама публикация в БД не ходит — метку ставит и снимает вызывающий.
 */
export interface FacebookPublishHooks {
  /** Перед отправкой: «попытка началась, исход неизвестен». */
  onAttemptStarted?: () => Promise<void>;
  /** Ответ получен (успех или отказ) — исход определён, метку снять. */
  onAnswered?: () => Promise<void>;
}

/** Facebook Page video — один вызов, без промежуточного контейнера (в отличие
 *  от Instagram Reels). Идёт напрямую в graph.facebook.com — тот хост с VPS
 *  доступен (см. messengers/meta.ts), проксирования не требует. */
export async function publishFacebookVideo(
  pageId: string,
  token: string,
  videoUrl: string,
  caption: string,
  hooks?: FacebookPublishHooks
): Promise<PublishResult> {
  try {
    // Метка «попытка началась» — ДО отправки, см. FACEBOOK_PENDING_KEY.
    await hooks?.onAttemptStarted?.();
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/videos`;
    // БЕЗ fetchWithRetry (26.08.2026): POST /videos не идемпотентен, а таймаут не
    // означает «не дошло» — Meta может принять запрос и доварить его после нашего
    // обрыва. Ретрай на таймауте давал бы до нескольких КОПИЙ одного видео на
    // публичной странице. Одна попытка с честным таймаутом; отказ виден модератору.
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_url: videoUrl, description: caption, access_token: token }),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    const body = await readJson(res);
    const postId = body.id as string | undefined;
    // Ответ пришёл — исход определён, чем бы он ни был: метка больше не нужна
    // ни в успехе, ни в отказе (неизвестность оставляет только обрыв).
    await hooks?.onAnswered?.();
    if (!res.ok || !postId) {
      return { channel: "FACEBOOK", ok: false, error: graphErrorMessage(body, `HTTP ${res.status}`) };
    }
    // post_id — ВТОРОЙ идентификатор того же поста (см. PublishResult.secondaryPostId
    // выше), нужен как запасной адрес для удаления (случай №112, publishedVideoFix.ts).
    // Необязательный шаг: Meta не всегда успевает связать video id с post id сразу
    // после публикации — отказ здесь не должен ронять уже состоявшуюся публикацию.
    const secondaryPostId = await fetchFacebookVideoPostId(postId, token);
    return { channel: "FACEBOOK", ok: true, postId, ...(secondaryPostId ? { secondaryPostId } : {}) };
  } catch (err) {
    return { channel: "FACEBOOK", ok: false, error: describeError(err) };
  }
}

/**
 * ИСТОРИИ FACEBOOK (28.09.2026, Page Stories API у Meta с 11.2023) — то же
 * самое медиа, что уже уходит в истории Instagram (lib/instagramStories.ts),
 * ЕЩЁ и на Страницу. Эта функция ничего не знает про Property и
 * PropertyStoryPost — ровно та же граница, что у publishInstagramStory выше:
 * оркестрация (кулдаун по каналу, запись в журнал) живёт в instagramStories.ts.
 *
 * ДВА ШАГА (картинка): `POST /{page-id}/photos {url, published:false}` грузит
 * фото НЕОПУБЛИКОВАННЫМ (в ленте не появляется), затем
 * `POST /{page-id}/photo_stories {photo_id}` превращает его в историю.
 * fetchWithRetry безопасен здесь так же, как у контейнера Instagram выше:
 * неопубликованное фото-сирота от повторной попытки не видно никому.
 */
export async function publishFacebookStoryImage(pageId: string, token: string, imageUrl: string): Promise<PublishResult> {
  try {
    const photoRes = await fetchWithRetry(
      `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/photos`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: imageUrl, published: false, access_token: token }),
      },
      PUBLISH_TIMEOUT_MS
    );
    const photoBody = await readJson(photoRes);
    const photoId = photoBody.id as string | undefined;
    if (!photoRes.ok || !photoId) {
      return { channel: "FACEBOOK", ok: false, error: graphErrorMessage(photoBody, `HTTP ${photoRes.status}`) };
    }

    const storyRes = await fetchWithRetry(
      `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/photo_stories`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo_id: photoId, access_token: token }),
      },
      PUBLISH_TIMEOUT_MS
    );
    const storyBody = await readJson(storyRes);
    const postId = storyBody.post_id as string | undefined;
    if (!storyRes.ok || storyBody.success !== true || !postId) {
      return { channel: "FACEBOOK", ok: false, error: graphErrorMessage(storyBody, `HTTP ${storyRes.status}`) };
    }
    return { channel: "FACEBOOK", ok: true, postId };
  } catch (err) {
    return { channel: "FACEBOOK", ok: false, error: describeError(err) };
  }
}

/**
 * Опрос готовности видео Страницы для истории (`GET /{video-id}?fields=status`,
 * поле `status.video_status`) — тот же ритм ожидания, что у контейнера
 * Instagram (CONTAINER_POLL_INTERVALS_MS выше), чтобы не заводить вторую
 * лесенку таймаутов с другими цифрами без причины. `ready`/`processed` —
 * видео обработано и finish можно звать; `error` — Meta отказалась обрабатывать;
 * не дождались ни того, ни другого — вызывающий код решает сам (см.
 * publishFacebookStoryVideo: не дождались = не отказ, video_stories finish
 * зовём всё равно, с пометкой в PublishResult.note).
 */
async function waitForFacebookStoryVideoReady(
  videoId: string,
  token: string
): Promise<"ready" | "error" | "timeout"> {
  for (let attempt = 0; attempt < CONTAINER_POLL_INTERVALS_MS.length; attempt++) {
    const res = await fetchWithRetry(
      `https://graph.facebook.com/${GRAPH_VERSION}/${videoId}?fields=status&access_token=${encodeURIComponent(token)}`,
      {},
      PUBLISH_TIMEOUT_MS
    );
    const body = await readJson(res);
    const status = body.status as { video_status?: string } | undefined;
    const videoStatus = status?.video_status;
    if (videoStatus === "ready" || videoStatus === "processed" || videoStatus === "published") return "ready";
    if (videoStatus === "error") return "error";
    await sleep(CONTAINER_POLL_INTERVALS_MS[attempt]);
  }
  return "timeout";
}

/**
 * ТРИ ШАГА (видео): `POST /{page-id}/video_stories {upload_phase:"start"}` →
 * `{video_id, upload_url}`; затем сами байты видео уходят НЕ в Graph API, а
 * на `upload_url`, который вернула Meta (обычно rupload.facebook.com) —
 * заголовок `Authorization: OAuth {token}`, ссылка на файл в `file_url` (тело
 * пустое, Meta САМА скачивает ролик по ссылке, тот же приём, что и video_url
 * у Reels/Историй Instagram); затем
 * `POST /{page-id}/video_stories {upload_phase:"finish", video_id}` →
 * `{success, post_id}` — этот шаг и публикует историю.
 *
 * НЕ ДОЖДАЛИСЬ status.video_status (обработка Meta может занять минуты у
 * длинного ролика) — это НЕ отказ (тот же принцип, что у pending контейнера
 * Instagram): finish зовём всё равно, Meta сама решит, готово видео или нет;
 * если finish не прошёл — вот это уже честный отказ. Дождались явного отказа
 * (`video_status: error`) — не тратим вызов finish, честный отказ сразу.
 */
export async function publishFacebookStoryVideo(pageId: string, token: string, videoUrl: string): Promise<PublishResult> {
  try {
    const startRes = await fetchWithRetry(
      `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/video_stories`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upload_phase: "start", access_token: token }),
      },
      PUBLISH_TIMEOUT_MS
    );
    const startBody = await readJson(startRes);
    const videoId = startBody.video_id as string | undefined;
    const uploadUrl = startBody.upload_url as string | undefined;
    if (!startRes.ok || !videoId || !uploadUrl) {
      return { channel: "FACEBOOK", ok: false, error: graphErrorMessage(startBody, `HTTP ${startRes.status}`) };
    }

    const uploadRes = await fetchWithRetry(
      uploadUrl,
      {
        method: "POST",
        headers: { Authorization: `OAuth ${token}`, file_url: videoUrl },
      },
      PUBLISH_TIMEOUT_MS
    );
    if (!uploadRes.ok) {
      const uploadBody = await readJson(uploadRes);
      return { channel: "FACEBOOK", ok: false, error: graphErrorMessage(uploadBody, `HTTP ${uploadRes.status}: загрузка видео не удалась`) };
    }

    const readiness = await waitForFacebookStoryVideoReady(videoId, token);
    if (readiness === "error") {
      return { channel: "FACEBOOK", ok: false, error: "Meta не смогла обработать видео истории (video_status: error)" };
    }

    const finishRes = await fetchWithRetry(
      `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/video_stories`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upload_phase: "finish", video_id: videoId, access_token: token }),
      },
      PUBLISH_TIMEOUT_MS
    );
    const finishBody = await readJson(finishRes);
    const postId = finishBody.post_id as string | undefined;
    if (!finishRes.ok || finishBody.success !== true || !postId) {
      return { channel: "FACEBOOK", ok: false, error: graphErrorMessage(finishBody, `HTTP ${finishRes.status}`) };
    }
    return {
      channel: "FACEBOOK",
      ok: true,
      postId,
      ...(readiness === "timeout"
        ? { note: "Meta не подтвердила обработку видео вовремя — публикация запрошена в любом случае" }
        : {}),
    };
  } catch (err) {
    return { channel: "FACEBOOK", ok: false, error: describeError(err) };
  }
}

/** post_id страницы для уже опубликованного видео (`GET /{video-id}?fields=post_id`,
 *  проверено 20.09.2026) — см. PublishResult.secondaryPostId. null — Meta ещё не
 *  связала объекты или запрос не удался; это не повод ронять публикацию, вызывающий
 *  код просто не получит запасной идентификатор для удаления. */
async function fetchFacebookVideoPostId(videoId: string, token: string): Promise<string | null> {
  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${videoId}?fields=post_id&access_token=${encodeURIComponent(token)}`;
    const res = await fetchWithRetry(url, {}, PUBLISH_TIMEOUT_MS);
    const body = await readJson(res);
    return (body.post_id as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Выбор формата публикации в Facebook (26.09.2026, решение владельца — Reels
 * добавлен ПОВЕРХ видеопоста, publishFacebookVideo не трогаем). Чистая функция
 * от результата probeMediaInfo(localVideoPath): вертикаль 9:16 ± 5%
 * (0.535…0.59 отношение ширины к высоте — экранные width/height из
 * probeMediaInfo, уже развёрнутые по rotation; вертикаль 1080×1920 даёт
 * 1080/1920=0.5625, ровно 9/16), 3-90 с, минимум 540×960 — это требования
 * Reels Publishing API (docs Meta, проверено 26.09.2026). Задание описывало
 * отношение как «height/width», но с width/height как экранными размерами
 * из probeMediaInfo (ширина — короткая сторона вертикального ролика) верна
 * обратная запись — width/height; проверено на примере из задания (1080×1920
 * должно попасть в REEL, 3840×2160 — в VIDEO). Всё остальное (горизонталь
 * вроде 3840×2160, слишком длинное/короткое, замер не удался) — как раньше,
 * обычным видеопостом: ничего не ломаем, если не уверены, что ролик подходит
 * под Reels.
 */
export function facebookFormatFor(info: MediaInfo | null): "REEL" | "VIDEO" {
  if (!info || info.width === null || info.height === null) return "VIDEO";
  const ratio = info.width / info.height;
  const isVertical = ratio >= 0.535 && ratio <= 0.59;
  const isDurationOk = info.durationSec >= 3 && info.durationSec <= 90;
  const isSizeOk = info.height >= 960 && info.width >= 540;
  return isVertical && isDurationOk && isSizeOk ? "REEL" : "VIDEO";
}

/**
 * Готовность ролика Reels на стороне Meta (`GET /{video-id}?fields=status`,
 * поле `status.video_status`) — тот же опрос по смыслу, что
 * waitForInstagramContainerReady у Instagram, но другое поле и другой набор
 * конечных состояний: `ready`/`upload_complete` — можно продолжать (спросить
 * post_id), `error`/`expired` — честный отказ, остальное
 * (`uploading`/`processing`) — ждать дальше по той же лесенке
 * CONTAINER_POLL_INTERVALS_MS. Не дождались за отведённое время — не отказ
 * (см. PublishResult.note у publishFacebookReel ниже): шаг `finish` уже
 * ответил успехом, ролик принят Facebook и просто обрабатывается дольше
 * нашего окна ожидания.
 */
async function waitForFacebookReelReady(
  videoId: string,
  token: string
): Promise<{ ready: true } | { ready: false; failed: boolean; error: string }> {
  for (let attempt = 0; attempt < CONTAINER_POLL_INTERVALS_MS.length; attempt++) {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${videoId}?fields=status&access_token=${encodeURIComponent(token)}`;
    const res = await fetchWithRetry(url, {}, PUBLISH_TIMEOUT_MS);
    const body = await readJson(res);
    const status = body.status as { video_status?: string } | undefined;
    const videoStatus = status?.video_status;
    if (videoStatus === "ready" || videoStatus === "upload_complete") return { ready: true };
    if (videoStatus === "error" || videoStatus === "expired") {
      return { ready: false, failed: true, error: `Facebook не смог обработать Reels (video_status: ${videoStatus})` };
    }
    await sleep(CONTAINER_POLL_INTERVALS_MS[attempt]);
  }
  return { ready: false, failed: false, error: "Reels не обработался за отведённое время ожидания" };
}

/**
 * Facebook Reels — добавлено ПОВЕРХ видеопоста (publishFacebookVideo выше,
 * не тронут), решение владельца 26.09.2026: Reels попадает в отдельную ленту,
 * охват которой не зависит от подписчиков Страницы, а обычный видеопост видят
 * только они. Три шага Reels Publishing API (docs Meta, проверено
 * 26.09.2026), все на graph.facebook.com/rupload.facebook.com — тот же прямой
 * доступ с VPS, что и у /videos, без прокси:
 *  1. `POST /{page-id}/video_reels` upload_phase=start → video_id + upload_url.
 *  2. `POST {upload_url}` (rupload.facebook.com) — заголовки Authorization:
 *     OAuth {token} и file_url: {videoUrl}, тело пустое.
 *  3. `POST /{page-id}/video_reels` upload_phase=finish, video_state=PUBLISHED
 *     → success. Затем опрос готовности (waitForFacebookReelReady).
 * Контракт результата и хуков — тот же, что у publishFacebookVideo: caption
 * ставит FACEBOOK_PENDING до первого шага (вызывающий код), onAnswered снимает
 * её, как только исход попытки известен — после ответа шага 3 или после
 * первого отказа (шаги 1-3 не идемпотентны, та же причина, что у /videos:
 * 26.08.2026 — ретрай на таймауте дал бы копии на живой Странице).
 * `fetchFacebookVideoPostId`, `updateFacebookVideoDescription`, удаление
 * (lib/publishedVideoFix.ts) и аудит (lib/publishedChannelsAudit.ts) продолжают
 * работать без правок — video_id Reels живёт в том же пространстве id, что и
 * video_id обычного видеопоста (проверено чтением докстрингов этих функций,
 * не предположено).
 */
export async function publishFacebookReel(
  pageId: string,
  token: string,
  videoUrl: string,
  caption: string,
  hooks?: FacebookPublishHooks
): Promise<PublishResult> {
  try {
    await hooks?.onAttemptStarted?.();

    // Шаг 1 — БЕЗ fetchWithRetry (не идемпотентен, та же причина, что у
    // /videos в publishFacebookVideo).
    const startRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/video_reels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ upload_phase: "start", access_token: token }),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    const startBody = await readJson(startRes);
    const videoId = startBody.video_id as string | undefined;
    const uploadUrl = startBody.upload_url as string | undefined;
    if (!startRes.ok || !videoId || !uploadUrl) {
      await hooks?.onAnswered?.();
      return { channel: "FACEBOOK", ok: false, error: graphErrorMessage(startBody, `HTTP ${startRes.status}`) };
    }

    // Шаг 2 — тоже одной попыткой, та же не-идемпотентность.
    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: `OAuth ${token}`, file_url: videoUrl },
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    if (!uploadRes.ok) {
      await hooks?.onAnswered?.();
      const uploadBody = await readJson(uploadRes);
      return {
        channel: "FACEBOOK",
        ok: false,
        error: graphErrorMessage(uploadBody, `HTTP ${uploadRes.status}: не удалось загрузить ролик Reels`),
      };
    }

    // Шаг 3 — публикуем контейнер.
    const finishRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/video_reels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        upload_phase: "finish",
        video_id: videoId,
        video_state: "PUBLISHED",
        description: caption,
        access_token: token,
      }),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    const finishBody = await readJson(finishRes);
    // Ответ шага 3 получен — исход попытки определён, чем бы он ни был.
    await hooks?.onAnswered?.();
    if (!finishRes.ok || finishBody.success !== true) {
      return { channel: "FACEBOOK", ok: false, error: graphErrorMessage(finishBody, `HTTP ${finishRes.status}`) };
    }

    const readiness = await waitForFacebookReelReady(videoId, token);
    if (!readiness.ready && readiness.failed) {
      return { channel: "FACEBOOK", ok: false, error: readiness.error };
    }
    // secondaryPostId — тот же запасной адрес для удаления, что у видеопоста
    // (см. fetchFacebookVideoPostId выше); отказ здесь не роняет уже
    // состоявшуюся публикацию.
    const secondaryPostId = await fetchFacebookVideoPostId(videoId, token);
    return {
      channel: "FACEBOOK",
      ok: true,
      postId: videoId,
      ...(secondaryPostId ? { secondaryPostId } : {}),
      note: readiness.ready ? "опубликовано как Reels" : "Reels принят, Facebook ещё обрабатывает",
    };
  } catch (err) {
    return { channel: "FACEBOOK", ok: false, error: describeError(err) };
  }
}

/** Правит description уже опубликованного видео на странице — тот же приём,
 *  что и при публикации (POST /{video-id} с полем description), в отличие от
 *  Instagram Graph API это штатно поддерживается. Зовёт lib/publishedListingSync.ts
 *  при смене цены, чтобы не постить дубль. */
export async function updateFacebookVideoDescription(
  videoId: string,
  token: string,
  description: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${videoId}`;
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description, access_token: token }),
      },
      PUBLISH_TIMEOUT_MS
    );
    const body = await readJson(res);
    if (!res.ok || body.success === false) {
      // Код и подкод Meta — в текст (25.09.2026): на проде правка подписи давала
      // голое «An unknown error has occurred.» по 17 объектам, и без кода причину
      // (ролик ушёл в Reels, нет права страницы, частота) не отличить.
      const e = body.error as { code?: number; error_subcode?: number } | undefined;
      const code = e?.code != null ? ` (код ${e.code}${e.error_subcode != null ? `/${e.error_subcode}` : ""})` : "";
      return { ok: false, error: `${graphErrorMessage(body, `HTTP ${res.status}`)}${code}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/**
 * Кросспост в свой Telegram-канал (Фаза 1.5 плана).
 *
 * Своим ботом, а не через Meta: токен уже есть на сервере (TELEGRAM_BOT_TOKEN),
 * обёртка Bot API — telegram/api.ts. Отличие от переписки с клиентом только в
 * адресате: chat_id канала вместо чата человека, бот должен быть в канале
 * администратором.
 *
 * ТЕЛОМ ЗАПРОСА, НЕ ССЫЛКОЙ (20.09.2026, было: sendVideo(videoUrl)). На проде из
 * 8 объектов с публикациями TELEGRAM дошёл только у одного, `ErrorLog` копил
 * `Bad Request: failed to get HTTP URL content» (9 записей, последняя в тот же
 * день, 17:22 UTC). Проверено вживую: ссылка рабочая (изнутри контейнера
 * `telegram-bot-api` она скачивается `HTTP/1.1 200`, правильный
 * `Content-Length`, обложка тоже), User-Agent ни при чём, срок подписи ссылки —
 * сутки (истечение исключено), а том `uploads` в контейнер Bot API не
 * смонтирован (то есть путь на диске ему тоже не передать) — причина отказа
 * внутри самого загрузчика ссылок Bot API, копать её дальше не дешевле, чем
 * перестать от неё зависеть. Отправка теперь идёт multipart (sendVideoFile,
 * telegram/api.ts), тем же приёмом, что sendDocumentFile у монтажёра.
 *
 * Ни ревью приложения, ни бизнес-верификации Telegram не требует — поэтому
 * этот канал и сделан раньше TikTok, хотя задуман позже.
 */

/**
 * Таймаут ОТПРАВКИ тела запроса — то же число, что раньше было отведено на
 * скачивание ролика Telegram'ом ПО ССЫЛКЕ (было: TELEGRAM_VIDEO_TIMEOUT_MS для
 * sendVideo(videoUrl)). Порядок величины тот же и после перехода на multipart:
 * ролики остаются теми же десятками мегабайт, путь до самой инфраструктуры
 * Telegram (за контейнером Bot API) — то же узкое место, что и раньше.
 */
const TELEGRAM_VIDEO_TIMEOUT_MS = 120_000;

export async function publishTelegramVideo(
  channelId: string,
  /** Абсолютный путь к ролику на диске — файл уходит телом запроса, не по сети за URL. */
  localVideoAbsolutePath: string,
  caption: string,
  /** Обложка (lib/video/coverPoster.ts) — необязательна: нет файла, публикуем без неё. */
  localCoverAbsolutePath?: string | null
): Promise<PublishResult> {
  try {
    if (!isTelegramEnabled()) {
      return { channel: "TELEGRAM", ok: false, error: "TELEGRAM_BOT_TOKEN не настроен на сервере" };
    }

    // Размер — по stat, ДО чтения в память: иначе файл крупнее предела всё равно
    // целиком осел бы в памяти процесса раньше, чем мы поймём, что он не пройдёт
    // (тот же приём, что и downloadFile в telegram/api.ts).
    let fileSize: number;
    try {
      fileSize = (await fs.stat(localVideoAbsolutePath)).size;
    } catch (err) {
      // Объект старый, сырьё убрано с диска, или путь битый — это честный отказ
      // канала, а не молчаливый пропуск: Instagram/Facebook/YouTube могли пройти,
      // и без записи в журнал пропажу Telegram никто бы не заметил (см. владелец
      // 20.09.2026: «телеграм тоже давно не работает»).
      const error = `Файл ролика не найден на диске (${localVideoAbsolutePath}) — публикация в Telegram невозможна`;
      void logSystemError("telegram", `Публикация в канал Telegram: ${error}: ${describeError(err)}`);
      return { channel: "TELEGRAM", ok: false, error };
    }

    if (fileSize > TELEGRAM_BOT_SEND_LIMIT_BYTES) {
      const limitMb = Math.round(TELEGRAM_BOT_SEND_LIMIT_BYTES / 1024 / 1024);
      return {
        channel: "TELEGRAM",
        ok: false,
        error: `Видео ${(fileSize / 1024 / 1024).toFixed(1)} МБ — предел отправки своего Bot API сервера ${limitMb} МБ`,
      };
    }

    const video = await videoBlob(localVideoAbsolutePath);

    // Обложка необязательна: нет файла (старый пост, сырьё убрано) — публикуем
    // без неё, а не отменяем публикацию ролика из-за отсутствующей картинки.
    let thumbnail: { buffer: Buffer; filename: string } | null = null;
    if (localCoverAbsolutePath) {
      try {
        thumbnail = { buffer: await fs.readFile(localCoverAbsolutePath), filename: path.basename(localCoverAbsolutePath) };
      } catch {
        // см. комментарий выше — отсутствие обложки не повод молчать в канал.
      }
    }

    // РЕГРЕССИЯ PR #586 (21.09.2026, объект ОБ-000113): без width/height/duration
    // Telegram не знает геометрию ролика при отправке телом запроса (раньше их
    // определял сам, скачивая по ссылке) и рисует вертикальный Reels квадратом,
    // «будто сжали со сторон». Определяем их через уже существующую обвязку
    // ffprobe (lib/ffmpeg.ts) — не отменяем публикацию, если не вышло: шлём без
    // этих полей, как раньше, но причина обязана попасть в журнал, а не потеряться.
    const dimensions = await probeVideoDimensions(localVideoAbsolutePath);
    if (!dimensions) {
      void logSystemError(
        "telegram",
        `Публикация в канал Telegram: не удалось определить width/height/duration ролика (${localVideoAbsolutePath}) — отправляем без них, Telegram может показать превью некорректно`
      );
    }

    // Сверка пропорций обложки с самим роликом — непропорциональный кадр даёт
    // искажённое превью в Telegram даже при верных width/height ролика. Не
    // блокирует публикацию — только запись в журнал, картинка уже прикреплена к посту.
    if (thumbnail && dimensions && localCoverAbsolutePath) {
      const coverDims = await probeImageDimensions(localCoverAbsolutePath);
      if (coverDims) {
        const videoAspect = dimensions.width / dimensions.height;
        const coverAspect = coverDims.width / coverDims.height;
        if (Math.abs(videoAspect - coverAspect) / videoAspect > 0.05) {
          void logSystemError(
            "telegram",
            `Публикация в канал Telegram: обложка непропорциональна ролику (обложка ${coverDims.width}x${coverDims.height}, ролик ${dimensions.width}x${dimensions.height}) — превью может выглядеть искажённым`
          );
        }
      }
    }

    // Подпись Telegram обрезает на 1024 символах и отклоняет запрос целиком,
    // если она длиннее, — а шаблоны Reels бывают длиннее (у Instagram предел
    // 2200). Режем сами, чтобы пост ушёл, а не упал из-за лишней строки.
    const result = (await sendTelegramVideoFile(
      channelId,
      video,
      path.basename(localVideoAbsolutePath),
      caption.slice(0, 1024),
      thumbnail,
      TELEGRAM_VIDEO_TIMEOUT_MS,
      dimensions ? { width: dimensions.width, height: dimensions.height, duration: dimensions.durationSec } : null
    )) as { message_id?: number } | undefined;
    return { channel: "TELEGRAM", ok: true, postId: result?.message_id ? String(result.message_id) : undefined };
  } catch (err) {
    return { channel: "TELEGRAM", ok: false, error: describeError(err) };
  }
}

export interface YouTubeCredentials {
  clientId?: string;
  clientSecret?: string;
  /** Долгоживущий refresh_token из OAuth-согласия владельца канала — получается
   *  один раз вручную (Google OAuth Playground или консоль Google Cloud), CRM
   *  сама его не выпускает: полноценный consent-flow — за рамками этой правки,
   *  как и TikTok ниже. */
  refreshToken?: string;
}

/** Более долгий таймаут: PUT самого видео, а не JSON-запрос метаданных. */
const YOUTUBE_UPLOAD_TIMEOUT_MS = 5 * 60_000;

export async function youtubeAccessToken(creds: YouTubeCredentials): Promise<string> {
  return (await youtubeAccessGrant(creds)).accessToken;
}

/**
 * Обмен refresh→access вместе со СПИСКОМ ВЫДАННЫХ ПРАВ (23.09.2026). Google кладёт
 * их в поле `scope` того же ответа, через пробел, — отдельного запроса не нужно.
 * По нему суточная проверка (lib/tokenScopes.ts) говорит, каких прав не хватает
 * refresh-токену, ДО того, как отвалится публикация или чтение комментариев.
 */
export async function youtubeAccessGrant(creds: YouTubeCredentials): Promise<{ accessToken: string; scopes: string[] }> {
  const res = await fetchWithRetry(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: creds.clientId!,
        client_secret: creds.clientSecret!,
        refresh_token: creds.refreshToken!,
        grant_type: "refresh_token",
      }).toString(),
    },
    PUBLISH_TIMEOUT_MS
  );
  const body = await readJson(res);
  const accessToken = body.access_token as string | undefined;
  if (!res.ok || !accessToken) {
    throw new Error(`Не удалось обновить токен YouTube: ${graphErrorMessage(body, `HTTP ${res.status}`)}`);
  }
  return { accessToken, scopes: splitScopes(body.scope) };
}

/** Список прав из ответа OAuth: Google разделяет пробелом, TikTok — запятой. */
export function splitScopes(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * YouTube Shorts — YouTube Data API v3, resumable upload (init → PUT байтов).
 * В ОТЛИЧИЕ от Instagram/Telegram: Google САМ видео по ссылке не скачивает —
 * тело шлём мы, поэтому на входе ЛОКАЛЬНЫЙ путь к файлу, а не публичный URL
 * (единственный из четырёх каналов с такой разницей — важно не перепутать при
 * вызове из publishApprovedPost). Вертикальное видео ≤60 сек автоматически
 * становится Shorts — отдельного API/флага для этого у YouTube нет. Кастомная
 * обложка для Shorts самим YouTube не поддерживается (thumbnails.set не
 * действует на Shorts) — это ограничение платформы, не наш недочёт.
 */
/**
 * Состояние оборвавшейся сессии возобновляемой загрузки и, если надо, её
 * доливка. Возвращает: `done` — видео у YouTube есть (id внутри), `gone` —
 * сессии больше нет, надо начинать сначала, `failed` — внятный отказ.
 *
 * Любой неожиданный ответ считаем `gone`: заново загрузить ролик хуже, чем
 * подхватить сессию, но лучше, чем молча отметить канал опубликованным без
 * поста.
 */
async function resumeYouTubeUpload(
  uploadUrl: string,
  videoBytes: Blob
): Promise<{ kind: "done"; videoId: string } | { kind: "gone"; unexpected?: string } | { kind: "failed"; error: string }> {
  try {
    const statusRes = await fetchWithRetry(
      uploadUrl,
      { method: "PUT", headers: { "Content-Range": `bytes */${videoBytes.size}`, "Content-Length": "0" } },
      PUBLISH_TIMEOUT_MS
    );
    if (statusRes.status === 404 || statusRes.status === 410) return { kind: "gone" };
    if (statusRes.ok) {
      const body = await readJson(statusRes);
      const videoId = body.id as string | undefined;
      if (videoId) return { kind: "done", videoId };
      return { kind: "gone", unexpected: "сессия ответила успехом, но без идентификатора видео" };
    }
    // 308 Resume Incomplete — единственный случай, когда доливаем. Льём целиком
    // в ту же сессию: видео от этого одно, а разбор диапазона из заголовка
    // Range — лишняя арифметика ради тех же байтов.
    if (statusRes.status !== 308) return { kind: "gone", unexpected: `сессия ответила HTTP ${statusRes.status}` };
    const uploadRes = await fetchWithRetry(
      uploadUrl,
      { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Length": String(videoBytes.size) }, body: videoBytes },
      YOUTUBE_UPLOAD_TIMEOUT_MS
    );
    const body = await readJson(uploadRes);
    const videoId = body.id as string | undefined;
    if (uploadRes.ok && videoId) return { kind: "done", videoId };
    return { kind: "failed", error: graphErrorMessage(body, `HTTP ${uploadRes.status}`) };
  } catch (err) {
    return { kind: "failed", error: describeError(err) };
  }
}

/**
 * Отметки для страховки от второй загрузки (см. YOUTUBE_PENDING_KEY).
 * Сама публикация в БД не ходит — метку ставит и снимает вызывающий.
 */
export interface YouTubePublishHooks {
  /** Адрес сессии загрузки, оставшийся от оборвавшейся попытки. */
  resumeUploadUrl?: string | null;
  /** Адрес сессии получен — запомнить ДО того, как поедут байты. */
  onUploadStarted?: (uploadUrl: string) => Promise<void>;
  /** Исход определён (видео есть или отказ) — метку снять. */
  onAnswered?: () => Promise<void>;
  /** Сессия прошлой попытки ответила неожиданным образом — в журнал. */
  onResumeProblem?: (message: string) => void;
}

/**
 * РОЛИК С ДИСКА — ЛЕНИВЫМ BLOB, А НЕ БУФЕРОМ (аудит 23.09.2026, круг 3, №80).
 * Ролики доходят до гигабайтов (свой Bot API сервер принимает до 2 ГБ), а
 * фоновый процесс живёт в 3 ГБ: `fs.readFile` целиком на каждый канал
 * публикации — и одна публикация большого ролика роняла процесс со всеми
 * задачами по расписанию. Blob из `openAsBlob` читает файл по мере отправки;
 * `slice` для частей TikTok ничего не читает заранее, повтор запроса
 * (fetchWithRetry) перечитывает с диска.
 */
function videoBlob(filePath: string): Promise<Blob> {
  return openAsBlob(filePath, { type: "video/mp4" });
}

export async function publishYouTubeShort(
  creds: YouTubeCredentials,
  localVideoPath: string,
  title: string,
  hooks?: YouTubePublishHooks
): Promise<PublishResult> {
  try {
    if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
      return { channel: "YOUTUBE", ok: false, error: "YouTube не настроен (нет client_id/client_secret/refresh_token в Настройках)" };
    }
    const accessToken = await youtubeAccessToken(creds);
    const videoBytes = await videoBlob(localVideoPath);

    /**
     * СЕССИЯ ПРОШЛОЙ ПОПЫТКИ, ЕСЛИ ОНА БЫЛА (см. YOUTUBE_PENDING_KEY). Адрес
     * сессии возобновляемой загрузки — это и есть ручка повтора: сколько раз в
     * неё ни лей, видео получится ОДНО. Сперва спрашиваем её состояние пустым
     * PUT с заголовком Content-Range вида «bytes звёздочка/N» — так устроен
     * протокол Google: 200/201 значит «всё уже загружено, вот видео», 308 —
     * «догрузи», 404/410 — «сессии больше нет, начинай сначала».
     */
    if (hooks?.resumeUploadUrl) {
      const resumed = await resumeYouTubeUpload(hooks.resumeUploadUrl, videoBytes);
      await hooks.onAnswered?.();
      if (resumed.kind === "done") {
        return { channel: "YOUTUBE", ok: true, postId: resumed.videoId, permalink: `https://youtube.com/shorts/${resumed.videoId}` };
      }
      if (resumed.kind === "failed") {
        return { channel: "YOUTUBE", ok: false, error: resumed.error };
      }
      // "gone" — сессия протухла (404/410, это норма) либо ответила чем-то
      // неожиданным. Второе — повод для строки в журнале: грузим заново, а
      // значит рискуем вторым роликом, и причина не должна остаться немой.
      // Сам адрес сессии в журнал не пишем: в нём ключ загрузки.
      if (resumed.unexpected) hooks.onResumeProblem?.(resumed.unexpected);
    }
    // Заголовок YouTube ≤100 символов — шаблоны подписи Reels рассчитаны на
    // предел Instagram (2200) и обычно длиннее.
    const safeTitle = title.slice(0, 100) || "Reels";

    const initRes = await fetchWithRetry(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "X-Upload-Content-Type": "video/mp4",
          "X-Upload-Content-Length": String(videoBytes.size),
        },
        body: JSON.stringify({
          snippet: { title: safeTitle, description: title, categoryId: "22" },
          status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
        }),
      },
      PUBLISH_TIMEOUT_MS
    );
    if (!initRes.ok) {
      const body = await readJson(initRes);
      return { channel: "YOUTUBE", ok: false, error: graphErrorMessage(body, `HTTP ${initRes.status}: не удалось начать загрузку`) };
    }
    const uploadUrl = initRes.headers.get("location");
    if (!uploadUrl) {
      return { channel: "YOUTUBE", ok: false, error: "YouTube не вернул адрес загрузки (заголовок Location)" };
    }

    // Адрес сессии — ДО того, как поедут байты: обрыв после этой строки
    // доделывается повтором в ту же сессию, а не второй загрузкой.
    await hooks?.onUploadStarted?.(uploadUrl);

    const uploadRes = await fetchWithRetry(
      uploadUrl,
      { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Length": String(videoBytes.size) }, body: videoBytes },
      YOUTUBE_UPLOAD_TIMEOUT_MS
    );
    const uploadBody = await readJson(uploadRes);
    const videoId = uploadBody.id as string | undefined;
    // Ответ пришёл — исход определён, метка больше не нужна.
    await hooks?.onAnswered?.();
    if (!uploadRes.ok || !videoId) {
      return { channel: "YOUTUBE", ok: false, error: graphErrorMessage(uploadBody, `HTTP ${uploadRes.status}`) };
    }
    return { channel: "YOUTUBE", ok: true, postId: videoId, permalink: `https://youtube.com/shorts/${videoId}` };
  } catch (err) {
    return { channel: "YOUTUBE", ok: false, error: describeError(err) };
  }
}

/** Правит title/description уже загруженного видео — videos.update (part=snippet)
 *  заменяет ВЕСЬ snippet целиком, поэтому title передаём заново той же обрезкой
 *  ≤100 символов, что и при публикации (publishYouTubeShort), иначе заголовок
 *  стирался бы вместе с обновлением описания. Зовёт publishedListingSync.ts при
 *  смене цены. categoryId=22 — тот же, что при загрузке (People & Blogs). */
export async function updateYouTubeDescription(
  creds: YouTubeCredentials,
  videoId: string,
  title: string,
  description: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
      return { ok: false, error: "YouTube не настроен (нет client_id/client_secret/refresh_token в Настройках)" };
    }
    const accessToken = await youtubeAccessToken(creds);
    const res = await fetchWithRetry(
      "https://www.googleapis.com/youtube/v3/videos?part=snippet",
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          id: videoId,
          snippet: { title: title.slice(0, 100) || "Reels", description, categoryId: "22" },
        }),
      },
      PUBLISH_TIMEOUT_MS
    );
    if (!res.ok) {
      const body = await readJson(res);
      return { ok: false, error: graphErrorMessage(body, `HTTP ${res.status}`) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/**
 * ОБЛОЖКА ПОСЛЕ ПУБЛИКАЦИИ (25.09.2026, владелец: «обложки везде, где можно»).
 * Обе функции — отдельный вызов ПОСЛЕ того, как видео уже вышло: сама публикация
 * от обложки не зависит и не может из-за неё упасть или задвоиться (POST /videos
 * Facebook не идемпотентен — повторять его ради превью нельзя). Возвращают
 * строку для журнала публикации; null — обложка встала.
 */
export async function setFacebookVideoThumbnail(videoId: string, token: string, squareAbsolutePath: string): Promise<string | null> {
  try {
    const form = new FormData();
    form.append("access_token", token);
    form.append("is_preferred", "true");
    form.append("source", new Blob([new Uint8Array(await fs.readFile(squareAbsolutePath))], { type: "image/jpeg" }), "cover.jpg");
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${videoId}/thumbnails`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    const body = await readJson(res);
    if (!res.ok || body.success === false) return `Facebook не принял обложку: ${graphErrorMessage(body, `HTTP ${res.status}`)} — видео опубликовано с превью Facebook`;
    return null;
  } catch (err) {
    return `Обложка в Facebook не ушла: ${describeError(err)} — видео опубликовано с превью Facebook`;
  }
}

/** Квадрат → 1280×720 полями тёмно-зелёного фона (YouTube ждёт 16:9, до 2 МБ). */
export async function youtubeThumbnailFromSquare(squareAbsolutePath: string): Promise<Buffer> {
  const square = await sharp(squareAbsolutePath).resize(720, 720, { fit: "cover" }).toBuffer();
  return sharp(square).extend({ left: 280, right: 280, top: 0, bottom: 0, background: "#07130F" }).jpeg({ quality: 88 }).toBuffer();
}

export async function setYouTubeThumbnail(creds: YouTubeCredentials, videoId: string, squareAbsolutePath: string): Promise<string | null> {
  try {
    const accessToken = await youtubeAccessToken(creds);
    const image = await youtubeThumbnailFromSquare(squareAbsolutePath);
    const res = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "image/jpeg" },
      body: new Uint8Array(image),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    if (res.ok) return null;
    const body = await readJson(res);
    const message = graphErrorMessage(body, `HTTP ${res.status}`);
    if (res.status === 403 && /insufficient|scope/i.test(message)) {
      return (
        "YouTube не дал поставить обложку: у токена нет права youtube.force-ssl. Перевыпустите токен YouTube в Настройках " +
        "с этим правом (рецепт — docs/archive/youtube-oauth-refresh-check-11-09-2026.md). Видео опубликовано с превью YouTube"
      );
    }
    if (res.status === 403) {
      return `YouTube не дал поставить обложку (${message}): своя обложка доступна только каналу, подтверждённому по телефону. Видео опубликовано`;
    }
    return `YouTube не принял обложку: ${message}. Видео опубликовано с превью YouTube`;
  } catch (err) {
    return `Обложка в YouTube не ушла: ${describeError(err)}. Видео опубликовано`;
  }
}

/** Заметка к результату канала — дописывается к уже имеющейся. */
function appendNote(result: PublishResult, note: string | null): void {
  if (!note) return;
  result.note = result.note ? `${result.note}; ${note}` : note;
}


/**
 * СНЯТЬ УЖЕ ОПУБЛИКОВАННОЕ (19.09.2026, владелец: «или удалить отовсюду как-то»;
 * Instagram добавлен 20.09.2026 — см. ниже).
 *
 * Снимается ровно там, где площадка это позволяет, и ни строкой больше:
 *
 * - **Facebook** — `DELETE /{video-id}`, штатно; при отказе пробуем ещё
 *   `/{post-id}` (Property.publishedPostIds.FACEBOOK_POST) — см. случай №112 ниже.
 * - **YouTube** — `videos.delete`, штатно; удаление безвозвратно, черновика не
 *   остаётся.
 * - **Telegram-канал** — `deleteMessage` своим ботом (telegram/api.ts).
 * - **Instagram — РАБОТАЕТ, но не тем токеном, что переписка.** До 20.09.2026 здесь
 *   стояло «нельзя»: Graph API отвечал `400 Unsupported delete request` (проверено
 *   04.09.2026). Причина — не ограничение площадки, а токен: `metaIgToken`
 *   выдан продукту «Instagram API» и ходит на graph.instagram.com через прокси
 *   (messengers/meta.ts::instagramApiUrl), а тот продукт метода удаления не имеет
 *   вовсе. Живая проверка 20.09.2026 (тестовый пост опубликован и удалён,
 *   `DELETE /{ig-media-id}` вернул `{"success": true}`) прошла токеном через
 *   Facebook Login на graph.facebook.com — правами `instagram_basic` +
 *   `instagram_manage_contents`, которые Standard access выдаёт без App Review.
 *   Держим его отдельным полем `Settings.metaIgManageToken`: не задано — Instagram
 *   по-прежнему уходит в ручной список, честно, как раньше.
 * - **TikTok — НЕЛЬЗЯ.** Content Posting API удаления не даёт вовсе, и id поста
 *   мы даже не храним (см. publishedPostIds в schema.prisma).
 *
 * Отсюда правило всего механизма: код снимает что может и ЧЕСТНО возвращает
 * список того, что человеку придётся убрать руками, со ссылками. Молча
 * отрапортовать «удалено отовсюду» было бы ложью, которую увидят подписчики.
 */
export interface DeleteResult {
  ok: boolean;
  error?: string;
  /** true — объекта на площадке УЖЕ не было (см. isGhostObjectError): цель
   *  «поста нет» достигнута, канал вычёркивается как обычный успех, но
   *  вызывающий код обязан честно показать «поста уже не было», а не «удалено». */
  ghost?: boolean;
}

/**
 * «ОБЪЕКТА НЕ СУЩЕСТВУЕТ» — ЭТО НЕ ОТКАЗ, ЭТО ЦЕЛЬ УЖЕ ДОСТИГНУТА.
 *
 * Случай №112 (20.09.2026): в publishedPostIds.FACEBOOK лежал id
 * 1579777273883019, которого на странице больше нет (проверено токеном страницы:
 * `Unsupported get request. Object with ID '1579777273883019' does not exist,
 * cannot be loaded due to missing permission...`). Кнопка «Убрать из соцсетей»
 * считала это ошибкой и НЕ вычёркивала канал — новый ролик в Facebook уже
 * никогда бы туда не уехал (publishApprovedPost пропускает каналы из
 * publishedChannels, см. videoHandoff.ts::skipChannels).
 *
 * Отличаем от настоящего отказа по `error.code === 100` («unsupported request» —
 * ровно тот код, которым Meta помечает и «нет прав на живой объект», и «объекта
 * нет вовсе») ВМЕСТЕ с текстом "does not exist" в сообщении — так Graph API
 * формулирует именно отсутствие объекта что на GET, что на DELETE. Голого
 * `code === 100` мало: у него слишком много других причин (устаревшая версия
 * API, неверный формат запроса), которые как раз ЯВЛЯЮТСЯ отказом и не должны
 * вычёркивать канал молча.
 */
function isGhostObjectError(body: Record<string, unknown>): boolean {
  const error = body.error as { code?: number; message?: string } | undefined;
  if (!error || typeof error.message !== "string") return false;
  return error.code === 100 && error.message.toLowerCase().includes("does not exist");
}

export async function deleteFacebookVideo(videoId: string, token: string): Promise<DeleteResult> {
  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${videoId}?access_token=${encodeURIComponent(token)}`;
    const res = await fetchWithRetry(url, { method: "DELETE" }, PUBLISH_TIMEOUT_MS);
    const body = await readJson(res);
    if (!res.ok || body.success === false) {
      if (isGhostObjectError(body)) return { ok: true, ghost: true };
      return { ok: false, error: graphErrorMessage(body, `HTTP ${res.status}`) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/**
 * СНЯТЬ ОПУБЛИКОВАННЫЙ Reels (20.09.2026, проверено живьём — см. докстринг выше).
 * Хост ПРЯМОЙ (graph.facebook.com), БЕЗ прокси instagramApiUrl/instagramRequest —
 * тех, что нужны только продукту `metaIgToken` (graph.instagram.com); токен
 * Facebook Login адресует запрос напрямую, как и остальные вызовы Facebook в
 * этом файле (publishFacebookVideo, deleteFacebookVideo).
 */
export async function deleteInstagramMedia(mediaId: string, token: string): Promise<DeleteResult> {
  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}?access_token=${encodeURIComponent(token)}`;
    const res = await fetchWithRetry(url, { method: "DELETE" }, PUBLISH_TIMEOUT_MS);
    const body = await readJson(res);
    if (!res.ok || body.success === false) {
      if (isGhostObjectError(body)) return { ok: true, ghost: true };
      return { ok: false, error: graphErrorMessage(body, `HTTP ${res.status}`) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/**
 * ig-user-id аккаунта, привязанного к Странице Facebook — нужен, чтобы пройти
 * его ленту и найти media id старых Reels, у которых он не сохранён (см.
 * findInstagramMediaIdByPermalink ниже). Тем же токеном Facebook Login, что и
 * само удаление — не переиспользуем `instagramTokenIdentity` (meta.ts): та
 * функция ходит через прокси на graph.instagram.com маркером ДРУГОГО продукта.
 */
export async function resolveInstagramBusinessAccountId(token: string, pageId: string): Promise<string | null> {
  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}?fields=instagram_business_account&access_token=${encodeURIComponent(token)}`;
    const res = await fetchWithRetry(url, {}, PUBLISH_TIMEOUT_MS);
    if (!res.ok) return null;
    const body = await readJson(res);
    const account = body.instagram_business_account as { id?: string } | undefined;
    return account?.id ?? null;
  } catch {
    return null;
  }
}

/** До скольких публикаций листаем в поисках совпадения по ссылке — тот же
 *  порядок, что у общей ленты аккаунта (instagramFeed.ts::GLOBAL_MEDIA_LIMIT). */
const IG_MEDIA_SEARCH_LIMIT = 300;
const IG_MEDIA_PAGE_SIZE = 100;

/**
 * РЕЗУЛЬТАТ ПОИСКА MEDIA ID ПО ССЫЛКЕ (20.09.2026, случай №112-для-Instagram —
 * ролик №112 был опубликован ДО того, как мы стали сохранять media id).
 *
 * ТРИ ИСХОДА, А НЕ ДВА. Раньше функция отдавала просто `string | null`, и
 * вызывающий (removeFromSocial) не мог отличить «дочитали ленту до конца и
 * там правда нет такого поста» от «не смогли дочитать» (сеть легла, токен
 * истёк, страниц оказалось больше IG_MEDIA_SEARCH_LIMIT). Оба случая
 * возвращали null одинаково, и removeFromSocial одинаково молчал — падал в
 * manualSteps() без единой записи, как будто мы даже не пытались.
 *
 * `not_found` — цикл ниже дошёл до `paging.next === null` естественно, то
 * есть увидел ВСЮ ленту аккаунта и нужной ссылки в ней нет. Это тот же
 * фантом, что и `isGhostObjectError` у Facebook: пост удалили руками в
 * приложении, канал можно вычёркивать как успех.
 * `incomplete` — обход прервался не дойдя до конца (HTTP-отказ, сеть,
 * упёрлись в IG_MEDIA_SEARCH_LIMIT раньше конца страниц). Мы НЕ знаем, есть
 * пост дальше или нет — вычёркивать нельзя, нужна честная причина и в
 * журнал, и человеку.
 */
export type InstagramPermalinkSearchResult =
  | { status: "found"; mediaId: string }
  | { status: "not_found" }
  | { status: "incomplete"; reason: string };

/**
 * MEDIA ID ПО ССЫЛКЕ — для объектов, опубликованных ДО 20.09.2026: тогда
 * publishedPostIds.INSTAGRAM ещё не писался (см. videoHandoff.ts), а
 * Property.instagramUrl (permalink) есть у каждого. Идёт напрямую в
 * graph.facebook.com токеном Facebook Login — НЕ instagramFeed.ts::getAllOwnMedia
 * (та функция ходит через прокси на graph.instagram.com маркером `metaIgToken`,
 * продукт без права удаления) и не третья копия того же обхода: страница
 * запрашивается один раз здесь, потому что источник (хост, токен, права) у нашей
 * задачи другой, а не потому что прежний код не годился по форме.
 *
 * ПОЧЕМУ КРИТЕРИЙ «ДОЧИТАЛИ ДО КОНЦА», А НЕ «ДОШЛИ ДО ДАТЫ ПУБЛИКАЦИИ
 * ОБЪЕКТА». У Property нет поля «когда именно ролик вышел в Instagram» —
 * ближайшее по смыслу, stageEnteredAt, ставится при переходе в AVAILABLE и
 * могло случиться на несколько секунд раньше или позже реального поста, а
 * доверять здесь придётся расхождению часов сервера и Graph API. Полное
 * прочтение ленты (`paging.next` кончился сам) не требует вообще никаких
 * допущений о времени и порядке — это либо правда «мы видели все посты»,
 * либо нет. То же самое верно и для getAllOwnMedia (instagramFeed.ts):
 * там GLOBAL_MEDIA_LIMIT=300 — намеренная отсечка для другой задачи
 * (узнавание пересланного ролика, где не критично не увидеть совсем старый
 * пост), а не признак «дальше можно не смотреть» для решения «пост
 * действительно удалён» — поэтому здесь при упоре в IG_MEDIA_SEARCH_LIMIT
 * результат `incomplete`, а не `not_found`, даже если лимит тот же самый.
 */
export async function findInstagramMediaIdByPermalink(
  igUserId: string,
  token: string,
  permalink: string
): Promise<InstagramPermalinkSearchResult> {
  let url: string | null =
    `https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}/media?fields=id,permalink&limit=${IG_MEDIA_PAGE_SIZE}` +
    `&access_token=${encodeURIComponent(token)}`;
  let scanned = 0;
  while (url) {
    if (scanned >= IG_MEDIA_SEARCH_LIMIT) {
      // Страницы ещё есть (url не null), но мы отказались их открывать по
      // бюджету — это НЕ «дочитали и не нашли».
      return {
        status: "incomplete",
        reason: `обход ленты остановлен на ${IG_MEDIA_SEARCH_LIMIT}-й публикации — лента длиннее`,
      };
    }
    try {
      const res: Response = await fetchWithRetry(url, {}, PUBLISH_TIMEOUT_MS);
      if (!res.ok) return { status: "incomplete", reason: `Graph API HTTP ${res.status}` };
      const body = await readJson(res);
      const items = (body.data as { id?: string; permalink?: string }[] | undefined) ?? [];
      for (const item of items) {
        scanned++;
        if (item.permalink && item.permalink === permalink && item.id) return { status: "found", mediaId: item.id };
      }
      const paging = body.paging as { next?: string } | undefined;
      url = paging?.next ?? null;
    } catch (err) {
      return { status: "incomplete", reason: describeError(err) };
    }
  }
  // url стал null естественно (paging.next кончился) — лента дочитана
  // целиком, искомой ссылки в ней нет.
  return { status: "not_found" };
}

export async function deleteYouTubeVideo(creds: YouTubeCredentials, videoId: string): Promise<DeleteResult> {
  try {
    if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
      return { ok: false, error: "YouTube не настроен (нет client_id/client_secret/refresh_token в Настройках)" };
    }
    const accessToken = await youtubeAccessToken(creds);
    const res = await fetchWithRetry(
      `https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(videoId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } },
      PUBLISH_TIMEOUT_MS
    );
    // 204 — удалено; 404 — видео уже нет, для нас это тот же успех: цель
    // «поста нет» достигнута, и заставлять человека идти удалять вручную то,
    // чего нет, значит соврать ему во второй раз. Тот же приём, что теперь и у
    // Facebook/Instagram (isGhostObjectError выше) — только YouTube сигналит
    // отсутствие HTTP-статусом, а не телом ответа.
    if (res.status === 404) return { ok: true, ghost: true };
    if (!res.ok) {
      const body = await readJson(res);
      return { ok: false, error: graphErrorMessage(body, `HTTP ${res.status}`) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/** Ссылка на опубликованный Reels — нужна для Property.instagramUrl (тот же
 *  формат ссылки, что раньше вписывал монтажёр вручную), не только сам id. */
export async function fetchInstagramPermalink(mediaId: string, token: string): Promise<string | null> {
  try {
    const req = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/${mediaId}?fields=permalink`), token);
    const res = await fetchWithRetry(req.url, { headers: req.headers }, PUBLISH_TIMEOUT_MS);
    const body = await readJson(res);
    return (body.permalink as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * ПОСТ ЕЩЁ ВИСИТ? — ЧТЕНИЕ, А НЕ УДАЛЕНИЕ (22.09.2026, ежесуточная сверка).
 *
 * Три исхода, а не два, — ровно по тому же доводу, что у
 * `InstagramPermalinkSearchResult` выше: «не смогли проверить» нельзя путать с
 * «поста нет». Сверка (lib/publishedChannelsAudit.ts) вычёркивает канал из
 * `Property.publishedChannels` ТОЛЬКО на `gone`; на `unknown` она не делает
 * ничего, потому что упавшая сеть, протухший токен и исчерпанная квота Graph
 * API выглядят снаружи одинаково, а цена ошибки несимметрична: лишний раз не
 * заметить фантом — это ещё сутки до следующего прохода, а вычеркнуть живой
 * пост значит опубликовать поверх него второй ролик на публичной странице.
 *
 * Отдельно от DELETE-функций рядом намеренно: сверка ходит по СОТНЯМ карточек
 * за ночь, и единственный способ не удалить ничего по ошибке — не иметь в этом
 * пути ни одного вызова, который что-то удаляет.
 */
export type PresenceResult =
  | { status: "present" }
  | { status: "gone" }
  | { status: "unknown"; reason: string };

/** Общая часть Facebook и Instagram: оба объекта живут в graph.facebook.com и
 *  оба сигналят отсутствие одинаково — `code 100` + "does not exist"
 *  (isGhostObjectError). Instagram проверяется ТЕМ ЖЕ токеном Facebook Login
 *  (`metaIgManageToken`), что и удаление: у продукта `metaIgToken` (прокси на
 *  graph.instagram.com) ответ на чужой/удалённый media отличить не удаётся. */
async function checkGraphObjectExists(objectId: string, token: string): Promise<PresenceResult> {
  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${objectId}?fields=id&access_token=${encodeURIComponent(token)}`;
    const res = await fetchWithRetry(url, {}, PUBLISH_TIMEOUT_MS);
    const body = await readJson(res);
    if (res.ok && typeof body.id === "string") return { status: "present" };
    if (isGhostObjectError(body)) return { status: "gone" };
    return { status: "unknown", reason: graphErrorMessage(body, `HTTP ${res.status}`) };
  } catch (err) {
    return { status: "unknown", reason: describeError(err) };
  }
}

export const checkFacebookVideoExists = (videoId: string, token: string): Promise<PresenceResult> =>
  checkGraphObjectExists(videoId, token);

export const checkInstagramMediaExists = (mediaId: string, token: string): Promise<PresenceResult> =>
  checkGraphObjectExists(mediaId, token);

/**
 * YouTube сигналит отсутствие не ошибкой, а ПУСТЫМ `items` при HTTP 200 — тот
 * же приём, что и у 404 в `deleteYouTubeVideo`. Пустой список безопасно читать
 * как «видео нет» именно потому, что запрос идёт от имени владельца канала
 * (refresh token из Настроек): `videos.list` по id возвращает владельцу и
 * приватные, и ограниченные видео — то есть пусто здесь означает «удалено»,
 * а не «скрыто от посторонних».
 */
export async function checkYouTubeVideoExists(creds: YouTubeCredentials, videoId: string): Promise<PresenceResult> {
  try {
    if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
      return { status: "unknown", reason: "YouTube не настроен (нет client_id/client_secret/refresh_token в Настройках)" };
    }
    const accessToken = await youtubeAccessToken(creds);
    const res = await fetchWithRetry(
      `https://www.googleapis.com/youtube/v3/videos?part=id&id=${encodeURIComponent(videoId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      PUBLISH_TIMEOUT_MS
    );
    const body = await readJson(res);
    if (!res.ok) return { status: "unknown", reason: graphErrorMessage(body, `HTTP ${res.status}`) };
    const items = body.items as unknown[] | undefined;
    if (!Array.isArray(items)) return { status: "unknown", reason: "ответ YouTube без items" };
    return items.length > 0 ? { status: "present" } : { status: "gone" };
  } catch (err) {
    return { status: "unknown", reason: describeError(err) };
  }
}

export interface TikTokCredentials {
  clientKey?: string;
  clientSecret?: string;
  /** Ротируется TikTok на КАЖДОМ обмене — см. комментарий у поля в schema.prisma.
   *  tiktokAccessToken ниже сам сохраняет новый в Settings, вызывающему коду
   *  заботиться об этом не нужно. */
  refreshToken?: string;
}

export interface TikTokPostPrefs {
  /** Одно из privacy_level_options аккаунта — null означает «владелец ещё не
   *  выбрал», см. комментарий у Settings.tiktokPrivacyLevel. */
  privacyLevel?: string | null;
  allowComments: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  brandMode: "NONE" | "ORGANIC" | "BRANDED";
}

export const TIKTOK_UPLOAD_TIMEOUT_MS = 5 * 60_000;
/**
 * Правило чанков TikTok (Media Transfer Guide): каждый чанк 5–64 МБ, последний
 * может быть больше (до 128 МБ); total_chunk_count = floor(size / chunk_size);
 * ролик БОЛЬШЕ 64 МБ — обязательно несколькими чанками.
 *
 * До 23.09.2026 здесь были чанки по 64 МБ, и ролик 64–128 МБ уходил ОДНИМ чанком
 * (floor = 1) — TikTok отвечал «The chunk size is invalid» (два отказа за утро
 * 23.09 на роликах монтажёра). Теперь одним куском идёт только то, что заведомо
 * меньше 64 МБ в любом прочтении «МБ» (десятичном и двоичном), а всё крупнее —
 * чанками по 20 000 000 байт: это ≥5 МБ и ≤64 МБ при любом прочтении, последний
 * чанк < 40 МБ, предел в 1000 чанков — 20 ГБ, далеко за лимитом TikTok на файл.
 */
const TIKTOK_SINGLE_CHUNK_MAX_BYTES = 60_000_000;
const TIKTOK_CHUNK_SIZE_BYTES = 20_000_000;
const TIKTOK_STATUS_POLL_INTERVAL_MS = 3_000;
/** 2 минуты ожидания (40 × 3с) — тот же порядок, что у опроса Reels выше. */
const TIKTOK_STATUS_POLL_MAX_ATTEMPTS = 40;

/** Чистая функция — вынесена отдельно, чтобы расчёт чанков проверялся тестом
 *  без реальной загрузки файла нужного размера в память. */
export function tiktokChunkPlan(videoSizeBytes: number): { chunkSize: number; totalChunkCount: number } {
  if (videoSizeBytes <= TIKTOK_SINGLE_CHUNK_MAX_BYTES) {
    return { chunkSize: videoSizeBytes, totalChunkCount: 1 };
  }
  const chunkSize = TIKTOK_CHUNK_SIZE_BYTES;
  return { chunkSize, totalChunkCount: Math.floor(videoSizeBytes / chunkSize) };
}

/** Коды `error.code` TikTok (init) → понятный русский текст (проверено по
 *  документации 17.09.2026, см. docs/archive/agent-briefs/tiktok-content-posting-17-09.md). */
const TIKTOK_ERROR_MESSAGES: Record<string, string> = {
  // Формулировка про "уровень публикации" была неверна (проверено 17.09.2026,
  // владелец получил именно этот код с приватным уровнем УЖЕ выбранным): TikTok
  // требует, чтобы САМ АККАУНТ был приватным, пока приложение не прошло ревью —
  // это настройка профиля в приложении TikTok, а не privacy_level конкретного ролика.
  unaudited_client_can_only_post_to_private_accounts:
    "Приложение TikTok ещё не прошло ревью — до этого аккаунт TikTok должен быть приватным (в приложении TikTok: Настройки → Конфиденциальность → Приватный аккаунт), уровень приватности ролика тут ни при чём",
  privacy_level_option_mismatch: "Выбранный уровень приватности не разрешён этим аккаунтом TikTok — выберите другой в Настройках",
  scope_not_authorized: "Токену TikTok не хватает прав — переподключите аккаунт в Настройках → Каналы связи",
  access_token_invalid: "Токен доступа TikTok недействителен — переподключите аккаунт в Настройках → Каналы связи",
  spam_risk_too_many_posts: "TikTok посчитал публикации спамом (слишком много подряд) — попробуйте позже",
  /**
   * НЕ ТО ЖЕ, ЧТО «слишком много постов» (получено 22.09.2026 в 19:06).
   * «Pending share» — это загруженный, но НЕ ОПУБЛИКОВАННЫЙ ролик: пока
   * приложение не прошло ревью TikTok, прямая публикация падает и ролик уходит
   * во «Входящие» (см. tiktokPublishToInbox), где ждёт, чтобы владелец
   * дооформил его в приложении. TikTok разрешает держать так не больше пяти
   * штук за сутки — то есть копятся не наши публикации, а наши НЕподтверждённые
   * черновики. Разводить публикации по времени эту стену не пробивает: пока
   * черновики висят, шестой ролик не примут ни через час, ни через день.
   */
  spam_risk_too_many_pending_share:
    "TikTok не принимает новые ролики: во «Входящих» скопились неопубликованные черновики (их разрешено не больше пяти за сутки). Откройте приложение TikTok и опубликуйте или удалите их — после этого ролик уйдёт сам",
  spam_risk_user_banned_from_posting: "TikTok запретил этому аккаунту публиковать — вопрос решается только в поддержке TikTok",
  rate_limit_exceeded: "Превышен лимит запросов к TikTok — попробуйте позже",
};

/**
 * Коды, которые проходят САМИ. Ролик по ним не «не вышел», а «ещё не вышел»:
 * повторить попытку позже — единственно верное поведение, см. PublishResult.retriable.
 *
 * `spam_risk_user_banned_from_posting` сюда НЕ входит намеренно: бан сам не
 * рассасывается, и молотить по нему повторами значит только копить отказы в
 * журнале вместо того, чтобы позвать человека.
 */
const TIKTOK_RETRIABLE_ERROR_CODES = new Set([
  "spam_risk_too_many_posts",
  "spam_risk_too_many_pending_share",
  "rate_limit_exceeded",
]);

/** Можно ли повторить попытку позже — по коду ошибки TikTok. */
export function isTikTokRetriableCode(code: string | undefined): boolean {
  return code !== undefined && TIKTOK_RETRIABLE_ERROR_CODES.has(code);
}

function tiktokErrorMessage(code: string | undefined, fallback: string): string {
  if (!code) return fallback;
  return TIKTOK_ERROR_MESSAGES[code] ?? `${fallback} (${code})`;
}

/**
 * Обновляет access_token TikTok. В ОТЛИЧИЕ от YouTube, TikTok выдаёт НОВЫЙ
 * refresh_token на каждый обмен, и старый после этого недействителен —
 * сохраняем его в Settings сразу здесь, а не полагаемся на вызывающий код: иначе
 * через 365 дней (срок жизни refresh_token) канал отвалится молча.
 */
export async function tiktokAccessToken(creds: TikTokCredentials): Promise<string> {
  return (await tiktokAccessGrant(creds)).accessToken;
}

/** То же, что tiktokAccessToken, плюс выданные права (`scope` ответа, через
 *  запятую) — для суточной проверки прав (lib/tokenScopes.ts), 23.09.2026. */
export async function tiktokAccessGrant(creds: TikTokCredentials): Promise<{ accessToken: string; scopes: string[] }> {
  const res = await fetchWithRetry(
    "https://open.tiktokapis.com/v2/oauth/token/",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: creds.clientKey!,
        client_secret: creds.clientSecret!,
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken!,
      }).toString(),
    },
    PUBLISH_TIMEOUT_MS
  );
  const body = await readJson(res);
  const accessToken = body.access_token as string | undefined;
  const refreshToken = body.refresh_token as string | undefined;
  if (!res.ok || !accessToken || !refreshToken) {
    throw new Error(`Не удалось обновить токен TikTok: ${graphErrorMessage(body, `HTTP ${res.status}`)}`);
  }
  if (refreshToken !== creds.refreshToken) {
    try {
      await prisma.settings.update({ where: { id: "singleton" }, data: { tiktokRefreshToken: encryptSecret(refreshToken) } });
    } catch (err) {
      void logSystemError(
        "tiktok",
        `Обновлённый refresh_token TikTok не сохранён — канал отвалится досрочно: ${describeError(err)}`
      );
    }
  }
  return { accessToken, scopes: splitScopes(body.scope) };
}

export interface TikTokCreatorInfo {
  creatorAvatarUrl?: string;
  creatorUsername?: string;
  creatorNickname?: string;
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number;
}

/** `POST creator_info/query` — тело намеренно пустое ({}), лимит 20 запросов/мин
 *  на токен (см. кэш 60с в routes/tiktok.ts::GET /creator-info). */
export async function tiktokCreatorInfo(accessToken: string): Promise<TikTokCreatorInfo> {
  const res = await fetchWithRetry(
    "https://open.tiktokapis.com/v2/post/publish/creator_info/query/",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
      body: "{}",
    },
    PUBLISH_TIMEOUT_MS
  );
  const body = await readJson(res);
  const data = body.data as Record<string, unknown> | undefined;
  if (!res.ok || !data) {
    throw new Error(`Не удалось получить данные аккаунта TikTok: ${graphErrorMessage(body, `HTTP ${res.status}`)}`);
  }
  return {
    creatorAvatarUrl: data.creator_avatar_url as string | undefined,
    creatorUsername: data.creator_username as string | undefined,
    creatorNickname: data.creator_nickname as string | undefined,
    privacyLevelOptions: (data.privacy_level_options as string[] | undefined) ?? [],
    commentDisabled: Boolean(data.comment_disabled),
    duetDisabled: Boolean(data.duet_disabled),
    stitchDisabled: Boolean(data.stitch_disabled),
    maxVideoPostDurationSec: Number(data.max_video_post_duration_sec ?? 0),
  };
}

/** Текст, показываемый там, где видны результаты публикации (телеграм-квитанция
 *  монтажёру, журнал), когда прямая публикация не удалась и ролик ушёл в
 *  черновики TikTok запасным путём — см. tiktokPublishToInbox. */
const TIKTOK_INBOX_FALLBACK_NOTE = "ролик отправлен в черновики TikTok (Входящие), опубликовать нужно из приложения TikTok";

/** Чанки ПОСЛЕДОВАТЕЛЬНО (правило TikTok), каждый со своим Content-Range —
 *  общий код для прямой публикации и запасного пути через черновики
 *  (tiktokPublishToInbox), чтобы не копировать цикл дважды. */
async function tiktokUploadChunks(
  uploadUrl: string,
  videoBytes: Blob,
  chunkSize: number,
  totalChunkCount: number,
  videoSize: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  let offset = 0;
  for (let chunkIndex = 0; chunkIndex < totalChunkCount; chunkIndex++) {
    const isLast = chunkIndex === totalChunkCount - 1;
    const end = isLast ? videoSize : offset + chunkSize;
    const chunk = videoBytes.slice(offset, end);
    const uploadRes = await fetchWithRetry(
      uploadUrl,
      {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(chunk.size),
          "Content-Range": `bytes ${offset}-${end - 1}/${videoSize}`,
        },
        body: chunk,
      },
      TIKTOK_UPLOAD_TIMEOUT_MS
    );
    if (!uploadRes.ok) {
      const body = await readJson(uploadRes);
      return {
        ok: false,
        error: graphErrorMessage(body, `HTTP ${uploadRes.status}: загрузка чанка ${chunkIndex + 1}/${totalChunkCount} не удалась`),
      };
    }
    offset = end;
  }
  return { ok: true };
}

interface TikTokPollResult {
  /** undefined — опрос истёк (TIKTOK_STATUS_POLL_MAX_ATTEMPTS исчерпаны), но
   *  TikTok не сказал FAILED: ролик принят и дообрабатывается на его стороне,
   *  вызывающий код считает это успехом (см. договор задания). */
  status: "PUBLISH_COMPLETE" | "SEND_TO_USER_INBOX" | "FAILED" | undefined;
  failReason?: string;
  postId?: string;
}

/** Опрос статуса — до 2 минут, каждые 3с (см. константы выше). Общий для
 *  прямой публикации (ждёт PUBLISH_COMPLETE) и черновиков (ждёт
 *  SEND_TO_USER_INBOX) — само тело запроса и разбор ответа не зависят от пути. */
async function tiktokPollStatus(accessToken: string, publishId: string): Promise<TikTokPollResult> {
  for (let attempt = 0; attempt < TIKTOK_STATUS_POLL_MAX_ATTEMPTS; attempt++) {
    const statusRes = await fetchWithRetry(
      "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ publish_id: publishId }),
      },
      PUBLISH_TIMEOUT_MS
    );
    const statusBody = await readJson(statusRes);
    const statusData = statusBody.data as
      | { status?: string; fail_reason?: string; publicaly_available_post_id?: string[] }
      | undefined;
    const status = statusData?.status;
    if (status === "PUBLISH_COMPLETE" || status === "SEND_TO_USER_INBOX" || status === "FAILED") {
      return { status, failReason: statusData?.fail_reason, postId: statusData?.publicaly_available_post_id?.[0] };
    }
    if (attempt < TIKTOK_STATUS_POLL_MAX_ATTEMPTS - 1) await sleep(TIKTOK_STATUS_POLL_INTERVAL_MS);
  }
  return { status: undefined };
}

/**
 * Запасной путь — загрузка в черновики TikTok (inbox), а не в ленту. Пробуется
 * ОДИН раз, только когда прямая публикация упала со статусом FAILED и
 * fail_reason === "internal" (см. publishTikTokVideo) — в Sandbox прямая
 * публикация (video/publish/init) стабильно падает на этом коде уже после
 * загрузки чанков, а инбокс тем же видео проходит и доезжает до
 * SEND_TO_USER_INBOX (ролик во «Входящих» TikTok, владелец дооформляет в
 * приложении). Тело INIT здесь без post_info (черновик не публикуется, поэтому
 * privacy/duet/comment/stitch/обложка приложению не нужны) и с областью
 * video.upload вместо video.publish.
 */
async function tiktokPublishToInbox(
  accessToken: string,
  videoBytes: Blob,
  videoSize: number,
  chunkSize: number,
  totalChunkCount: number
): Promise<{ ok: true } | { ok: false; error: string; retriable?: boolean }> {
  const initRes = await fetchWithRetry(
    "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({
        source_info: {
          source: "FILE_UPLOAD",
          video_size: videoSize,
          chunk_size: chunkSize,
          total_chunk_count: totalChunkCount,
        },
      }),
    },
    PUBLISH_TIMEOUT_MS
  );
  const initBody = await readJson(initRes);
  const initData = initBody.data as { publish_id?: string; upload_url?: string } | undefined;
  const initError = initBody.error as { code?: string; message?: string } | undefined;
  if (!initRes.ok || !initData?.publish_id || !initData.upload_url) {
    return {
      ok: false,
      error: tiktokErrorMessage(
        initError?.code,
        initError?.message ?? `HTTP ${initRes.status}: не удалось начать загрузку в черновики`
      ),
      // Именно сюда прилетел `spam_risk_too_many_pending_share` 22.09.2026: пока
      // ревью приложения не пройдено, ВСЕ ролики идут этим путём, и потолок в
      // пять неподтверждённых черновиков упирается первым.
      retriable: isTikTokRetriableCode(initError?.code),
    };
  }

  const uploadResult = await tiktokUploadChunks(initData.upload_url, videoBytes, chunkSize, totalChunkCount, videoSize);
  if (!uploadResult.ok) return uploadResult;

  const pollResult = await tiktokPollStatus(accessToken, initData.publish_id);
  if (pollResult.status === "SEND_TO_USER_INBOX") return { ok: true };
  if (pollResult.status === "FAILED") {
    return {
      ok: false,
      error: pollResult.failReason
        ? `TikTok отклонил загрузку в черновики: ${pollResult.failReason}`
        : "TikTok отклонил загрузку в черновики",
    };
  }
  // Опрос истёк, не FAILED — тот же принцип, что у прямой публикации: считаем успехом.
  return { ok: true };
}

/** ≤10 минут — тот же порядок, что у автомонтажных операций ffmpeg в проекте
 *  (extractCoverFrame — 20с для одного кадра, тут целый ролик перекодируется). */
const TIKTOK_TRANSCODE_TIMEOUT_MS = 10 * 60_000;

interface TikTokVideoStreamInfo {
  codec: string;
  width: number;
  height: number;
}

/** codec_name/width/height первого видеопотока через ffprobe (обёртка
 *  lib/ffmpeg.ts — не заводим новый способ вызова, используем существующий).
 *  null — ffprobe недоступен или файл не читается: вызывающий код (
 *  tiktokPrepareUploadPath) в этом случае грузит файл как есть, без перекодировки. */
async function tiktokProbeVideoStream(inputPath: string): Promise<TikTokVideoStreamInfo | null> {
  const result = await tryRunFfmpeg({
    bin: "ffprobe",
    label: "проверка кодека и размера ролика для TikTok",
    timeoutMs: 15_000,
    captureStdout: true,
    args: [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height",
      "-of",
      "csv=s=,:p=0",
      inputPath,
    ],
  });
  if (!result) return null;
  const [codec, widthRaw, heightRaw] = result.stdout.trim().split(",");
  const width = Number.parseInt(widthRaw, 10);
  const height = Number.parseInt(heightRaw, 10);
  if (!codec || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  return { codec, width, height };
}

/**
 * HEVC → H.264 перед TikTok (17.09.2026): ролики от монтажёра приходят в H.265
 * (hevc) с нечётной шириной (пример живого файла — 1078) — TikTok такое
 * отклоняет. Перекодирует во временный файл РЯДОМ с исходным
 * (`<basename>-tiktok.mp4`), если codec_name != h264 ИЛИ ширина/высота
 * нечётные; иначе возвращает исходный путь как есть.
 *
 * -vf scale=…:-2 чинит ЧЁТНОСТЬ заодно с перекодировкой — отдельная проверка
 * "только нечётность, кодек уже h264" не нужна отдельной веткой: если решили
 * перекодировать, scale выравнивает оба измерения одним фильтром.
 *
 * ffprobe недоступен → грузим как есть (см. tiktokProbeVideoStream). ffmpeg
 * упал на самой перекодировке → тоже грузим оригинал: временный файл не
 * дописан наполовину, не оставляем его на диске.
 */
export async function tiktokPrepareUploadPath(inputPath: string): Promise<{ uploadPath: string; cleanup: () => Promise<void> }> {
  const noop = async () => {};
  const info = await tiktokProbeVideoStream(inputPath);
  if (!info) return { uploadPath: inputPath, cleanup: noop };

  const needsTranscode = info.codec !== "h264" || info.width % 2 !== 0 || info.height % 2 !== 0;
  if (!needsTranscode) return { uploadPath: inputPath, cleanup: noop };

  const ext = path.extname(inputPath);
  const outputPath = `${inputPath.slice(0, -ext.length || undefined)}-tiktok.mp4`;
  // Вертикальный ролик (обычный случай для TikTok/Reels в этом проекте) —
  // фиксируем ширину 1080, высота считается по пропорции; иначе наоборот.
  const scale = info.height >= info.width ? "1080:-2" : "-2:1080";
  try {
    await runFfmpeg({
      label: "перекодировка ролика под TikTok (HEVC/нечётный размер → H.264)",
      timeoutMs: TIKTOK_TRANSCODE_TIMEOUT_MS,
      args: [
        "-y",
        "-hide_banner",
        "-v",
        "error",
        "-i",
        inputPath,
        "-vf",
        `scale=${scale}`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        outputPath,
      ],
    });
    return { uploadPath: outputPath, cleanup: () => fs.rm(outputPath, { force: true }).then(() => {}) };
  } catch (err) {
    await fs.rm(outputPath, { force: true }).catch(() => {});
    void logSystemError(
      "tiktok",
      `Перекодировка ролика под TikTok не удалась, публикуем оригинал как есть: ${describeError(err)}`
    );
    return { uploadPath: inputPath, cleanup: noop };
  }
}

/**
 * Ключ в Property.publishedPostIds, под которым живёт `publish_id` незавершённой
 * загрузки в TikTok (22.09.2026). Отдельной колонки нет намеренно: миграции на
 * этом сервере накатываются руками (`ops/deploy.sh` их не запускает), а
 * publishedPostIds — уже существующее JSON-поле той же карточки, и все его
 * читатели (lib/publishedVideoFix.ts, lib/publishedListingSync.ts) берут ключи
 * по именам каналов поимённо, так что лишний ключ им не мешает. Метка живёт
 * только между загрузкой и исходом публикации — на любом определённом исходе
 * (опубликовано, отклонено) она стирается.
 */
const TIKTOK_PENDING_PUBLISH_ID_KEY = "TIKTOK_PENDING";
/** Когда метка поставлена — ISO-строкой рядом, тем же служебным ключом. */
const TIKTOK_PENDING_AT_KEY = "TIKTOK_PENDING_AT";
/**
 * СРОК ГОДНОСТИ МЕТКИ. `publish_id` живёт у TikTok недолго, а наш опрос длится
 * две минуты — метка старше часа означает не «продолжи опрос», а «тот заход
 * умер давно и разбираться с ним поздно». Без срока метка, оставшаяся от
 * исчерпавшего попытки задания, ждала бы неделями и на первой же ручной
 * публикации увела бы её в опрос протухшего идентификатора вместо загрузки.
 */
const TIKTOK_PENDING_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Чтение метки незавершённой попытки: её значение, если она свежая. Значение
 * бывает содержательным (`publish_id` у TikTok) или служебным («попытка
 * начата» у Facebook) — срок годности и хранилище у обеих одни.
 */
async function readPendingMarker(owner: MarksOwner, valueKey: string, atKey: string, maxAgeMs: number): Promise<string | null> {
  const marks = await readOwnerMarks(owner);
  const ids = (marks?.postIds ?? {}) as Record<string, string>;
  const value = ids[valueKey];
  if (!value) return null;
  const at = Date.parse(ids[atKey] ?? "");
  // Метка без времени — из версии до 22.09.2026 либо испорченная: считаем
  // протухшей, потому что доверять ей нечем. Загрузим заново, это честнее
  // опроса неизвестно чьего идентификатора.
  if (!Number.isFinite(at) || Date.now() - at > maxAgeMs) return null;
  return value;
}

/** Когда метка поставлена, если она свежая, — тем же сроком годности. */
async function readPendingMarkerAt(owner: MarksOwner, valueKey: string, atKey: string, maxAgeMs: number): Promise<Date | null> {
  const marks = await readOwnerMarks(owner);
  const ids = (marks?.postIds ?? {}) as Record<string, string>;
  if (!ids[valueKey]) return null;
  const at = Date.parse(ids[atKey] ?? "");
  if (!Number.isFinite(at) || Date.now() - at > maxAgeMs) return null;
  return new Date(at);
}

/** `value === null` — стереть метку. Читает-меняет-пишет: карточка в этот
 *  момент правится только публикацией того же объекта, каналы идут по очереди. */
async function writePendingMarker(owner: MarksOwner, valueKey: string, atKey: string, value: string | null): Promise<void> {
  // Условная запись по свежей карточке (lib/publishedMarks.ts, аудит 04.10.2026, PUB07):
  // метка пишется посреди публикации, когда рядом пишут другие каналы.
  await updateOwnerMarks(owner, (current) => {
    const ids = { ...current.postIds };
    if (value === null) {
      if (!(valueKey in ids) && !(atKey in ids)) return null;
      delete ids[valueKey];
      delete ids[atKey];
    } else {
      ids[valueKey] = value;
      ids[atKey] = new Date().toISOString();
    }
    return { channels: current.channels, postIds: ids };
  });
}

/**
 * Слить результаты публикации в дополнительные чаты Telegram в
 * `publishedPostIds.TELEGRAM_EXTRA` (26.09.2026) — читает-меняет-пишет, тем же
 * приёмом, что и writePendingMarker выше (каналы одного объекта публикуются
 * последовательно, гонки внутри одного захода нет). Не трогает остальные
 * ключи publishedPostIds — они дописываются отдельно, applySucceededPublishResults
 * (videoHandoff.ts) читает эту запись заново и сохраняет её при своей записи.
 */
async function mergeTelegramExtraPostIds(owner: MarksOwner, extraPostIds: Record<string, string>): Promise<void> {
  if (Object.keys(extraPostIds).length === 0) return;
  await updateOwnerMarks(owner, (current) => {
    const existingExtra = (current.postIds.TELEGRAM_EXTRA ?? {}) as Record<string, string>;
    return { channels: current.channels, postIds: { ...current.postIds, TELEGRAM_EXTRA: { ...existingExtra, ...extraPostIds } } };
  });
}

const readTikTokPendingPublishId = (owner: MarksOwner) =>
  readPendingMarker(owner, TIKTOK_PENDING_PUBLISH_ID_KEY, TIKTOK_PENDING_AT_KEY, TIKTOK_PENDING_MAX_AGE_MS);
const writeTikTokPendingPublishId = (owner: MarksOwner, publishId: string | null) =>
  writePendingMarker(owner, TIKTOK_PENDING_PUBLISH_ID_KEY, TIKTOK_PENDING_AT_KEY, publishId);

/**
 * ОТПРАВИЛИ, НО ОТВЕТА НЕ ДОЖДАЛИСЬ — ТОТ ЖЕ КЛАСС, ЧТО У TIKTOK (22.09.2026).
 *
 * `POST /{page-id}/videos` не идемпотентен, и поэтому у него намеренно нет
 * повтора (см. докстринг publishFacebookVideo). Но повтор есть ВЫШЕ: задание
 * публикации живёт до шести попыток (VIDEO_HANDOFF_PUBLISH_MAX_ATTEMPTS), а
 * сторож догоняет оборвавшиеся публикации сам. Обрыв ответа — рестарт
 * контейнера по мержу в main, таймаут в 60 секунд — не означает «не дошло»:
 * Meta могла принять запрос и доварить его уже без нас. Тогда канал не попадал
 * в publishedChannels, следующая попытка постила ролик ЗАНОВО, и на публичной
 * странице агентства висело два одинаковых видео.
 *
 * Метка ставится ПЕРЕД отправкой и снимается на любом определённом исходе
 * (опубликовано, отказ с ответом). Осталась — значит исход неизвестен, и
 * следующая попытка сперва спрашивает у страницы, не появилось ли там уже
 * наше видео.
 */
const FACEBOOK_PENDING_KEY = "FACEBOOK_PENDING";
/** Когда метка поставлена — ISO-строкой рядом, тем же служебным ключом. */
const FACEBOOK_PENDING_AT_KEY = "FACEBOOK_PENDING_AT";
/**
 * Срок годности метки. Шире тиктоковского часа: Meta доваривает загруженное по
 * ссылке видео дольше, а сторож незавершённых публикаций ходит редко. Больше
 * суток держать нечего — к тому времени за карточку возьмётся человек.
 */
const FACEBOOK_PENDING_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** Сколько последних видео страницы просматриваем в поисках своего. */
const FACEBOOK_RECENT_VIDEOS_LIMIT = 10;
/**
 * Запас назад от времени метки: она ставится ДО отправки, но у Meta своё время
 * и своя задержка, и видео может быть отмечено минутой раньше нашей метки.
 */
const FACEBOOK_RECENT_VIDEOS_SLACK_MS = 10 * 60 * 1000;

/**
 * АДРЕС СЕССИИ ЗАГРУЗКИ В YOUTUBE (22.09.2026) — тот же класс. Загрузка Shorts
 * идёт возобновляемой сессией: сперва init отдаёт адрес, потом в него едут
 * мегабайты (окно до пяти минут). Обрыв внутри окна означал, что следующая
 * попытка заводила НОВУЮ сессию и грузила ролик второй раз — а первая могла
 * к тому времени дойти, и на канале оказывалось два одинаковых Shorts.
 * Адрес сессии — сама ручка повтора: сколько раз в неё ни лей, видео выйдет
 * одно. Живёт метка от начала загрузки до ответа.
 */
const YOUTUBE_PENDING_KEY = "YOUTUBE_PENDING";
/** Когда метка поставлена — ISO-строкой рядом, тем же служебным ключом. */
const YOUTUBE_PENDING_AT_KEY = "YOUTUBE_PENDING_AT";
/** Сессии Google живут неделю, но метка старше суток означает заброшенную
 *  карточку: к ней уже вернулся человек, а не повтор задания. */
const YOUTUBE_PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Видео страницы с ровно такой подписью, появившееся не раньше `since`, — то
 * самое, отправленное оборвавшейся попыткой. Сверяем описание целиком: подпись
 * содержит адрес, цену и площадь конкретного объекта, случайно совпасть ей не с
 * чем, а совпадение частичное дало бы ложное «уже опубликовано» соседней
 * карточке того же дома. Отказ запроса — не беда: вернём null, и попытка пойдёт
 * обычным путём (лучше возможный дубль, чем потерянная публикация).
 */
async function findRecentFacebookVideo(
  ownerTextCap: string,
  pageId: string,
  token: string,
  caption: string,
  since: Date
): Promise<string | null> {
  try {
    const url =
      `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/videos` +
      `?fields=id,description,created_time&limit=${FACEBOOK_RECENT_VIDEOS_LIMIT}` +
      `&access_token=${encodeURIComponent(token)}`;
    // Явный таймаут обязателен (правило репозитория про внешние вызовы): без
    // него зависший ответ Facebook подвесил бы саму публикацию.
    const res = await fetchWithRetry(url, {}, PUBLISH_TIMEOUT_MS);
    const body = await readJson(res);
    if (!res.ok) {
      void logSystemError(
        "meta",
        `${ownerTextCap}: не удалось спросить страницу, не опубликовано ли видео прошлой попыткой — ${graphErrorMessage(body, `HTTP ${res.status}`)}`
      );
      return null;
    }
    const items = (body.data as Array<{ id?: string; description?: string; created_time?: string }> | undefined) ?? [];
    const earliest = since.getTime() - FACEBOOK_RECENT_VIDEOS_SLACK_MS;
    for (const item of items) {
      if (!item.id || item.description !== caption) continue;
      const createdAt = Date.parse(item.created_time ?? "");
      if (Number.isFinite(createdAt) && createdAt < earliest) continue;
      return item.id;
    }
    return null;
  } catch (err) {
    // Молча возвращать null нельзя: отказ внешнего вызова обязан попасть в
    // журнал (правило репозитория). Публикацию это не роняет — пойдём обычным
    // путём, рискуя дублем, и в журнале будет сказано, почему.
    void logSystemError(
      "meta",
      `${ownerTextCap}: не удалось спросить страницу, не опубликовано ли видео прошлой попыткой — ${describeError(err)}`
    );
    return null;
  }
}

/**
 * ЗАГРУЗКА УЖЕ ПРОИЗОШЛА — ДАЛЬШЕ ТОЛЬКО ОЖИДАНИЕ (22.09.2026, класс «страховка
 * ставится ПОСЛЕ окна, которое должна страховать»). Ролик едет в TikTok кусками
 * (мегабайты), а после загрузки идёт опрос статуса — до двух минут. Точка
 * невозврата — конец загрузки: с этого момента TikTok опубликует ролик сам, чем
 * бы ни кончился наш опрос. Рестарт внутри опроса (автовыкат идёт по каждому
 * мержу в main) означал, что CRM про эту публикацию не знает НИЧЕГО, и повтор
 * задания загружал тот же ролик ещё раз — второй живой пост в TikTok, который
 * «нельзя развидеть».
 *
 * `onUploadAccepted` зовётся ровно в этой точке, с `publish_id`; вызывающий код
 * запоминает его, а на следующей попытке передаёт обратно в `resumePublishId` —
 * и тогда загрузка не повторяется, продолжается только опрос.
 *
 * В режиме продолжения запасной путь через черновики (tiktokPublishToInbox)
 * НЕДОСТУПЕН намеренно: у него нет байтов ролика, читать файл заново ради
 * второй загрузки — это ровно тот дубль, от которого всё это и защищает.
 */
export interface TikTokPublishHooks {
  /** `publish_id` прошлой попытки: загрузка пропускается, продолжается опрос. */
  resumePublishId?: string | null;
  /** Точка невозврата — ролик у TikTok, дальше только ожидание. */
  onUploadAccepted?: (publishId: string) => Promise<void>;
}

/**
 * Публикация в TikTok — Content Posting API, FILE_UPLOAD (TikTok по ссылке
 * качает только с верифицированного домена — этого мы не делаем, см. задание).
 * Как publishYouTubeShort принимает ЛОКАЛЬНЫЙ путь, не публичный URL.
 *
 * ДЛИНА РОЛИКА против max_video_post_duration_sec: на 17.09.2026 в lib/video/*
 * не нашлось готового ffprobe-помощника — проверка длины сознательно пропущена
 * (см. отчёт задания); TikTok сам отклонит слишком длинный ролик на init.
 *
 * ЗАПАСНОЙ ПУТЬ ЧЕРЕЗ ЧЕРНОВИКИ (17.09.2026, проверено в Sandbox): если прямая
 * публикация дошла до статуса FAILED с fail_reason "internal", один раз
 * пробуем инбокс (tiktokPublishToInbox) — см. комментарий там. Любая другая
 * причина отказа — без повтора, как раньше.
 *
 * HEVC/нечётный размер (17.09.2026): перед загрузкой видео проходит через
 * tiktokPrepareUploadPath — см. её комментарий.
 */
export async function publishTikTokVideo(
  creds: TikTokCredentials,
  prefs: TikTokPostPrefs,
  localVideoPath: string,
  caption: string,
  hooks?: TikTokPublishHooks
): Promise<PublishResult> {
  // Ролик у TikTok (загрузка принята сейчас либо прошлой попыткой): любой сбой дальше —
  // «исход неизвестен», а не отказ (см. PublishResult.outcomeUnknown).
  let uploadAccepted = Boolean(hooks?.resumePublishId);
  try {
    if (!creds.clientKey || !creds.clientSecret || !creds.refreshToken) {
      return { channel: "TIKTOK", ok: false, error: "TikTok не настроен (нет client_key/client_secret/refresh_token в Настройках)" };
    }
    if (!prefs.privacyLevel) {
      return { channel: "TIKTOK", ok: false, error: "Не выбран уровень приватности TikTok — выберите его в Настройках → Каналы связи" };
    }
    const accessToken = await tiktokAccessToken(creds);

    // ПРОДОЛЖЕНИЕ ПРОШЛОЙ ПОПЫТКИ — ролик уже у TikTok, грузить его повторно
    // нельзя (см. TikTokPublishHooks). Ни creatorInfo, ни перекодировка, ни
    // чтение файла здесь не нужны: остался только опрос статуса.
    if (hooks?.resumePublishId) {
      const resumed = await tiktokPollStatus(accessToken, hooks.resumePublishId);
      if (resumed.status === "FAILED") {
        return {
          channel: "TIKTOK",
          ok: false,
          error: resumed.failReason
            ? `TikTok отклонил публикацию: ${resumed.failReason}`
            : "TikTok отклонил публикацию",
        };
      }
      if (resumed.status === "SEND_TO_USER_INBOX") {
        return { channel: "TIKTOK", ok: true, note: TIKTOK_INBOX_FALLBACK_NOTE };
      }
      if (resumed.status === undefined) {
        // ОПРОС НИЧЕГО НЕ СКАЗАЛ — И ЭТО НЕ УСПЕХ, в отличие от обычного пути
        // ниже. Там мы САМИ только что загрузили ролик и знаем, что он у
        // TikTok; здесь мы знаем только чужой `publish_id`, и молчание статуса
        // с тем же успехом означает, что он давно протух. Счесть это успехом
        // значило бы отметить канал опубликованным без поста — ровно та тихая
        // ложь, от которой вся эта правка.
        return {
          channel: "TIKTOK",
          ok: false,
          error: "TikTok не сказал, чем кончилась прошлая загрузка (идентификатор мог истечь) — попробуйте опубликовать заново",
          // Метка остаётся до конца срока годности: ещё одна попытка продолжит опрос.
          outcomeUnknown: true,
        };
      }
      // PUBLISH_COMPLETE — публикация прошла ещё в прошлый заход.
      return { channel: "TIKTOK", ok: true, postId: resumed.postId };
    }

    const info = await tiktokCreatorInfo(accessToken);
    if (!info.privacyLevelOptions.includes(prefs.privacyLevel)) {
      return {
        channel: "TIKTOK",
        ok: false,
        error: `Аккаунт TikTok не разрешает уровень «${prefs.privacyLevel}» — выберите другой в Настройках`,
      };
    }

    // HEVC → H.264 (17.09.2026): ролики монтажёра приходят в H.265 с нечётной
    // шириной (пример: 1078) — TikTok такое не принимает. tiktokPrepareUploadPath
    // ниже перекодирует во временный файл, если нужно, и возвращает функцию
    // очистки — дождаться её ОБЯЗАТЕЛЬНО после публикации (успешной или нет),
    // иначе временные файлы копятся на диске (finally ниже).
    const { uploadPath, cleanup } = await tiktokPrepareUploadPath(localVideoPath);
    try {
      const videoBytes = await videoBlob(uploadPath);
      const videoSize = videoBytes.size;
      const { chunkSize, totalChunkCount } = tiktokChunkPlan(videoSize);

      const initRes = await fetchWithRetry(
        "https://open.tiktokapis.com/v2/post/publish/video/init/",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
          body: JSON.stringify({
            post_info: {
              title: caption.slice(0, 2200),
              privacy_level: prefs.privacyLevel,
              disable_duet: !prefs.allowDuet,
              disable_comment: !prefs.allowComments,
              disable_stitch: !prefs.allowStitch,
              // Та же секунда 1.5, что у extractCoverFrame (videoHandoff.ts) —
              // обложку отдельным файлом TikTok не принимает, только timestamp.
              video_cover_timestamp_ms: 1500,
              brand_content_toggle: prefs.brandMode === "BRANDED",
              brand_organic_toggle: prefs.brandMode === "ORGANIC",
              is_aigc: false,
            },
            source_info: {
              source: "FILE_UPLOAD",
              video_size: videoSize,
              chunk_size: chunkSize,
              total_chunk_count: totalChunkCount,
            },
          }),
        },
        PUBLISH_TIMEOUT_MS
      );
      const initBody = await readJson(initRes);
      const initData = initBody.data as { publish_id?: string; upload_url?: string } | undefined;
      const initError = initBody.error as { code?: string; message?: string } | undefined;
      if (!initRes.ok || !initData?.publish_id || !initData.upload_url) {
        // До аудита приложения TikTok прямая публикация возможна только в
        // ПРИВАТНЫЙ аккаунт (17.09.2026: владелец вернул аккаунт в открытый, и
        // init сразу отвечает этим кодом). Черновики (inbox) от приватности не
        // зависят — тот же запасной путь, что и при FAILED/internal ниже, чтобы
        // ролик не пропадал, пока ревью не пройдено.
        if (initError?.code === "unaudited_client_can_only_post_to_private_accounts") {
          const inboxResult = await tiktokPublishToInbox(accessToken, videoBytes, videoSize, chunkSize, totalChunkCount);
          if (inboxResult.ok) {
            return { channel: "TIKTOK", ok: true, note: TIKTOK_INBOX_FALLBACK_NOTE };
          }
          return { channel: "TIKTOK", ok: false, error: inboxResult.error, retriable: inboxResult.retriable };
        }
        return {
          channel: "TIKTOK",
          ok: false,
          error: tiktokErrorMessage(initError?.code, initError?.message ?? `HTTP ${initRes.status}: не удалось начать загрузку`),
          retriable: isTikTokRetriableCode(initError?.code),
        };
      }

      const uploadResult = await tiktokUploadChunks(initData.upload_url, videoBytes, chunkSize, totalChunkCount, videoSize);
      if (!uploadResult.ok) {
        return { channel: "TIKTOK", ok: false, error: uploadResult.error };
      }

      // ТОЧКА НЕВОЗВРАТА — ролик у TikTok (см. TikTokPublishHooks выше).
      uploadAccepted = true;
      await hooks?.onUploadAccepted?.(initData.publish_id);

      const pollResult = await tiktokPollStatus(accessToken, initData.publish_id);

      if (pollResult.status === "PUBLISH_COMPLETE") {
        const postId = pollResult.postId;
        return {
          channel: "TIKTOK",
          ok: true,
          postId,
          permalink: postId && info.creatorUsername ? `https://www.tiktok.com/@${info.creatorUsername}/video/${postId}` : undefined,
        };
      }

      if (pollResult.status === "FAILED") {
        if (pollResult.failReason === "internal") {
          const inboxResult = await tiktokPublishToInbox(accessToken, videoBytes, videoSize, chunkSize, totalChunkCount);
          if (inboxResult.ok) {
            return { channel: "TIKTOK", ok: true, note: TIKTOK_INBOX_FALLBACK_NOTE };
          }
          return { channel: "TIKTOK", ok: false, error: inboxResult.error, retriable: inboxResult.retriable };
        }
        return {
          channel: "TIKTOK",
          ok: false,
          error: pollResult.failReason ? `TikTok отклонил публикацию: ${pollResult.failReason}` : "TikTok отклонил публикацию",
        };
      }

      // Опрос истёк, но TikTok не сказал FAILED — ролик принят и дообрабатывается
      // на стороне TikTok, это не отказ (см. договор задания).
      return { channel: "TIKTOK", ok: true };
    } finally {
      await cleanup();
    }
  } catch (err) {
    return { channel: "TIKTOK", ok: false, error: describeError(err), ...(uploadAccepted ? { outcomeUnknown: true } : {}) };
  }
}

/**
 * THREADS (Meta) — шестой канал автопубликации (23.09.2026,
 * docs/agent-briefs/threads-channel-23-09.md). Хост graph.threads.net,
 * версия допускает "v1.0" — задан одной константой с переопределением через
 * `THREADS_GRAPH_BASE`, потому что доступность хоста с нашего VPS не
 * проверена (graph.instagram.com оттуда недоступен, graph.facebook.com
 * доступен, см. комментарий в messengers/meta.ts). Токен идёт параметром
 * запроса, как у Facebook/Instagram в этом файле, а не через
 * instagramRequest/instagramApiUrl — те функции адресуют ИМЕННО
 * graph.instagram.com через прокси, Threads это другой продукт Meta.
 */
export const THREADS_GRAPH_BASE = process.env.THREADS_GRAPH_BASE?.trim() || "https://graph.threads.net";

export interface ThreadsCredentials {
  userId?: string;
  accessToken?: string;
}

/** Предел Threads на текст поста. */
const THREADS_CAPTION_MAX = 500;

/**
 * Подпись под лимит Threads (500 символов) — обрезает ЦЕЛЫМИ строками с конца,
 * но последнюю строку с номерами (CONTACT_NUMBERS, см. reelsCaptionTemplate.ts)
 * сохраняет ВСЕГДА: она не считается «телом» подписи для целей обрезки.
 * Короткая подпись (≤500) возвращается как есть — не трогаем чужую вёрстку
 * переносов строк без нужды. Чистая функция — своя, потому что существующий
 * приём в файле (`caption.slice(0, N)`, см. igCaption в publishApprovedPost)
 * режет посреди строки и мог бы обрезать сам номер телефона пополам.
 */
export function threadsCaption(caption: string): string {
  if (caption.length <= THREADS_CAPTION_MAX) return caption;
  const lines = caption.split("\n");
  const lastLine = lines[lines.length - 1];
  const bodyLines = lines.slice(0, -1);
  // Бюджет на всё, КРОМЕ последней строки: сама строка и перевод строки перед
  // ней (если тело вообще есть) неприкосновенны.
  const budget = THREADS_CAPTION_MAX - lastLine.length - (bodyLines.length > 0 ? 1 : 0);
  if (budget <= 0) return lastLine.length <= THREADS_CAPTION_MAX ? lastLine : lastLine.slice(0, THREADS_CAPTION_MAX);
  const kept: string[] = [];
  let used = 0;
  for (const line of bodyLines) {
    const add = kept.length === 0 ? line.length : line.length + 1; // +1 — перевод строки перед этой строкой
    if (used + add > budget) break;
    kept.push(line);
    used += add;
  }
  const result = [...kept, lastLine].join("\n");
  return result.length <= THREADS_CAPTION_MAX ? result : result.slice(0, THREADS_CAPTION_MAX);
}

/** Ссылка на опубликованный пост — отдельным запросом, как fetchInstagramPermalink:
 *  `threads_publish` отдаёт только `{ id }`, permalink нужно спрашивать отдельно. */
async function fetchThreadsPermalink(postId: string, accessToken: string): Promise<string | null> {
  try {
    const res = await fetchWithRetry(
      `${THREADS_GRAPH_BASE}/v1.0/${postId}?fields=permalink&access_token=${encodeURIComponent(accessToken)}`,
      {},
      PUBLISH_TIMEOUT_MS
    );
    const body = await readJson(res);
    return (body.permalink as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Публикация видео в Threads — тот же двухшаговый протокол, что у Instagram
 * Reels (контейнер → опрос готовности → publish → permalink), переиспользует
 * ту же лесенку таймаутов (CONTAINER_POLL_INTERVALS_MS): довод «Meta нигде не
 * публикует SLA обработки контейнера» относится к площадке в целом, не только
 * к Instagram. ГЛАВНОЕ ОТЛИЧИЕ ОТ INSTAGRAM: поле опроса называется `status`,
 * а НЕ `status_code` — Threads отвечает ошибкой на незнакомое поле в fields=,
 * в отличие от Instagram, который его просто не содержит в ответе.
 *
 * Контейнер (POST /threads) и сама публикация (POST /threads_publish) — БЕЗ
 * fetchWithRetry, тем же доводом, что publishFacebookVideo: обе операции
 * создают объект на площадке и не идемпотентны, повтор на таймауте дал бы
 * дубль поста. Опрос статуса, чтение permalink и удаление — идемпотентны,
 * через fetchWithRetry.
 */
export async function publishThreadsVideo(creds: ThreadsCredentials, videoUrl: string, caption: string): Promise<PublishResult> {
  if (!creds.userId || !creds.accessToken) {
    return { channel: "THREADS", ok: false, error: "Threads не подключён" };
  }
  const userId = creds.userId;
  const accessToken = creds.accessToken;
  try {
    const createRes = await fetch(`${THREADS_GRAPH_BASE}/v1.0/${userId}/threads`, {
      method: "POST",
      // Форма, а не JSON: примеры в документации Threads передают параметры
      // строкой запроса, form-urlencoded Graph API принимает наравне с ней.
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ media_type: "VIDEO", video_url: videoUrl, text: threadsCaption(caption), access_token: accessToken }).toString(),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    const createBody = await readJson(createRes);
    const containerId = createBody.id as string | undefined;
    if (!createRes.ok || !containerId) {
      return { channel: "THREADS", ok: false, error: graphErrorMessage(createBody, `HTTP ${createRes.status}`) };
    }

    let finished = false;
    for (let attempt = 0; attempt < CONTAINER_POLL_INTERVALS_MS.length; attempt++) {
      const statusRes = await fetchWithRetry(
        `${THREADS_GRAPH_BASE}/v1.0/${containerId}?fields=status,error_message&access_token=${encodeURIComponent(accessToken)}`,
        {},
        PUBLISH_TIMEOUT_MS
      );
      const statusBody = await readJson(statusRes);
      const status = statusBody.status as string | undefined;
      if (status === "FINISHED") {
        finished = true;
        break;
      }
      if (status === "ERROR" || status === "EXPIRED") {
        const message = (statusBody.error_message as string | undefined) ?? `Threads вернул статус ${status}`;
        return { channel: "THREADS", ok: false, error: message };
      }
      await sleep(CONTAINER_POLL_INTERVALS_MS[attempt]);
    }
    if (!finished) {
      // Контейнер, вероятно, ещё жив (см. PublishResult.pending — тот же смысл,
      // что у Instagram), но своего фонового дозавершения (аналог
      // lib/instagramPendingContainers.ts) для Threads НЕТ — решение по
      // умолчанию этой правки, см. отчёт задания: контейнер просто не
      // довершится сам, повторная публикация объекта уйдёт вторым постом.
      return { channel: "THREADS", ok: false, pending: true, error: "Видео не обработалось за отведённое время ожидания" };
    }

    const publishRes = await fetch(`${THREADS_GRAPH_BASE}/v1.0/${userId}/threads_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ creation_id: containerId, access_token: accessToken }).toString(),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    const publishBody = await readJson(publishRes);
    const postId = publishBody.id as string | undefined;
    if (!publishRes.ok || !postId) {
      return { channel: "THREADS", ok: false, error: graphErrorMessage(publishBody, `HTTP ${publishRes.status}`) };
    }
    const permalink = await fetchThreadsPermalink(postId, accessToken);
    return { channel: "THREADS", ok: true, postId, ...(permalink ? { permalink } : {}) };
  } catch (err) {
    return { channel: "THREADS", ok: false, error: describeError(err) };
  }
}

/** Продлевать имеет смысл только токену старше суток и ещё живому — младше суток
 *  Threads отвечает отказом, а 60 дней БЕЗ использования токен умирает навсегда
 *  (см. задание). Продлеваем с большим запасом — раз в сутки, когда до истечения
 *  осталось меньше 30 дней. Эталон — refreshInstagramTokenIfDue
 *  (messengers/instagramFeed.ts): та же идея, «продлить, пока жив», для другого
 *  продукта Meta. */
const THREADS_REFRESH_BEFORE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const THREADS_MIN_TOKEN_AGE_MS = 24 * 60 * 60 * 1000;

export async function refreshThreadsTokenIfDue(): Promise<{ refreshed: number; failed: number }> {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { threadsAccessToken: true, threadsTokenExpiresAt: true, threadsConnectedAt: true },
    });
    const accessToken = decryptSecretSafe(settings?.threadsAccessToken ?? null);
    if (!accessToken || !settings?.threadsTokenExpiresAt) return { refreshed: 0, failed: 0 };

    const expiresAt = settings.threadsTokenExpiresAt.getTime();
    const issuedAt = settings.threadsConnectedAt?.getTime() ?? 0;
    const tokenAgeMs = Date.now() - issuedAt;
    if (expiresAt - Date.now() > THREADS_REFRESH_BEFORE_EXPIRY_MS) return { refreshed: 0, failed: 0 };
    if (tokenAgeMs < THREADS_MIN_TOKEN_AGE_MS) return { refreshed: 0, failed: 0 };
    if (Date.now() >= expiresAt) {
      // Просрочен — обновлять поздно, Threads такой токен уже не примет.
      // Не отказ этой функции: checkThreadsTokenHealth сообщит об умершем
      // доступе отдельно, при следующей проверке «Здоровья системы».
      return { refreshed: 0, failed: 0 };
    }

    const url = `${THREADS_GRAPH_BASE}/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(accessToken)}`;
    const res = await fetchWithRetry(url, {}, PUBLISH_TIMEOUT_MS);
    const body = await readJson(res);
    const newToken = body.access_token as string | undefined;
    const expiresIn = body.expires_in as number | undefined;
    if (!res.ok || !newToken) {
      throw new Error(graphErrorMessage(body, `HTTP ${res.status}`));
    }
    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        threadsAccessToken: encryptSecret(newToken),
        threadsTokenExpiresAt: new Date(Date.now() + (expiresIn ?? 60 * 24 * 60 * 60) * 1000),
      },
    });
    return { refreshed: 1, failed: 0 };
  } catch (err) {
    void logSystemError("threads", `Токен Threads не продлён: ${describeError(err)}`);
    return { refreshed: 0, failed: 1 };
  }
}

/** Снять пост Threads (квота 100/сутки, см. задание) — редактирования текста
 *  Threads не поддерживает вовсе, только удаление. `isGhostObjectError`
 *  переиспользован: Threads — тот же Graph API по форме ответа об ошибке
 *  (`error.code`/`message`), что Facebook/Instagram. */
export async function deleteThreadsPost(accessToken: string, postId: string): Promise<DeleteResult> {
  try {
    const url = `${THREADS_GRAPH_BASE}/v1.0/${postId}?access_token=${encodeURIComponent(accessToken)}`;
    const res = await fetchWithRetry(url, { method: "DELETE" }, PUBLISH_TIMEOUT_MS);
    const body = await readJson(res);
    if (!res.ok) {
      if (isGhostObjectError(body)) return { ok: true, ghost: true };
      return { ok: false, error: graphErrorMessage(body, `HTTP ${res.status}`) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/**
 * Точка входа — публикует одобренный пост во все настроенные каналы (Meta
 * ключи уже введены и содержательны). Каждый канал независим: отказ одного не
 * прячет успех другого, вызывающий (роут одобрения) решает, что показать
 * модератору и что записать в publishedChannels.
 *
 * НЕ проверяет autoPublishEnabled сам — это решение вызывающего кода (роут),
 * здесь только механика самой публикации.
 */
export async function publishApprovedPost(params: {
  /** Хозяин публикации - ровно одно из двух: объект недвижимости ИЛИ свободный ролик. */
  propertyId?: string;
  freeVideoId?: string;
  localVideoPath: string;
  caption: string;
  /** Обложка (lib/video/coverPoster.ts) — необязательна: посты с упавшей
   *  генерацией обложки публикуются без неё прежним способом (Instagram
   *  сам выберет кадр по thumb_offset=0). */
  localCoverPath?: string | null;
  /** Квадрат 1080×1080 той же обложки (25.09.2026) — превью Facebook и YouTube. */
  localSquareCoverPath?: string | null;
  /** Каналы, куда пост УЖЕ ушёл (повтор после частичного отказа): их пропускаем —
   *  повторная публикация в живую ленту это дубль, который «нельзя развидеть». */
  skipChannels?: PublishChannel[];
  /**
   * ОТМЕТИТЬ КАНАЛ ОПУБЛИКОВАННЫМ СРАЗУ (22.09.2026, класс «страховка ставится
   * после окна, которое должна страховать»). Пять каналов публикуются по
   * очереди, и весь путь занимает минуты; до этой правки карточка узнавала обо
   * ВСЕХ успехах разом, только когда возвращался последний канал. Рестарт
   * посреди (автовыкат идёт по каждому мержу в main) терял память об уже
   * вышедших постах: `publishedChannels` пуст, повтор задания шёл в те же
   * каналы заново и вешал ДУБЛЬ живого поста — а его «нельзя развидеть», ровно
   * то, ради чего существует `skipChannels`.
   *
   * Вызывается после каждого успешного канала, до перехода к следующему.
   * Отказ самого колбэка не отменяет публикацию (пост уже висит) — он ложится
   * в журнал, а общий разбор в конце допишет карточку как раньше.
   */
  onChannelPublished?: (result: PublishResult) => Promise<void>;
  /**
   * Канал взят в работу (12.10.2026, экран «процесса» свободных роликов): зовётся ПЕРЕД
   * публикацией в канал, чтобы экран показал «публикуется» именно там, где идёт работа.
   * Отказ колбэка публикацию не отменяет.
   */
  onChannelStarted?: (channel: PublishChannel, destinationKey: string) => Promise<void>;
  /**
   * АККАУНТЫ ПО ВЫБОРУ (свободные ролики, 12.10.2026: «у нас два Instagram»). Не заданы — всё как у роликов
   * объектов: один аккаунт по умолчанию. Заданы — публикуем в каждый из списка по очереди, исход каждого со
   * своим `destinationKey`. Токен Instagram и chat_id Telegram подставляет вызывающий (сервис свободных роликов).
   */
  instagramTargets?: Array<{ key: string; token: string }>;
  telegramTargets?: Array<{ key: string; chatId: string }>;
  /** Адреса (ключи), которые уже вышли или не нужны, — их пропускаем внутри канала с несколькими аккаунтами. */
  skipKeys?: string[];
}): Promise<PublishResult[]> {
  if (Boolean(params.propertyId) === Boolean(params.freeVideoId)) {
    throw new Error("publishApprovedPost: нужно передать ровно одно из propertyId / freeVideoId");
  }
  const owner: MarksOwner = params.propertyId
    ? { kind: "property", id: params.propertyId }
    : { kind: "freeVideo", id: params.freeVideoId as string };
  // Как назвать хозяина в журнале. Для объекта тексты ровно прежние - по ним карточка
  // объекта находит ошибки каналов (routes/properties/list.ts::loadPublishErrorsByChannel).
  const ownerText = owner.kind === "property" ? `объект ${owner.id}` : `свободный ролик ${owner.id}`;
  const ownerTextCap = owner.kind === "property" ? `Объект ${owner.id}` : `Свободный ролик ${owner.id}`;
  const ownerTextGen = owner.kind === "property" ? `объекта ${owner.id}` : `свободного ролика ${owner.id}`;
  const skip = new Set(params.skipChannels ?? []);

  const skipKeys = new Set(params.skipKeys ?? []);

  async function noteStarted(channel: PublishChannel, destinationKey: string = channel): Promise<void> {
    if (!params.onChannelStarted) return;
    try {
      await params.onChannelStarted(channel, destinationKey);
    } catch (err) {
      void logSystemError("meta", `${ownerTextCap}: не удалось отметить начало публикации в ${channel}: ${describeError(err)}`);
    }
  }

  /** Пост уже висит — записать это в карточку немедленно (см. onChannelPublished). */
  async function notePublished(result: PublishResult): Promise<void> {
    if (!result.ok || !params.onChannelPublished) return;
    try {
      await params.onChannelPublished(result);
    } catch (err) {
      void logSystemError(
        "meta",
        `Публикация в ${result.channel} (${ownerText}) прошла, но отметить её в карточке сразу не удалось: ${describeError(err)}`
      );
    }
  }
  const videoUrl = publicUploadUrl(params.localVideoPath);
  // Обложка — фирменный постер поверх кадра ролика/главного фото объекта
  // (`lib/video/coverPoster.ts`, решение владельца 21.09.2026; приём готовой
  // обложки от монтажёра снят PR #622 — «обложки теперь делаем сами»),
  // считает videoHandoff.ts::publishHandoffResult ДО вызова этой функции,
  // здесь только публикуем то, что решили там. Переиспользование обложки
  // YouTube (16.09.2026) снято в
  // тот же день, что и заведено, — асинхронная генерация превью на стороне
  // YouTube делала ffmpeg-кадр то нужным, то нет, без единой причины отказа.
  const coverUrl = params.localCoverPath ? publicUploadUrl(params.localCoverPath) : null;
  // КАКАЯ ПЛОЩАДКА ПРИНИМАЕТ СВОЮ ОБЛОЖКУ (25.09.2026, «обложки везде, где можно»):
  // Instagram Reels — вертикаль, `cover_url`; Telegram — вертикаль файлом
  // `thumbnail`; Facebook — квадрат, `POST /{video-id}/thumbnails` после
  // публикации; YouTube — квадрат полями до 16:9, `thumbnails.set` после
  // загрузки (нужны право youtube.force-ssl и подтверждённый канал); TikTok —
  // нет, только кадр внутри ролика (`video_cover_timestamp_ms`). Отказ площадки
  // принять обложку — строка в журнале публикации, не отказ публикации.
  const squareAbsolutePath = params.localSquareCoverPath
    ? params.localSquareCoverPath.startsWith("/uploads/")
      ? path.join(uploadsDir, params.localSquareCoverPath.slice("/uploads/".length))
      : params.localSquareCoverPath
    : null;
  if (!videoUrl) {
    const error = "Не настроен CRM_PUBLIC_URL — Meta неоткуда забрать видео";
    void logSystemError("meta", `Публикация ${ownerTextGen} не удалась: ${error}`);
    // TELEGRAM в списке обязателен: без него модератор видел бы два отказа Meta и
    // не знал, что в канал тоже ничего не ушло. Сам Telegram с 20.09.2026 больше
    // не зависит от CRM_PUBLIC_URL (шлёт файл телом запроса, не ссылкой) — но эта
    // ранняя проверка не доходит и до YouTube/TikTok, тоже читающих с диска;
    // отвязать Telegram(-и остальных) от неё отдельным решением не входило в
    // задачу «мультипарт вместо ссылки», трогать шире не стали.
    return [
      { channel: "INSTAGRAM", ok: false, error },
      { channel: "FACEBOOK", ok: false, error },
      { channel: "TELEGRAM", ok: false, error },
      // THREADS — тем же доводом, что INSTAGRAM: берёт видео по публичной
      // ссылке (videoUrl), а не с диска, как YOUTUBE/TIKTOK ниже.
      { channel: "THREADS", ok: false, error },
    ].filter((r) => !skip.has(r.channel as PublishChannel)) as PublishResult[];
  }

  // Instagram режет подпись на 2200 символах и отклоняет создание контейнера
  // целиком, если длиннее, — а шаблоны допускают до 8000. Режем сами.
  // truncateCaptionSafely (26.09.2026, хештеги района в подписи) — не байт в
  // байт .slice(): хештеги теперь стоят последней строкой подписи, и голый
  // .slice(0, 2200) мог обрезать `#ИсмоилиСомони` посреди слова, оставив
  // недо-тег. Наши шаблоны с хештегами укладываются в лимит с большим запасом
  // (несколько сотен символов) — для них функция не отличается от .slice().
  const igCaption = truncateCaptionSafely(params.caption, 2200);

  const creds = await loadCredentials();
  const results: PublishResult[] = [];

  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      telegramChannelId: true,
      telegramExtraChatIds: true,
      youtubeClientId: true,
      youtubeClientSecret: true,
      youtubeRefreshToken: true,
      tiktokClientKey: true,
      tiktokClientSecret: true,
      tiktokRefreshToken: true,
      tiktokPrivacyLevel: true,
      tiktokAllowComments: true,
      tiktokAllowDuet: true,
      tiktokAllowStitch: true,
      tiktokBrandMode: true,
      threadsUserId: true,
      threadsAccessToken: true,
      instagramCollaborators: true,
    },
  });

  // YOUTUBE. В отличие от остальных каналов Google сам файл по ссылке не
  // скачивает — нужен ЛОКАЛЬНЫЙ путь, не публичный URL (см. докстринг
  // publishYouTubeShort). Отсутствие настроенных ключей — не отказ, канал
  // просто не подключён.
  const youtubeRefreshToken = decryptSecretSafe(settings?.youtubeRefreshToken ?? null);
  if (youtubeRefreshToken && !skip.has("YOUTUBE") && params.localVideoPath.startsWith("/uploads/")) {
    await noteStarted("YOUTUBE");
    const localAbsolutePath = path.join(uploadsDir, params.localVideoPath.slice("/uploads/".length));
    const youtubeCreds = {
      clientId: settings?.youtubeClientId ?? undefined,
      clientSecret: decryptSecretSafe(settings?.youtubeClientSecret ?? null) ?? undefined,
      refreshToken: youtubeRefreshToken,
    };
    const resumeUploadUrl = await readPendingMarker(
      owner,
      YOUTUBE_PENDING_KEY,
      YOUTUBE_PENDING_AT_KEY,
      YOUTUBE_PENDING_MAX_AGE_MS
    );
    const result = await publishYouTubeShort(youtubeCreds, localAbsolutePath, params.caption, {
      resumeUploadUrl,
      onUploadStarted: (uploadUrl) => writePendingMarker(owner, YOUTUBE_PENDING_KEY, YOUTUBE_PENDING_AT_KEY, uploadUrl),
      onAnswered: () => writePendingMarker(owner, YOUTUBE_PENDING_KEY, YOUTUBE_PENDING_AT_KEY, null),
      onResumeProblem: (message) =>
        void logSystemError(
          "youtube",
          `${ownerTextCap}: не удалось продолжить оборвавшуюся загрузку (${message}) — грузим ролик заново`
        ),
    });
    if (result.ok && result.postId && squareAbsolutePath) {
      appendNote(result, await setYouTubeThumbnail(youtubeCreds, result.postId, squareAbsolutePath));
    }
    results.push(result);
    await notePublished(result);
    if (!result.ok) {
      void logSystemError("youtube", `Публикация в YouTube Shorts (${ownerText}) не удалась: ${result.error}`);
    }
  }

  // Без явных аккаунтов — один, по умолчанию (как всегда); с явными — каждый из списка, кроме пропущенных.
  const igTargets: Array<{ key: string; token: string }> = params.instagramTargets
    ? skip.has("INSTAGRAM")
      ? []
      : params.instagramTargets.filter((t) => !skipKeys.has(t.key))
    : creds.igToken && !skip.has("INSTAGRAM")
      ? [{ key: "INSTAGRAM", token: creds.igToken }]
      : [];
  for (const igTarget of igTargets) {
    const igToken = igTarget.token;
    const igKey = params.instagramTargets ? igTarget.key : undefined;
    await noteStarted("INSTAGRAM", igTarget.key);
    const identity = await instagramTokenIdentity(igToken);
    if (identity.ok) {
      // Соавторы (26.09.2026): ник агента-хозяина объекта первым + до 3 ников
      // из Настроек. Запрос агента — только здесь, не выше: остальные каналы
      // (Facebook/Telegram/YouTube/TikTok) соавторов не знают и этот столбец
      // не читают.
      const property =
        owner.kind === "property"
          ? await prisma.property.findUnique({
              where: { id: owner.id },
              select: { intakeAgentId: true, assignedAgentId: true, createdById: true },
            })
          : null;
      const ownerAgentId = property ? propertyOwnerAgentId(property) : null;
      const ownerAgent = ownerAgentId
        ? await prisma.agent.findUnique({ where: { id: ownerAgentId }, select: { instagramUsername: true } })
        : null;
      const collaborators = instagramCollaboratorsFor({
        settingsRaw: settings?.instagramCollaborators ?? null,
        agentUsername: ownerAgent?.instagramUsername ?? null,
      });
      const result = await publishInstagramReel(
        owner.id,
        identity.id,
        igToken,
        videoUrl,
        igCaption,
        coverUrl,
        collaborators,
        owner.kind === "freeVideo" ? { ownerText, persistPendingContainer: false } : undefined
      );
      if (result.ok && result.postId) {
        result.permalink = (await fetchInstagramPermalink(result.postId, igToken)) ?? undefined;
      }
      if (igKey) result.destinationKey = igKey;
      results.push(result);
      await notePublished(result);
      // pending (случай №111) уже честно записан в журнал внутри
      // rememberInstagramContainer — свой, не начинающийся с «Публикация в»
      // текст (см. докстринг там же). Вторая запись здесь превратила бы
      // «обрабатывается» обратно в «не удалась».
      if (!result.ok && !result.pending) {
        void logSystemError("meta", `Публикация в Instagram (${ownerText}) не удалась: ${result.error}`);
      }
    } else {
      // ОБ-000113 (21.09.2026): эта ветка клала результат в `results`, но не звала
      // logSystemError — в отличие от соседней ветки (identity.ok && !result.ok)
      // и от остальных четырёх каналов ниже. Отказ был НЕВИДИМ: журнал ошибок
      // пуст, карточка молчит «На монтаже», объект простаивает ночь без единой
      // записи о причине. Тот же класс молчания, что закрывали в PR #585 для
      // снятия постов — здесь он остался на публикации.
      const error = `Не удалось определить аккаунт Instagram: ${identity.error}`;
      const failed: PublishResult = { channel: "INSTAGRAM", ok: false, error };
      if (igKey) failed.destinationKey = igKey;
      results.push(failed);
      void logSystemError("meta", `Публикация в Instagram (${ownerText}) не удалась: ${error}`);
    }
  }

  if (creds.pageToken && creds.pageId && !skip.has("FACEBOOK")) {
    await noteStarted("FACEBOOK");
    // ПРОШЛАЯ ПОПЫТКА ОБОРВАЛАСЬ, НЕ УЗНАВ СВОЕГО ИСХОДА (см. FACEBOOK_PENDING_KEY):
    // сперва спрашиваем страницу, не висит ли наше видео там уже, и только
    // потом постим. Иначе рестарт посреди отправки давал второй такой же пост.
    const pendingSince = await readPendingMarkerAt(
      owner,
      FACEBOOK_PENDING_KEY,
      FACEBOOK_PENDING_AT_KEY,
      FACEBOOK_PENDING_MAX_AGE_MS
    );
    const alreadyThere = pendingSince
      ? await findRecentFacebookVideo(ownerTextCap, creds.pageId, creds.pageToken, params.caption, pendingSince)
      : null;
    if (alreadyThere) {
      await writePendingMarker(owner, FACEBOOK_PENDING_KEY, FACEBOOK_PENDING_AT_KEY, null);
      const secondaryPostId = await fetchFacebookVideoPostId(alreadyThere, creds.pageToken);
      const adopted: PublishResult = {
        channel: "FACEBOOK",
        ok: true,
        postId: alreadyThere,
        ...(secondaryPostId ? { secondaryPostId } : {}),
        note: "Видео уже было опубликовано оборвавшейся попыткой — взяли существующий пост, второй не заводили",
      };
      results.push(adopted);
      await notePublished(adopted);
    } else {
      // Reels добавлен ПОВЕРХ видеопоста (решение владельца 26.09.2026,
      // publishFacebookVideo не тронут) — формат решает facebookFormatFor по
      // самому файлу: подходящую вертикаль отправляем в Reels (отдельная
      // лента, охват не зависит от подписчиков Страницы), остальное —
      // прежним видеопостом, как раньше.
      const localVideoAbsolutePath = params.localVideoPath.startsWith("/uploads/")
        ? path.join(uploadsDir, params.localVideoPath.slice("/uploads/".length))
        : params.localVideoPath;
      const format = facebookFormatFor(await probeMediaInfo(localVideoAbsolutePath));
      const facebookHooks: FacebookPublishHooks = {
        onAttemptStarted: () =>
          writePendingMarker(owner, FACEBOOK_PENDING_KEY, FACEBOOK_PENDING_AT_KEY, new Date().toISOString()),
        onAnswered: () => writePendingMarker(owner, FACEBOOK_PENDING_KEY, FACEBOOK_PENDING_AT_KEY, null),
      };
      const result =
        format === "REEL"
          ? await publishFacebookReel(creds.pageId, creds.pageToken, videoUrl, params.caption, facebookHooks)
          : await publishFacebookVideo(creds.pageId, creds.pageToken, videoUrl, params.caption, facebookHooks);
      if (result.ok && result.postId && squareAbsolutePath) {
        appendNote(result, await setFacebookVideoThumbnail(result.postId, creds.pageToken, squareAbsolutePath));
      }
      results.push(result);
      await notePublished(result);
      if (!result.ok) {
        void logSystemError("meta", `Публикация в Facebook (${ownerText}) не удалась: ${result.error}`);
      }
    }
  }

  // Telegram: основной канал + дополнительные чаты (26.09.2026, «ролик уходит
  // в несколько Telegram-групп»). ОСНОВНОЙ РАБОТАЕТ РОВНО КАК РАНЬШЕ — тот же
  // ключ (telegramChannelId), та же функция, тот же PublishResult; адрес пуст —
  // канал просто не настроен, это не отказ. Дополнительные чаты
  // (Settings.telegramExtraChatIds, lib/telegramChats.ts::parseTelegramChatIds)
  // публикуются ПОВЕРХ основного и не влияют на его исход — владелец 24.09.2026:
  // «нельзя ломать существующую логику».
  const channelId = settings?.telegramChannelId?.trim() || null;
  const extraChatIds = parseTelegramChatIds(settings?.telegramExtraChatIds ?? null, channelId);
  // Явно выбранные чаты (свободные ролики): каждый — свой адрес и свой исход, без сводного результата.
  if (params.telegramTargets && !skip.has("TELEGRAM")) {
    const tgDisk = (p: string) => (p.startsWith("/uploads/") ? path.join(uploadsDir, p.slice("/uploads/".length)) : p);
    const tgVideo = tgDisk(params.localVideoPath);
    const tgCover = params.localCoverPath ? tgDisk(params.localCoverPath) : null;
    for (const target of params.telegramTargets) {
      if (skipKeys.has(target.key)) continue;
      await noteStarted("TELEGRAM", target.key);
      const sent = await publishTelegramVideo(target.chatId, tgVideo, params.caption, tgCover);
      const tgResult: PublishResult = { ...sent, destinationKey: target.key };
      results.push(tgResult);
      await notePublished(tgResult);
      if (!tgResult.ok) {
        void logSystemError("telegram", `Публикация в Telegram ${target.chatId} (${ownerText}) не удалась: ${tgResult.error}`);
      }
    }
  }
  if ((channelId || extraChatIds.length > 0) && !skip.has("TELEGRAM") && !params.telegramTargets) {
    await noteStarted("TELEGRAM");
    // ТЕЛОМ ЗАПРОСА (20.09.2026) — Telegram читает ролик и обложку с диска, не по
    // своей же публичной ссылке (см. докстринг publishTelegramVideo): те же
    // локальные пути, что уже берут YouTube/TikTok выше, а не videoUrl/coverUrl.
    const localVideoAbsolutePath = params.localVideoPath.startsWith("/uploads/")
      ? path.join(uploadsDir, params.localVideoPath.slice("/uploads/".length))
      : params.localVideoPath;
    const localCoverAbsolutePath = params.localCoverPath
      ? params.localCoverPath.startsWith("/uploads/")
        ? path.join(uploadsDir, params.localCoverPath.slice("/uploads/".length))
        : params.localCoverPath
      : null;

    // ОСНОВНОЙ КАНАЛ — без изменений. Не настроен, но есть дополнительные чаты —
    // result ниже соберётся из их исхода, а не отсюда.
    let result: PublishResult | null = channelId
      ? await publishTelegramVideo(channelId, localVideoAbsolutePath, params.caption, localCoverAbsolutePath)
      : null;

    // ДОПОЛНИТЕЛЬНЫЕ ЧАТЫ — после основного (успешного или нет), тем же ботом и
    // той же функцией (publishTelegramVideo принимает любой chat_id, копировать
    // механику незачем). Отказ одного чата не прерывает остальные и не считается
    // отказом канала TELEGRAM — только запись в журнал на каждый отказ.
    if (extraChatIds.length > 0) {
      const extraPostIds: Record<string, string> = {};
      let extraOk = 0;
      let extraFail = 0;
      for (const chatId of extraChatIds) {
        const extraResult = await publishTelegramVideo(chatId, localVideoAbsolutePath, params.caption, localCoverAbsolutePath);
        if (extraResult.ok) {
          extraOk += 1;
          if (extraResult.postId) extraPostIds[chatId] = extraResult.postId;
        } else {
          extraFail += 1;
          void logSystemError(
            "telegram",
            `Публикация в дополнительный чат Telegram ${chatId} (${ownerText}) не удалась: ${extraResult.error}`
          );
        }
      }
      if (Object.keys(extraPostIds).length > 0) {
        await mergeTelegramExtraPostIds(owner, extraPostIds);
      }

      if (result) {
        // Основной канал уже дал свой PublishResult — дописываем только
        // заметку, исход дополнительных на result.ok не влияет.
        if (extraOk > 0 || extraFail > 0) {
          const parts: string[] = [];
          if (extraOk > 0) parts.push(`ещё в ${extraOk} чатов`);
          if (extraFail > 0) parts.push(`отказов ${extraFail}`);
          appendNote(result, parts.join(", "));
        }
      } else {
        // ОСНОВНОЙ КАНАЛ НЕ НАСТРОЕН — весь исход TELEGRAM собирается из
        // дополнительных: хоть один прошёл — публикация в Telegram есть
        // (publishedChannels получит TELEGRAM), publishedPostIds.TELEGRAM
        // остаётся пустым — редактировать/снимать у основного канала нечего.
        result =
          extraOk > 0
            ? {
                channel: "TELEGRAM",
                ok: true,
                note: `основной канал не настроен, опубликовано в ${extraOk} доп. чатов${extraFail > 0 ? `, отказов ${extraFail}` : ""}`,
              }
            : {
                channel: "TELEGRAM",
                ok: false,
                error: `Основной канал не настроен, ни один из ${extraChatIds.length} дополнительных чатов не принял публикацию`,
              };
      }
    }

    if (result) {
      results.push(result);
      await notePublished(result);
      if (!result.ok) {
        void logSystemError("telegram", `Публикация в канал Telegram (${ownerText}) не удалась: ${result.error}`);
      }
    }
  }

  // TIKTOK — пятым каналом (17.09.2026). Как и YouTube, качает файл сам сервер
  // (ЛОКАЛЬНЫЙ путь, не URL), поэтому то же условие на префикс "/uploads/".
  // Не настроено (нет refreshToken) — канал пропускается молча, как остальные.
  // Настроено, но tiktokPrivacyLevel не выбран — publishTikTokVideo вернёт
  // понятный ok:false сама (это ошибка настройки, её должно быть видно, а не
  // тихий пропуск).
  const tiktokRefreshToken = decryptSecretSafe(settings?.tiktokRefreshToken ?? null);
  if (tiktokRefreshToken && !skip.has("TIKTOK") && params.localVideoPath.startsWith("/uploads/")) {
    await noteStarted("TIKTOK");
    const localAbsolutePath = path.join(uploadsDir, params.localVideoPath.slice("/uploads/".length));
    const tiktokCreds: TikTokCredentials = {
      clientKey: settings?.tiktokClientKey ?? undefined,
      clientSecret: decryptSecretSafe(settings?.tiktokClientSecret ?? null) ?? undefined,
      refreshToken: tiktokRefreshToken,
    };
    const tiktokPrefs: TikTokPostPrefs = {
      privacyLevel: settings?.tiktokPrivacyLevel ?? null,
      allowComments: settings?.tiktokAllowComments ?? false,
      allowDuet: settings?.tiktokAllowDuet ?? false,
      allowStitch: settings?.tiktokAllowStitch ?? false,
      brandMode: (settings?.tiktokBrandMode as TikTokPostPrefs["brandMode"]) ?? "NONE",
    };
    // Метка незавершённой загрузки прошлой попытки (см. TikTokPublishHooks):
    // есть — продолжаем опрос, а не грузим ролик вторым заходом.
    const resumePublishId = await readTikTokPendingPublishId(owner);
    const result = await publishTikTokVideo(tiktokCreds, tiktokPrefs, localAbsolutePath, params.caption, {
      resumePublishId,
      onUploadAccepted: (publishId) => writeTikTokPendingPublishId(owner, publishId),
    });
    // Исход определён (опубликовано или отклонено) — метка больше не нужна;
    // оборвись процесс до этой строки, она бы и осталась, ради чего всё и есть.
    // Неизвестный исход (опрос ничего не сказал, сбой после загрузки) метку
    // СОХРАНЯЕТ: ролик у TikTok и может позже стать публичным, а следующая попытка
    // (срок годности метки час) продолжит опрос, а не загрузит ролик второй раз
    // (аудит 04.10.2026, PUB02).
    if (!result.outcomeUnknown) await writeTikTokPendingPublishId(owner, null);
    // Свою картинку TikTok не принимает — только кадр внутри ролика. Вклейка
    // обложки первым кадром — отдельное решение владельца, без него не делаем.
    if (result.ok && params.localCoverPath) appendNote(result, "TikTok свою обложку не принимает — взят кадр 1,5 с из ролика");
    results.push(result);
    await notePublished(result);
    if (!result.ok) {
      // Текст различается, потому что различается смысл. «Не удалась» — канал
      // сломан, нужен человек; «отложена» — TikTok сам попросил подождать, и
      // ролик уйдёт следующей попыткой (jobs/tiktokPublishRetry.ts). Оба
      // начинаются с «Публикация в» и содержат «TikTok»: карточка объекта
      // достаёт их по этим двум приметам
      // (routes/properties/list.ts::loadPublishErrorsByChannel), и менять
      // начало строки нельзя.
      void logSystemError(
        "tiktok",
        result.retriable
          ? `Публикация в TikTok (${ownerText}) отложена — площадка просит подождать: ${result.error}`
          : `Публикация в TikTok (${ownerText}) не удалась: ${result.error}`
      );
    }
  }

  // THREADS — шестым каналом (23.09.2026). Как Instagram, берёт видео по
  // публичной ссылке (videoUrl), а не с диска — своего условия на
  // "/uploads/" не требует. Не настроено (нет accessToken/userId) — канал
  // пропускается молча, как остальные непонастроенные каналы.
  const threadsAccessToken = decryptSecretSafe(settings?.threadsAccessToken ?? null);
  if (threadsAccessToken && settings?.threadsUserId && !skip.has("THREADS")) {
    await noteStarted("THREADS");
    const threadsCreds: ThreadsCredentials = { userId: settings.threadsUserId, accessToken: threadsAccessToken };
    const result = await publishThreadsVideo(threadsCreds, videoUrl, params.caption);
    results.push(result);
    await notePublished(result);
    // pending — контейнер, вероятно, ещё жив у Threads (см. докстринг
    // publishThreadsVideo) — тот же не-отказ, что у Instagram, вторая запись
    // в журнал была бы враньём «сломано» о том, что просто не успело.
    if (!result.ok && !result.pending) {
      void logSystemError("threads", `Публикация в Threads (${ownerText}) не удалась: ${result.error}`);
    }
  }

  return results;
}

/**
 * Суточная проверка живости refresh-токена YouTube.
 *
 * Зачем отдельная проверка, а не «узнаем при публикации»: публикации бывают
 * раз в несколько дней, и мёртвый токен обнаруживается только когда ролик уже
 * должен был выйти. Обмен refresh_token → access_token ничего не публикует и
 * не тратит квоту загрузки, поэтому его можно звать каждые сутки.
 *
 * Почему это вообще важно (11.09.2026): у неверифицированного приложения с
 * publishing status «Testing» Google убивает refresh-токен через 7 дней. Наш
 * проект стоит «In production», и по документации Google под это правило НЕ
 * попадает — но проверено это было только документацией, не фактом. Эта
 * проверка и есть факт: если правило всё-таки действует, в журнале ошибок
 * появится запись в тот же день, а не через неделю тишины.
 *
 * @returns `null` — интеграция не настроена; `true` — токен жив; `false` —
 *          токен мёртв, запись уже положена в журнал ошибок.
 */
export async function checkYouTubeTokenHealth(): Promise<boolean | null> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { youtubeClientId: true, youtubeClientSecret: true, youtubeRefreshToken: true },
  });
  const clientId = settings?.youtubeClientId ?? undefined;
  const clientSecret = decryptSecretSafe(settings?.youtubeClientSecret ?? null) ?? undefined;
  const refreshToken = decryptSecretSafe(settings?.youtubeRefreshToken ?? null) ?? undefined;
  if (!clientId || !clientSecret || !refreshToken) return null;

  try {
    await youtubeAccessToken({ clientId, clientSecret, refreshToken });
    return true;
  } catch (err) {
    void logSystemError(
      "youtube",
      `Доступ к YouTube потерян — автопубликация роликов работать не будет: ${describeError(err)}. ` +
        `Нужно заново выдать согласие и записать refresh-токен в Настройки: рецепт в ` +
        `docs/youtube-oauth-refresh-check-11-09-2026.md.`
    );
    return false;
  }
}
