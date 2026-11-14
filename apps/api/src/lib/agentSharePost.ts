import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "../db.js";
import { propertyCoversDir } from "../upload.js";
import { sendMessage, sendMessageWithButtons, sendPhotoFromDisk, type TelegramInlineButton } from "../telegram/api.js";
import { logSystemError } from "./systemError.js";
import { sendStaffNotice } from "../telegram/staffNotice.js";
import { isKindMuted } from "./notificationPrefs.js";
import { describeError } from "./describeError.js";
import { siteListingUrl } from "./siteListingUrl.js";
import { publishedPostLink, channelLabel } from "@royal-home/shared";

/**
 * АГЕНТУ ЕГО ГОТОВЫЙ ПОСТ В TELEGRAM (28.09.2026, владелец: «у агентов личные
 * профили с тысячами друзей, это больше, чем у Страницы»).
 *
 * После публикации ответственный (тот же порядок, что у
 * notifyVideoHandoffPublishResult: assignedAgentId ?? intakeAgentId ??
 * createdById) получает в личный чат с ботом готовый пост — подпись + ссылки
 * на все вышедшие каналы + ссылка на сайт — с кнопками, чтобы одним тапом
 * открыть пост и нажать «Поделиться» у себя.
 *
 * Вызывается ОДНИМ местом — lib/videoHandoff.ts::notifyVideoHandoffPublishResult,
 * сразу после пуша, только когда succeededChannels непустой. Пуш о публикации
 * этой правкой не тронут — Telegram добавляется поверх, под собственным
 * рубильником (Settings.agentSharePostTelegram) и личным тумблером агента
 * (Agent.sharePostTelegram).
 *
 * Минимальная форма сводки нарочно СВОЯ, а не импорт HandoffPublishSummary из
 * videoHandoff.ts — оттуда же вызывается эта функция, и импорт типа оттуда
 * назад сюда завёл бы цикл файлов (audit:deps его ловит, см. describeError.ts
 * докстринг о той же ловушке).
 */
export interface AgentSharePostSummary {
  succeededChannels: string[];
}

/** Инлайн-кнопка обязана уложиться в 64 байта callback_data (лимит Telegram) —
 *  id объекта (uuid, 36 символов) с префиксом укладывается с большим запасом. */
export function shareTextCallbackData(propertyId: string): string {
  return `share-text:${propertyId}`;
}

