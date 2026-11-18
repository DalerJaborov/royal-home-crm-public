import fs from "node:fs/promises";
import { z } from "zod";
import { prisma } from "../db.js";
import { logSystemError } from "../lib/systemError.js";
import { publishApprovedPost, type PublishChannel } from "../lib/socialPublish.js";
import {
  applySucceededPublishResults,
  handoffStatusBlockReason,
  videoHandoffFinalDiskPath,
  videoHandoffPublishDedupeKey,
} from "../lib/videoHandoff.js";
import { publishPropertyInstagramStories } from "../lib/instagramStories.js";
import type { JobHandler } from "./registry.js";
import {
  SOCIAL_PUBLISH_RETRY_JOB_TYPE,
  SOCIAL_PUBLISH_RETRY_TARGETS,
  SOCIAL_PUBLISH_RETRY_TARGET_LABELS,
  enqueueSocialPublishRetry,
  socialPublishRetryBackoffMs,
} from "./socialPublishRetryPolicy.js";

/**
 * ПОВТОР ПУБЛИКАЦИИ В META, КОГДА ПЛОЩАДКА НЕ СМОГЛА СКАЧАТЬ НАШ ФАЙЛ
 * (18.11.2026, объект №208).
 *
 * Instagram, Facebook и Threads забирают ролик сами по нашей ссылке `/uploads/…`.
 * 17.11 публикация совпала с автовыкатом: контейнер web (nginx) перезапускался
 * полторы минуты, Facebook ответил «Unable to fetch video file from URL.», а
 * часть 1/3 истории Instagram ушла в `status_code: ERROR`. Отказ считался
 * окончательным — канал не выходил больше никогда, хотя через минуту файл
 * снова отдавался. Какие отказы считаются «скачать не смогли» — одна функция
 * `isMetaMediaFetchRetriable` в lib/socialPublish.ts.
 *
 * ЛОГИКИ ПУБЛИКАЦИИ ЗДЕСЬ НЕТ — тот же приём, что у jobs/tiktokPublishRetry.ts:
 * зовём общий `publishApprovedPost` с одним каналом и дописываем карточку общей
 * `applySucceededPublishResults`.
 *
 * НЕ ЗАДВОИТЬ ПОСТ. Перед публикацией перечитываем карточку: канал уже в
 * `publishedChannels` (успела основная публикация, ручная кнопка или прошлая
 * попытка) — выходим молча. Основная публикация этого объекта идёт прямо сейчас —
 * ждём следующей попытки, а не публикуем параллельно с ней.
 */
const schema = z.object({
  propertyId: z.string(),
  channel: z.enum(SOCIAL_PUBLISH_RETRY_TARGETS),
  /** Только истории: после этой минуты серия уже не «та же» (см. enqueueSocialPublishRetry). */
  notAfter: z.string().datetime().optional(),
});
type Payload = z.infer<typeof schema>;

const ALL_CHANNELS: PublishChannel[] = ["INSTAGRAM", "FACEBOOK", "TELEGRAM", "YOUTUBE", "TIKTOK", "THREADS"];

/** Повтор ещё возможен — бросаем, и очередь повторит задание по лесенке. */
class RetryLater extends Error {}

