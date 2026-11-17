import { formatShortCode } from "@royal-home/shared";
import { prisma } from "../db.js";
import { editMessageCaption } from "../telegram/api.js";
import { createNotification } from "./notifications.js";
import { propertyOwnerAgentId } from "./propertyOwner.js";
import { removeFromSocial, type ManualStep, type SocialRemovalResult } from "./publishedVideoFix.js";
import { describeError } from "./describeError.js";
import { logSystemError } from "./systemError.js";

/**
 * ПРОДАННЫЙ ОБЪЕКТ УХОДИТ ИЗ СОЦСЕТЕЙ САМ (29.10.2026, владелец: «полный автомат»).
 *
 * До этой правки продажа гасила фото-посты и повторы, но основной ролик объекта
 * (Instagram, Facebook, YouTube, Telegram, Threads, TikTok) висел дальше: снять его
 * можно было только кнопкой «Убрать из соцсетей» в карточке. Зовётся из
 * closeWorkAfterLeavingSale (lib/propertyLeftSale.ts) — там сходятся все пути
 * продажи: ручной статус, закрытие сделки, ночная сверка.
 *
 * Что делает:
 *  1. removeFromSocial — то же снятие, что у кнопки: Instagram, Facebook, YouTube и
 *     Threads через API. Канал, который снять не удалось, остаётся в карточке, и
 *     журнал получает причину (это делает сама removeFromSocial).
 *  2. Telegram удаляет сообщение бота только младше 48 часов — старше отвечает
 *     «message can't be deleted» при любых правах администратора. Такой пост не
 *     снимаем, а переписываем подпись на «ПРОДАНО»: правку подписи Telegram
 *     разрешает в любой срок.
 *  3. Что можно убрать только руками (TikTok — API удаления нет вовсе; Instagram,
 *     если не задан маркер удаления), уходит хозяину объекта уведомлением со
 *     ссылкой на пост.
 *
 * Здесь же будут жить следующие реакции на продажу (пауза рекламы, снятие из
 * каталога Meta, история «Продано»): одна точка, куда смотреть, когда объект
 * продан, — а не новая копия логики в каждом из четырёх путей продажи.
 */

/** Telegram: сообщение старше 48 часов бот удалить не может. */
export function isTelegramTooOldToDelete(error: string): boolean {
  return /message can't be deleted/i.test(error);
}

export function soldTelegramCaption(shortId: number): string {
  return `✅ ПРОДАНО\n\n${formatShortCode("ОБ", shortId)} уже продан. Похожие варианты — напишите нам, подберём.`;
}

const CHANNEL_TITLE: Record<ManualStep["channel"], string> = { INSTAGRAM: "Instagram", TIKTOK: "TikTok", THREADS: "Threads" };

/** Текст уведомления хозяину: что убрать руками и где. */
export function manualRemovalBody(steps: ManualStep[]): string {
  return steps.map((s) => `${CHANNEL_TITLE[s.channel]}: ${s.url ?? "ссылки нет — найдите ролик в приложении"}`).join("\n");
}

export interface SoldSocialResult {
  removal: SocialRemovalResult;
  /** Telegram-посты, которым переписали подпись вместо удаления. */
  telegramMarked: number;
  manualNotified: boolean;
}

export async function retireSocialAfterSale(propertyId: string): Promise<SoldSocialResult | null> {
  const before = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { shortId: true, publishedChannels: true, intakeAgentId: true, assignedAgentId: true, createdById: true },
  });
  if (!before || (before.publishedChannels ?? []).length === 0) return null;

  const removal = await removeFromSocial(propertyId);
  if (removal.blocked) {
    void logSystemError("meta", `Объект ${propertyId} продан, но снять ролики не начали: ${removal.blocked}`);
    return { removal, telegramMarked: 0, manualNotified: false };
  }

  let telegramMarked = 0;
  if (removal.failed.some((f) => f.channel === "TELEGRAM" && isTelegramTooOldToDelete(f.error))) {
    // Читаем карточку заново: removeFromSocial вычёркивает снятые чаты, и править
    // надо ровно те сообщения, что остались висеть.
    const after = await prisma.property.findUnique({ where: { id: propertyId }, select: { publishedPostIds: true } });
    const postIds = (after?.publishedPostIds ?? {}) as Record<string, unknown>;
    const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { telegramChannelId: true } });
    const targets: [string, string][] = [];
    if (settings?.telegramChannelId && typeof postIds.TELEGRAM === "string") targets.push([settings.telegramChannelId, postIds.TELEGRAM]);
    const extra = postIds.TELEGRAM_EXTRA as Record<string, string> | undefined;
    for (const [chatId, messageId] of Object.entries(extra ?? {})) if (messageId) targets.push([chatId, messageId]);

    const caption = soldTelegramCaption(before.shortId);
    for (const [chatId, messageId] of targets) {
      try {
        await editMessageCaption(chatId, Number(messageId), caption);
        telegramMarked++;
      } catch (err) {
        void logSystemError("telegram", `Объект ${propertyId} продан: подпись «ПРОДАНО» в чате ${chatId} не поставлена: ${describeError(err)}`);
      }
    }
  }

  let manualNotified = false;
  const ownerId = propertyOwnerAgentId(before);
  if (removal.manual.length > 0 && ownerId) {
    const code = formatShortCode("ОБ", before.shortId);
    await createNotification({
      agentId: ownerId,
      kind: "property_sold_manual_removal",
      title: `${code} продан — уберите ролик руками`,
      body: manualRemovalBody(removal.manual),
      url: `/properties/${before.shortId}`,
      tag: `sold-manual-removal-${propertyId}`,
    });
    manualNotified = true;
  }

  return { removal, telegramMarked, manualNotified };
}
