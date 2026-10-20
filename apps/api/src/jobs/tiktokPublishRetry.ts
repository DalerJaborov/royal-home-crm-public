import { z } from "zod";
import { prisma } from "../db.js";
import { logSystemError } from "../lib/systemError.js";
import { publishApprovedPost, TIKTOK_UPLOAD_TIMEOUT_MS, type PublishChannel } from "../lib/socialPublish.js";
import { applySucceededPublishResults, handoffStatusBlockReason } from "../lib/videoHandoff.js";
import type { JobHandler } from "./registry.js";
import {
  TIKTOK_PUBLISH_RETRY_JOB_TYPE,
  tiktokPublishRetryBackoffMs,
} from "./tiktokPublishRetryPolicy.js";

/**
 * ПОВТОР ПУБЛИКАЦИИ В TIKTOK, КОГДА САМ TIKTOK ПОПРОСИЛ ПОДОЖДАТЬ
 * (23.09.2026, объект 22.09 в 19:06: `spam_risk_too_many_pending_share`).
 *
 * До этой правки такой ответ ложился в `failedChannels` наравне с «токен
 * недействителен» — то есть навсегда. Ролик выходил в четыре сети из пяти, в
 * TikTok не выходил НИКОГДА, и повторить было некому: карточка помечала канал
 * красным, а кнопку «Опубликовать в TikTok» надо было нажать руками, зная, что
 * прошло достаточно времени. Владелец узнавал об этом, только если сам смотрел
 * журнал ошибок.
 *
 * ЧТО ИМЕННО ПРОХОДИТ САМО. Три кода TikTok (см. TIKTOK_RETRIABLE_ERROR_CODES в
 * lib/socialPublish.ts) означают «сейчас нельзя»: слишком много публикаций
 * подряд, слишком много неподтверждённых черновиков во «Входящих», превышен
 * лимит запросов. Первый и третий проходят за часы сами. Второй — только когда
 * владелец разберёт черновики в приложении TikTok; поэтому лесенка здесь идёт
 * не минутами, как у сетевых сбоев, а часами, и тянется больше суток: ровно то
 * окно, в котором TikTok считает свои пять черновиков.
 *
 * ЛОГИКИ ПУБЛИКАЦИИ ЗДЕСЬ НЕТ. Задание зовёт тот же `publishApprovedPost`, что
 * и обычная публикация, пропуская все каналы кроме TikTok, и дописывает
 * карточку той же `applySucceededPublishResults` — ровно как ручная кнопка
 * (routes/properties/videos.ts::POST /:id/tiktok-publish). Вторая копия этого
 * куска была бы тем самым «одно правило написано дважды».
 */
const schema = z.object({ propertyId: z.string() });

/** Все каналы, кроме TikTok: этому заданию поручен ровно один. */
const ALL_CHANNELS_EXCEPT_TIKTOK: PublishChannel[] = ["INSTAGRAM", "FACEBOOK", "TELEGRAM", "YOUTUBE", "THREADS"];

export const tiktokPublishRetryJob: JobHandler<z.infer<typeof schema>> = {
  type: TIKTOK_PUBLISH_RETRY_JOB_TYPE,
  schema,
  backoff: tiktokPublishRetryBackoffMs,
  // Одна загрузка ролика в TikTok ждётся до 5 минут, потом ещё опрос статуса
  // (до ~2 мин) — общая минута раннера срывала удавшуюся публикацию в
  // «не завершилось за 60с» (№174 ночной проверки 24.09). Запас сверху — на
  // токен и init; держим меньше 15 минут подбора зависших RUNNING (runner.ts).
  timeoutMs: TIKTOK_UPLOAD_TIMEOUT_MS + 3 * 60_000,

  async run(payload) {
    const property = await prisma.property.findUnique({
      where: { id: payload.propertyId },
      select: {
        id: true,
        shortId: true,
        deletedAt: true,
        status: true,
        videoHandoffFinalPath: true,
        publishedChannels: true,
        reelsCaption: true,
        clipReviewStatus: true,
      },
    });
    // Новый ролик ждёт проверки модератора (25.09.2026, lib/clipReview.ts) —
    // повтор прошлой попытки иначе выпустил бы в TikTok непроверенный файл.
    if (property?.clipReviewStatus === "PENDING") return;
    // Объект удалили, ролик отозвали, или TikTok уже получил своё (успела
    // ручная кнопка или прошлая попытка) — повторять нечего. Не ошибка.
    if (!property || property.deletedAt || !property.videoHandoffFinalPath) return;
    if ((property.publishedChannels ?? []).includes("TIKTOK")) return;
    // ПРОДАН / СНЯТ / ЗАБРОНИРОВАН, пока повтор ждал своих часов (25.09.2026, Б1):
    // лесенка тянется до полутора суток, за это время объект успевают продать.
    // Тот же предикат, что у задания публикации (lib/videoHandoff.ts). Задание
    // завершается (return, не throw — иначе лесенка повторов крутила бы его
    // дальше), одна строка в журнал, чтобы невышедший TikTok не пропал молча.
    const blocked = handoffStatusBlockReason(property.status);
    if (blocked) {
      void logSystemError("tiktok", `Объект №${property.shortId}: отложенный повтор TikTok отменён — ${blocked}`);
      return;
    }

    const [result] = await publishApprovedPost({
      propertyId: property.id,
      localVideoPath: property.videoHandoffFinalPath,
      localCoverPath: null,
      caption: property.reelsCaption ?? "",
      skipChannels: ALL_CHANNELS_EXCEPT_TIKTOK,
    });

    if (result?.ok) {
      await applySucceededPublishResults(property.id, [{ channel: "TIKTOK", postId: result.postId }]);
      return;
    }

    // ВСЁ ЕЩЁ «СЕЙЧАС НЕЛЬЗЯ» — бросаем, чтобы сработала лесенка повторов
    // очереди. Тихо вернуться значило бы отметить задание сделанным, а ролик
    // так и не вышел бы: ровно та поломка, ради которой это задание заведено.
    if (result && !result.ok && result.retriable) {
      throw new Error(`TikTok снова просит подождать: ${result.error ?? "без причины"}`);
    }

    // Настоящий отказ (токен, бан, отклонённый ролик) — повторять его смысла
    // нет, ждать нечего. Пишем в журнал и заканчиваем: канал остаётся
    // ненаписанным и виден в карточке красным, как и раньше.
    if (result && !result.ok) {
      void logSystemError(
        "tiktok",
        `Объект ${property.id}: отложенный повтор публикации в TikTok не прошёл и повторять нечего — ${result.error ?? "без причины"}`
      );
    }
  },

  /**
   * Полтора суток ожидания кончились. Отдельной записи в журнал здесь нет:
   * `jobs/runner.ts` пишет `logSystemError("background-jobs", …)` и зовёт
   * `notifyStuckWorkGivenUp` для ЛЮБОГО GIVEN_UP до этого хука — вторая строка
   * о том же самом нарушила бы «одно событие — одно уведомление».
   */
  async onGiveUp() {},
};