export async function sendAgentSharePost(propertyId: string, summary: AgentSharePostSummary): Promise<void> {
  if (summary.succeededChannels.length === 0) return;

  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { agentSharePostTelegram: true },
  });
  if (settings?.agentSharePostTelegram === false) return;

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      id: true,
      shortId: true,
      assignedAgentId: true,
      intakeAgentId: true,
      createdById: true,
      instagramUrl: true,
      publishedPostIds: true,
      reelsCaption: true,
      socialCoverSquareUrl: true,
      publishedOnSite: true,
      siteListingId: true,
    },
  });
  if (!property) return; // объект удалили между публикацией и этим вызовом — слать некому

  const responsibleId = property.assignedAgentId ?? property.intakeAgentId ?? property.createdById;
  if (!responsibleId) return;

  const agent = await prisma.agent.findUnique({
    where: { id: responsibleId },
    select: { isActive: true, telegramChatId: true, pushMuted: true },
  });
  // Нет чата/флаг выключен/сотрудник неактивен — норма, не повод писать в журнал
  // (ровно как у montageObservers: тишина здесь не отказ, а обычный случай).
  // Выключено ли «Публикации объектов» — решает дверь (pushMuted), а не отдельный
  // флаг sharePostTelegram: с 11.11.2026 это одна настройка (он — её зеркало).
  if (!agent || !agent.isActive || !agent.telegramChatId) return;
  if (isKindMuted("publication", agent.pushMuted)) return;

  /**
   * ИДЕМПОТЕНТНОСТЬ ЧЕРЕЗ УСЛОВНЫЙ UPDATE, А НЕ «ПРОЧЁЛ — ПОТОМ ЗАПИСАЛ».
   * `updateMany` с `agentSharePostSentAt: null` в `where` — атомарная заявка на
   * право отправить: если параллельный вызов (или повтор этого же job) уже
   * поставил метку, count будет 0, и мы тихо выходим, не дублируя сообщение.
   * Метка ставится ДО фактической отправки: важен сам факт попытки достучаться
   * до конкретного человека по конкретному объекту, а не был ли Telegram в
   * этот момент доступен — иначе временный сбой Telegram включал бы бесконечный
   * повтор при каждом следующем вызове notifyVideoHandoffPublishResult.
   */
  const claimed = await prisma.property.updateMany({
    where: { id: propertyId, agentSharePostSentAt: null },
    data: { agentSharePostSentAt: new Date() },
  });
  if (claimed.count === 0) return;

  const buttons: TelegramInlineButton[] = [];
  for (const channel of summary.succeededChannels) {
    const link = publishedPostLink(channel, property);
    if (link) buttons.push({ text: `${channelLabel(channel)} ↗`, url: link });
  }
  const siteUrl = siteListingUrl(property);
  if (siteUrl) buttons.push({ text: "🌐 На сайте", url: siteUrl });
  buttons.push({ text: "📋 Текст поста", callback_data: shareTextCallbackData(property.id) });
  // Ряд по одной кнопке (сотовый экран, тот же приём, что у sendMessageWithButtons
  // в telegramModeration.ts) — несколько ссылок в одном ряду не помещаются на телефоне.
  const buttonRows = buttons.map((b) => [b]);

  const caption = property.reelsCaption?.trim() || "(подпись не задана)";
  const text = `🎬 Ваш объект №${property.shortId} опубликован\n${caption}\n\nПоделитесь у себя: откройте пост кнопкой ниже и нажмите «Поделиться».`;

  const coverPath = property.socialCoverSquareUrl
    ? path.join(propertyCoversDir, path.basename(property.socialCoverSquareUrl))
    : null;
  const coverExists = coverPath ? await fs.access(coverPath).then(() => true).catch(() => false) : false;

  // Через дверь сообщений помощницы (вид «Публикации объектов», telegram/staffNotice.ts):
  // выключил себе — не приходит; под постом — «🔕 Не присылать такое».
  // Отказ Telegram публикацию не отменяет — дверь пишет его в журнал ошибок сама.
  const chatId = agent.telegramChatId;
  await sendStaffNotice({
    agentId: responsibleId,
    kind: "publication",
    dedupKey: `agent-share-post:${property.id}`,
    deliver: async (_chat, extraRows) => {
      const rows = [...buttonRows, ...extraRows];
      if (coverExists && coverPath) {
        if (text.length <= 1024) return sendPhotoFromDisk(chatId, coverPath, text, rows);
        // Подпись не влезает в лимит подписи фото (1024) — фото без подписи,
        // текст с кнопками отдельным сообщением следом (см. задание, п.2).
        await sendPhotoFromDisk(chatId, coverPath);
      }
      return sendMessageWithButtons(chatId, text, rows);
    },
  });
}

/**
 * «📋 Текст поста» (callback_data `share-text:<id>`) — подпись отдельным
 * простым сообщением, без разметки и кнопок, чтобы агент мог выделить и
 * скопировать её целиком (кнопки под фото/текстом такому не годятся — Telegram
 * не даёт копировать текст вместе с ними одним жестом на телефоне).
 */
export async function sendShareTextMessage(chatId: string, propertyId: string): Promise<void> {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { reelsCaption: true, shortId: true } });
  const text = property?.reelsCaption?.trim() || `Подпись объекта №${property?.shortId ?? "?"} не задана.`;
  await sendMessage(chatId, text).catch((err) => {
    void logSystemError("telegram", `Текст поста не отправлен (share-text, объект ${propertyId}): ${describeError(err)}`);
  });
}
