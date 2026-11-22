/**
 * «ГОТОВО» У МОНТАЖЁРА — ОДНА ДВЕРЬ (17.11.2026, класс «ответила — не сделала»).
 *
 * Тело `POST /properties/:id/complete-editing` жило внутри маршрута, и второй путь
 * (ИИ-помощник Шабнам) выйти из монтажа в продажу не мог: статус `EDITING → AVAILABLE`
 * через `change_property_status` намеренно закрыт (lib/propertyStatusChange.ts, ролик, сайт
 * и очередь монтажёра идут только этим путём). Живой случай 17.11: объект ОБ-000193 стоял на
 * «Монтаж» без ссылки на ролик в Instagram, помощница не знала причины и предлагала заявку
 * «сменить статус». Теперь маршрут и инструмент `complete_property_editing` зовут одну функцию.
 *
 * Спецификация владельца, Этап 7/9: «Готово» завершает подготовку объекта; ответственность
 * со всех снимается сама (роль по статусу, а не отдельное поле), место в лимите агента
 * освобождается самим фактом смены статуса (лимит считает живым запросом), объект
 * публикуется на сайте синхронно и честно: отказ сайта виден ответственному (207), а не
 * спрятан в журнале (lib/propertyPipeline.ts::publishAfterEditingComplete).
 *
 * Перевод статуса условный (`updateMany` по `status = EDITING`), как в
 * `finalizePropertyAvailability` (lib/videoHandoff.ts): два одновременных нажатия — одна
 * публикация, второе получает «уже не на монтаже» без побочных действий.
 *
 * «БЕЗ INSTAGRAM» (17.11.2026, волна 2 Шабнам, живой случай ОБ-000193: ролик принят 06.11, вышел в
 * YouTube, Facebook, Telegram, TikTok, а в Instagram — нет, ключ Instagram мёртв с 12.11; объект
 * 11 дней стоял на «Монтаже», потому что правило 02.08 требует ссылку на Reels). Директор и админ
 * (право `properties.delete` — «кто удаляет, тот и судит», то же право решает заявки по объекту)
 * выводят такой объект явным действием `withoutInstagram: true`, если ролик принят (проверка
 * ролика не ждёт решения и не отклонила его) и вышел хотя бы в одну сеть. Снимается ТОЛЬКО
 * причина «нет ссылки на Instagram»: мало фото или чужая ссылка в поле — прежний отказ.
 * Остальным — отказ с подсказкой «попросите директора». В журнал — отдельная запись
 * PROPERTY_SALE_WITHOUT_INSTAGRAM: кто, через что, в каких сетях ролик уже был.
 */
import type { Request } from "express";
import { MIN_PROPERTY_PHOTOS, SOCIAL_VIDEO_CHANNELS, SOCIAL_VIDEO_CHANNEL_LABELS, type PermissionId, type SocialVideoChannel } from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { logAgentAudit } from "./audit.js";
import { publishPropertyUpdated } from "./livePublish.js";
import { canManagePropertyAs } from "./propertyAccess.js";
import { blockersForSale, publishAfterEditingComplete, saleBlockerCodes, type PublishAuditAuthor } from "./propertyPipeline.js";
import { skipVideoHandoffOnManualPublish } from "./videoHandoff.js";
import { describeError } from "./describeError.js";
import { logSystemError } from "./systemError.js";

export interface CompleteEditingActor {
  agentId: string;
  can: (permission: PermissionId) => boolean;
}

/**
 * Право вывести в продажу без Instagram — директор и админ по пресету. Нового права не заводим:
 * `properties.delete` уже значит «руководство решает по объекту» (заявки на удаление и на изменение
 * опубликованного объекта, packages/shared/src/permissions.ts). Директор может отнять его у админа.
 */
export const SALE_WITHOUT_INSTAGRAM_PERMISSION: PermissionId = "properties.delete";

/** Подсказка «можно ли без Instagram» — у отказа NOT_READY, когда единственная причина — нет ссылки на Instagram. */
export interface WithoutInstagramHint {
  /** Этот человек может вывести объект без Instagram прямо сейчас. */
  allowed: boolean;
  /** По ролику можно, но у этого человека нет права — нужен директор или администратор. */
  needsDirector: boolean;
  /** Сети, где ролик уже вышел (подписи: YouTube, Facebook…). Пусто — ролик не вышел нигде. */
  channels: string[];
  /** Почему нельзя — словами (нет права, ролик не принят, не вышел никуда). Только при `allowed: false`. */
  reason?: string;
}

