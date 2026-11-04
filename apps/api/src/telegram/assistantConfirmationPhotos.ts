import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { formatPropertyCode, type AssistantActionView } from "@royal-home/shared";
import { prisma } from "../db.js";
import { uploadsDir } from "../upload.js";
import {
  editMessageCaption,
  editMessageText,
  sendPhotoFromDisk,
  TelegramApiError,
  type TelegramCallbackQuery,
  type TelegramInlineButton,
} from "./api.js";

const PHOTO_LIMIT = 4;
const PHOTO_CAPTION_LIMIT = 1024;
const PHOTO_SIZE_LIMIT = 10_000_000;

async function localPublicPropertyPhotos(shortId: number): Promise<string[]> {
  const rows = await prisma.propertyPhoto.findMany({
    where: { property: { shortId, deletedAt: null, publishedOnSite: true, offSite: false } },
    orderBy: [{ order: "asc" }, { id: "asc" }],
    select: { url: true },
    take: PHOTO_LIMIT,
  });
  if (!rows.length) return [];
  const root = await realpath(uploadsDir);
  const files = await Promise.all(rows.map(async ({ url }) => {
    const name = /^\/uploads\/([a-zA-Z0-9_.-]+\.(?:jpe?g|png|webp))$/i.exec(url)?.[1];
    if (!name) return null;
    try {
      const file = await realpath(path.join(root, name));
      if (path.relative(root, file) !== name) return null;
      const info = await stat(file);
      return info.isFile() && info.size > 0 && info.size <= PHOTO_SIZE_LIMIT ? file : null;
    } catch {
      return null;
    }
  }));
  return [...new Set(files.filter((file): file is string => file !== null))];
}

/** True once the confirmation photo was sent or its delivery cannot be ruled out. */
export async function sendTelegramPriceConfirmationPhotos(
  chatId: string,
  action: AssistantActionView,
  text: string,
  buttons: TelegramInlineButton[][],
  replyTo?: number,
): Promise<boolean> {
  if (action.tool !== "change_property_price" || text.length > PHOTO_CAPTION_LIMIT) return false;
  // This title is built by the price executor from the resolved record.
  const title = /^Цена объекта (ОБ-(\d{1,10}))(?:: заявка руководителю)?$/u.exec(action.preview.title);
  if (!title) return false;
  const shortId = Number(title[2]);
  if (shortId < 1 || shortId > 2_147_483_647 || formatPropertyCode(shortId) !== title[1]) return false;

  const [cover, ...otherPhotos] = await localPublicPropertyPhotos(shortId).catch(() => []);
  if (!cover) return false;
  let coverMessageId: number;
  try {
    const sent = await sendPhotoFromDisk(chatId, cover, text, buttons, 8_000, { singleAttempt: true, replyTo });
    coverMessageId = sent.message_id;
  } catch (error) {
    // On timeout the photo could already contain the active buttons. Avoid posting a second card.
    if (error instanceof TelegramApiError && error.errorCode === 400) return false;
    console.warn("[telegram:assistant] price confirmation photo delivery unconfirmed");
    return true;
  }
  if (!Number.isInteger(coverMessageId)) return true;
  for (const photo of otherPhotos) {
    try {
      await sendPhotoFromDisk(chatId, photo, undefined, undefined, 5_000, { singleAttempt: true, replyTo: coverMessageId });
    } catch {
      // Optional pictures must not affect the delivered confirmation.
      break;
    }
  }
  return true;
}

export async function editTelegramConfirmationMessage(
  message: NonNullable<TelegramCallbackQuery["message"]>,
  text: string,
): Promise<void> {
  const id = message.message_id;
  if (id === undefined) return;
  const chatId = String(message.chat.id);
  if ("photo" in message && Array.isArray(message.photo) && message.photo.length > 0) {
    await editMessageCaption(chatId, id, text, null);
  } else {
    await editMessageText(chatId, id, text, null);
  }
}