export const socialPublishRetryJob: JobHandler<Payload> = {
  type: SOCIAL_PUBLISH_RETRY_JOB_TYPE,
  schema,
  backoff: socialPublishRetryBackoffMs,
  // Instagram ждёт обработку контейнера до ~5 минут, серия историй — по столько
  // же на часть. Меньше 15 минут подбора зависших RUNNING (runner.ts), чтобы
  // живую попытку не захватили второй раз.
  timeoutMs: 14 * 60_000,

  async run(payload) {
    const label = SOCIAL_PUBLISH_RETRY_TARGET_LABELS[payload.channel];
    const property = await prisma.property.findUnique({
      where: { id: payload.propertyId },
      select: {
        id: true,
        shortId: true,
        deletedAt: true,
        status: true,
        price: true,
        currency: true,
        videoHandoffFinalPath: true,
        publishedChannels: true,
        reelsCaption: true,
        clipReviewStatus: true,
        socialCoverStoryUrl: true,
        socialCoverSquareUrl: true,
      },
    });
    // Новый ролик ждёт модератора (lib/clipReview.ts) — повтор прошлой попытки
    // выпустил бы непроверенный файл. Одобрение поставит публикацию заново.
    if (property?.clipReviewStatus === "PENDING") return;
    // Объект удалили или ролик отозвали — повторять нечего, не ошибка.
    if (!property || property.deletedAt || !property.videoHandoffFinalPath) return;
    const blocked = handoffStatusBlockReason(property.status);
    if (blocked) {
      void logSystemError("meta", `Объект №${property.shortId}: отложенный повтор (${label}) отменён — ${blocked}`);
      return;
    }
    const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { autoPublishEnabled: true } });
    if (!settings?.autoPublishEnabled) {
      // Автопубликацию выключили, пока повтор ждал — решение человека, не наше.
      void logSystemError("meta", `Объект №${property.shortId}: отложенный повтор (${label}) отменён — автопубликация выключена`);
      return;
    }
    const diskPath = videoHandoffFinalDiskPath(property.videoHandoffFinalPath);
    if (!diskPath || !(await fileExists(diskPath))) {
      void logSystemError("meta", `Объект №${property.shortId}: отложенный повтор (${label}) отменён — файла ролика на диске нет`);
      return;
    }
    // Основная публикация этого объекта прямо сейчас идёт по тем же каналам —
    // параллельный пост в тот же Facebook был бы дублем. Подождём её исхода.
    const mainRunning = await prisma.backgroundJob.findFirst({
      where: { dedupeKey: videoHandoffPublishDedupeKey(property.id), status: "RUNNING" },
      select: { id: true },
    });
    if (mainRunning) throw new RetryLater(`Идёт основная публикация объекта №${property.shortId} — повторим ${label} позже`);

    if (payload.channel === "INSTAGRAM_STORIES") {
      await retryStories(property.id, property.shortId, property.videoHandoffFinalPath, payload.notAfter);
      return;
    }

    const channel: PublishChannel = payload.channel;
    if ((property.publishedChannels ?? []).includes(channel)) return;

    const [result] = await publishApprovedPost({
      propertyId: property.id,
      localVideoPath: property.videoHandoffFinalPath,
      // Обложки уже нарисованы основной публикацией — берём их, а не рисуем заново.
      localCoverPath: property.socialCoverStoryUrl ?? null,
      localSquareCoverPath: property.socialCoverSquareUrl ?? null,
      caption: property.reelsCaption ?? "",
      skipChannels: ALL_CHANNELS.filter((c) => c !== channel),
    });
    // Канал отключили в настройках, пока повтор ждал, — публиковать некуда.
    if (!result) return;

    if (result.ok) {
      await applySucceededPublishResults(
        property.id,
        [{ channel, postId: result.postId, secondaryPostId: result.secondaryPostId, permalink: result.permalink }],
        channel === "INSTAGRAM" ? result.permalink ?? null : null,
        { publishedPrice: { price: Number(property.price), currency: property.currency } }
      );
      // Reels вышел только сейчас — истории вслед за ним основная публикация не
      // выложила (она зовёт их после успешного Reels). Отдельным заданием, а не
      // здесь: серия идёт минутами и не должна делить срок этой попытки.
      if (channel === "INSTAGRAM") {
        await enqueueSocialPublishRetry(property.id, "INSTAGRAM_STORIES", { now: true });
      }
      return;
    }
    // Контейнер Instagram ещё обрабатывается у Meta и сохранён — его доведёт
    // фоновый проход lib/instagramPendingContainers.ts. Не отказ.
    if (result.pending) return;
    // Facebook не смог понять, вышел ли пост прошлой попыткой, — нужен человек,
    // запись в журнал уже сделана внутри. Повтор вслепую мог бы задвоить пост.
    if (result.outcomeUnknown) return;
    if (result.retriable) {
      throw new RetryLater(`${label} снова не смог скачать ролик объекта №${property.shortId}: ${result.error ?? "без причины"}`);
    }
    // Настоящий отказ (токен, права, формат) — ждать нечего, нужен человек.
    void logSystemError(
      "meta",
      `Публикация в ${label} (объект ${property.id}) не удалась при отложенном повторе, повторять нечего: ${result.error ?? "без причины"}`
    );
  },

  /**
   * Попытки кончились. `jobs/runner.ts` уже пишет техническую строку
   * «Задание … сдалось» и уведомляет «Что не доехало». Здесь — строка другого
   * назначения: она начинается с «Публикация в <канал> (объект <id>)», и по ней
   * карточка объекта показывает канал красным с понятной причиной
   * (routes/properties/list.ts::loadPublishErrorsByChannel), иначе там висело
   * бы «отложена — повторим сами», хотя повторять уже некому.
   */
  async onGiveUp(raw) {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return;
    const { propertyId, channel } = parsed.data;
    const label = SOCIAL_PUBLISH_RETRY_TARGET_LABELS[channel];
    const text =
      channel === "INSTAGRAM_STORIES"
        ? `Истории Instagram (объект ${propertyId}): Meta так и не смогла скачать ролик за полтора часа повторов — выложите историю вручную`
        : `Публикация в ${label} (объект ${propertyId}) не удалась: площадка так и не смогла скачать ролик за полтора часа повторов — опубликуйте в ${label} вручную из карточки`;
    void logSystemError("meta", text);
  },
};

async function retryStories(propertyId: string, shortId: number, videoPath: string, notAfter: string | undefined): Promise<void> {
  // Позже окна серии повтор выложил бы уже вышедшие части второй раз
  // (SERIES_RESUME_WINDOW_MS в lib/instagramStories.ts) — лучше честно сдаться.
  if (notAfter && Date.now() > Date.parse(notAfter)) {
    void logSystemError(
      "meta",
      `Истории Instagram (объект ${propertyId}): повтор опоздал — серия старше двух часов, чтобы не задвоить вышедшие части, выложите историю вручную`
    );
    return;
  }
  // БЕЗ resumeOnly — намеренно. resumeOnly доделывает только НАЧАТУЮ серию и
  // ничего не делает, если не вышло ни одной части, а у №208 упала как раз
  // первая. Обычный вызов сам пропускает части, вышедшие за последние два часа,
  // и уважает рубильник историй в Настройках.
  const summary = await publishPropertyInstagramStories(propertyId, videoPath);
  if (summary.retriable) {
    throw new RetryLater(`Истории Instagram объекта №${shortId}: Meta снова не смогла скачать ролик — ${summary.error ?? "без причины"}`);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