export type CompleteEditingFailure = {
  ok: false;
  status: 403 | 404 | 409;
  code: "NOT_FOUND" | "FORBIDDEN" | "NOT_EDITING" | "NOT_READY" | "WITHOUT_INSTAGRAM_FORBIDDEN" | "WITHOUT_INSTAGRAM_NOT_ALLOWED";
  error: string;
  /** Только у NOT_READY: чего не хватает (тексты `blockersForSale`). */
  blockers?: string[];
  /** Только у NOT_READY без ссылки на Instagram (и у отказов «без Instagram»): можно ли вывести без неё. */
  withoutInstagram?: WithoutInstagramHint;
};

const EDITING_INCLUDE = { district: true, photos: { orderBy: { order: "asc" } } } satisfies Prisma.PropertyInclude;

export type CompleteEditingOutcome =
  | {
      ok: true;
      /** Объект после публикации (то, что отдаёт `presentProperty`). */
      property: Awaited<ReturnType<typeof publishAfterEditingComplete>>["updated"];
      /** Объект уже в продаже в CRM, но сайт его не принял — ответственный должен это знать. */
      siteSyncError?: string;
      /** Вывели без ссылки на Instagram (явное действие директора/админа): где ролик уже был. */
      withoutInstagram?: { channels: string[] };
    }
  | CompleteEditingFailure;

export const NOT_EDITING_MESSAGE = "Кнопка «Готово» доступна только на этапе «Монтаж»";

/** Минимум полей объекта для проверок «Готово» (без загрузки фото — только их число). */
export interface CompleteEditingCandidate {
  status: string;
  deletedAt: Date | null;
  assignedAgentId?: string | null;
  intakeAgentId?: string | null;
  createdById?: string | null;
  instagramUrl: string | null;
  photoCount: number;
  /** Для «без Instagram»: проверка готового ролика (NONE — не требовалась). Нет поля — считаем NONE. */
  clipReviewStatus?: string | null;
  /** Для «без Instagram»: куда ролик уже вышел. */
  publishedChannels?: readonly string[] | null;
}

export interface CompleteEditingOptions {
  /** Явная просьба вывести без ссылки на Instagram (директор/админ). Ссылка есть — ни на что не влияет. */
  withoutInstagram?: boolean;
}

/** Сети, куда ролик реально вышел, — подписями и в постоянном порядке. Служебные метки не считаются. */
export function publishedVideoChannelLabels(publishedChannels: readonly string[] | null | undefined): string[] {
  const out = new Set(publishedChannels ?? []);
  return SOCIAL_VIDEO_CHANNELS.filter((c) => out.has(c)).map((c: SocialVideoChannel) => SOCIAL_VIDEO_CHANNEL_LABELS[c]);
}

export type SaleWithoutInstagramEligibility =
  | { eligible: true; channels: string[] }
  | { eligible: false; channels: string[]; reason: string };

/**
 * Годится ли объект к выводу без Instagram ПО САМОМУ РОЛИКУ (права — отдельно, у двери).
 * Ролик принят: проверка готового ролика не ждёт решения и не вернула его монтажёру (NONE —
 * проверка не требовалась, это и есть «приёмка выключена»). И ролик вышел хотя бы в одну сеть —
 * выход в соцсеть и есть доказательство, что ролик есть и показывать его можно.
 */
export function saleWithoutInstagramEligibility(property: {
  clipReviewStatus?: string | null;
  publishedChannels?: readonly string[] | null;
}): SaleWithoutInstagramEligibility {
  const channels = publishedVideoChannelLabels(property.publishedChannels);
  const review = property.clipReviewStatus ?? "NONE";
  if (review === "PENDING") {
    return { eligible: false, channels, reason: "готовый ролик ещё не принят — ждёт решения по проверке ролика" };
  }
  if (review === "REJECTED") {
    return { eligible: false, channels, reason: "готовый ролик отклонён и возвращён монтажёру — нужен новый" };
  }
  if (channels.length === 0) {
    return { eligible: false, channels, reason: "ролик ещё не вышел ни в одну сеть" };
  }
  return { eligible: true, channels };
}

/** «Ролик вышел в YouTube, Facebook» — одна строка на все тексты (карточка, отказ, журнал). */
export function channelsSentence(channels: readonly string[]): string {
  return channels.length > 0 ? `ролик вышел в ${channels.join(", ")}` : "ролик не вышел ни в одну сеть";
}

/**
 * Проверки без записи — для превью помощника и для самой двери. Порядок ответов прежний:
 * не найден → не ваш объект → не на «Монтаже» → не готов к продаже. «Без Instagram» снимает
 * ровно одну причину — нет ссылки на Instagram — и только у того, у кого право, при принятом и
 * вышедшем в сети ролике.
 */
export function checkCompleteEditing(
  property: CompleteEditingCandidate | null,
  actor: CompleteEditingActor,
  options: CompleteEditingOptions = {},
): CompleteEditingFailure | null {
  if (!property || property.deletedAt) return { ok: false, status: 404, code: "NOT_FOUND", error: "Объект не найден" };
  if (!canManagePropertyAs(actor, property)) {
    return { ok: false, status: 403, code: "FORBIDDEN", error: "Недостаточно прав" };
  }
  if (property.status !== "EDITING") return { ok: false, status: 409, code: "NOT_EDITING", error: NOT_EDITING_MESSAGE };
  const sale = { instagramUrl: property.instagramUrl, photoCount: property.photoCount };
  const codes = saleBlockerCodes(sale);
  if (codes.length === 0) return null;
  const blockers = blockersForSale(sale);
  const onlyNoInstagram = codes.length === 1 && codes[0] === "NO_INSTAGRAM_LINK";
  if (!onlyNoInstagram) {
    // Мало фото или в поле не та ссылка — «без Instagram» это не снимает ни у кого.
    return { ok: false, status: 409, code: "NOT_READY", error: `Объект не готов: ${blockers.join(", ")}`, blockers };
  }

  const eligibility = saleWithoutInstagramEligibility(property);
  const permitted = actor.can(SALE_WITHOUT_INSTAGRAM_PERMISSION);
  const hint: WithoutInstagramHint = {
    allowed: permitted && eligibility.eligible,
    needsDirector: eligibility.eligible && !permitted,
    channels: eligibility.channels,
    ...(!eligibility.eligible
      ? { reason: eligibility.reason }
      : !permitted
        ? { reason: "вывести без Instagram может только директор или администратор" }
        : {}),
  };

  if (options.withoutInstagram) {
    if (!permitted) {
      return {
        ok: false,
        status: 403,
        code: "WITHOUT_INSTAGRAM_FORBIDDEN",
        error:
          "Вывести объект в продажу без Instagram может только директор или администратор — попросите директора." +
          (eligibility.eligible ? ` Сейчас ${channelsSentence(eligibility.channels)}.` : ""),
        blockers,
        withoutInstagram: hint,
      };
    }
    if (!eligibility.eligible) {
      return {
        ok: false,
        status: 409,
        code: "WITHOUT_INSTAGRAM_NOT_ALLOWED",
        error: `Без Instagram вывести нельзя: ${eligibility.reason}.`,
        blockers,
        withoutInstagram: hint,
      };
    }
    return null;
  }

  // Обычное «Готово» без ссылки: прежний отказ, но с понятным следующим шагом.
  let next = "";
  if (eligibility.eligible) {
    next = permitted
      ? ` Ролик уже вышел в ${eligibility.channels.join(", ")} — можно вывести в продажу без Instagram.`
      : ` Ролик уже вышел в ${eligibility.channels.join(", ")} — директор может вывести объект в продажу без Instagram, попросите директора.`;
  }
  return {
    ok: false,
    status: 409,
    code: "NOT_READY",
    error: `Объект не готов: ${blockers.join(", ")}${next ? `.${next}` : ""}`,
    blockers,
    withoutInstagram: hint,
  };
}

export interface SaleBlockerAdvice {
  /** Что не так — человеческими словами. */
  problem: string;
  /** Что сделать, чтобы объект вышел в продажу. */
  fix: string;
}

/**
 * Причины, почему объект не выходит в продажу, и что делать — словами для сотрудника.
 * Условия не повторяются: коды причин отдаёт `saleBlockerCodes` (lib/propertyPipeline.ts) — тот же
 * источник, что у текстов экрана (`blockersForSale`).
 */
export function saleBlockerAdvice(property: { instagramUrl: string | null; photoCount: number }): SaleBlockerAdvice[] {
  return saleBlockerCodes(property).map((code): SaleBlockerAdvice => {
    switch (code) {
      case "PHOTOS_BELOW_MIN":
        return {
          problem: `фото меньше минимума (${property.photoCount} из ${MIN_PROPERTY_PHOTOS})`,
          fix: `Добавьте фото в карточке объекта: нужно минимум ${MIN_PROPERTY_PHOTOS}.`,
        };
      case "NO_INSTAGRAM_LINK":
        return {
          problem: "нет ссылки на видео-обзор в Instagram — ролик не опубликован в Instagram",
          fix:
            "Опубликуйте ролик в Instagram (после принятия готового ролика это делает публикация по расписанию) " +
            "или впишите ссылку на уже опубликованный ролик в карточке объекта; как только ссылка есть, объект выйдет в продажу.",
        };
      case "LINK_NOT_INSTAGRAM":
        return {
          problem: "в поле видео-обзора ссылка не на Instagram",
          fix: "Замените её в карточке на ссылку на ролик в Instagram: обзор должен быть опубликован именно там.",
        };
    }
  });
}

/**
 * Нажать «Готово»: проверки → условный перевод в AVAILABLE → публикация (журнал, пуш
 * ответственному, автоподбор, сайт) → закрытие передачи монтажёру → событие в живую ленту.
 *
 * @param audit кто записан автором в журнале: HTTP-запрос (экран CRM) либо сотрудник без запроса
 *   (ИИ-помощник; в `meta` — источник и id действия).
 */
export async function completeEditing(input: {
  propertyId: string;
  actor: CompleteEditingActor;
  audit: Request | PublishAuditAuthor;
  /** Явное «вывести без Instagram» (директор/админ) — см. шапку файла. */
  withoutInstagram?: boolean;
}): Promise<CompleteEditingOutcome> {
  const property = await prisma.property.findUnique({ where: { id: input.propertyId }, include: EDITING_INCLUDE });
  const candidate = property && { ...property, photoCount: property.photos.length };
  const failure = checkCompleteEditing(candidate, input.actor, { withoutInstagram: input.withoutInstagram });
  if (failure) return failure;
  // Обход нужен на самом деле только без ссылки: ссылка есть — обычное «Готово», без записи «без Instagram».
  const bypass =
    input.withoutInstagram === true && candidate !== null && saleBlockerCodes(candidate).includes("NO_INSTAGRAM_LINK");
  const bypassChannels = bypass && candidate ? publishedVideoChannelLabels(candidate.publishedChannels) : [];

  // Условный перевод: выигрывает тот, кто первым сменил статус; второй выходит без публикации.
  // Без Instagram — ещё и при том же решении по ролику: если между проверкой и записью пришёл новый
  // ролик на проверку (PENDING) или его отклонили, обход не проходит.
  const moved = await prisma.property.updateMany({
    where: {
      id: input.propertyId,
      deletedAt: null,
      status: "EDITING",
      ...(bypass ? { clipReviewStatus: { notIn: ["PENDING", "REJECTED"] } } : {}),
    },
    data: { status: "AVAILABLE", stageEnteredAt: new Date() },
  });
  if (moved.count === 0) {
    if (bypass) {
      const now = await prisma.property.findUnique({ where: { id: input.propertyId }, select: { status: true, deletedAt: true } });
      if (now && !now.deletedAt && now.status === "EDITING") {
        return {
          ok: false,
          status: 409,
          code: "WITHOUT_INSTAGRAM_NOT_ALLOWED",
          error: "Без Instagram вывести нельзя: по ролику только что изменилось решение проверки — откройте карточку заново.",
        };
      }
    }
    return { ok: false, status: 409, code: "NOT_EDITING", error: NOT_EDITING_MESSAGE };
  }
  const updated = await prisma.property.findUniqueOrThrow({
    where: { id: input.propertyId },
    include: EDITING_INCLUDE,
  });
  if (bypass) {
    // Отдельная запись рядом с PROPERTY_EDITING_DONE: кто и почему вывел без Instagram.
    const meta = "agentId" in input.audit ? (input.audit.meta ?? {}) : { source: "crm" };
    logAgentAudit(input.actor.agentId, "PROPERTY_SALE_WITHOUT_INSTAGRAM", "Property", updated.id, {
      shortId: updated.shortId,
      title: updated.title,
      channels: bypassChannels,
      clipReviewStatus: updated.clipReviewStatus,
      reason: `Ссылки на Instagram нет, ${channelsSentence(bypassChannels)}; вывели в продажу без Instagram`,
      ...meta,
    });
  }

  // Статус уже AVAILABLE: исключение публикации не должно превращаться в «ошибку» — объект в продаже.
  // Сбой уходит в журнал и в итог как siteSyncError (инструмент ответит «изменено, но не всё», маршрут — 207).
  let published: Awaited<ReturnType<typeof publishAfterEditingComplete>>["updated"] = updated;
  let siteSyncError: string | undefined;
  try {
    ({ updated: published, siteSyncError } = await publishAfterEditingComplete(input.audit, updated));
  } catch (err) {
    const reason = describeError(err);
    void logSystemError("api", `Объект ${updated.id}: публикация после «Готово» упала — ${reason}`, { url: `/properties/${updated.id}` });
    siteSyncError = "Объект уже в продаже, но публикация на сайте не прошла";
  }
  // Защита от навсегда занятого места монтажёра: ручной выход из монтажа закрывает передачу ролика.
  void skipVideoHandoffOnManualPublish(published.id).catch((err) =>
    console.error("[video-handoff] закрытие хендоффа при «Готово»:", err),
  );
  publishPropertyUpdated({
    propertyId: published.id,
    agentId: published.assignedAgentId,
    stage: published.status,
    actorId: input.actor.agentId,
  });
  return {
    ok: true,
    property: published,
    ...(siteSyncError ? { siteSyncError } : {}),
    ...(bypass ? { withoutInstagram: { channels: bypassChannels } } : {}),
  };
}
