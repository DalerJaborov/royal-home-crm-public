import { stat, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AssistantPropertyCard } from "@royal-home/shared";
import { prisma } from "../db.js";
import { uploadsDir } from "../upload.js";
import type { AssistantActor } from "../ai/assistant/actor.js";
import { findClientsTool } from "../ai/assistant/tools/findClients.js";
import { sendChatAction, sendMessageWithButtons, sendPhotoFromDisk, TelegramApiError } from "./api.js";
import {
  ASSISTANT_VOICE_PART_CHARS, MAX_HUMAN_PARTS, prepareAssistantReply, prepareAssistantVoicePart,
  sanitizeAssistantReply, splitHumanMessages, splitReaction, stripAssistantSpeechMarkup,
} from "./assistantReply.js";
import { sendAssistantVoiceReply } from "./assistantVoice.js";
import { renderAssistantListText } from "./assistantList.js";

const agentRequest = /^(?:(?:найди|найдите|покажи|покажите)\s+)?клиент(?:ов|ы)\s+агента\s+([\p{L}'’\-]+(?:\s+[\p{L}'’\-]+){0,2})[?!.]*$/iu;
const nameForLink = (text: string) => text.replace(/[\[\]\r\n]+/g, " ").trim();
const rosterSchema = z.object({
  total: z.number().int().nonnegative(), shown: z.number().int().nonnegative(),
  agentsMatched: z.array(z.string()).optional(), note: z.string().optional(),
  items: z.array(z.object({
    code: z.string(), href: z.string().regex(/^\/clients\/\d+$/), name: z.string(),
  })),
});

export async function findTelegramAgentClients(text: string, actor: AssistantActor): Promise<string | null> {
  const name = agentRequest.exec(text.trim())?.[1];
  if (!name) return null;
  let result = await findClientsTool.run({ agentName: name, limit: 5 }, { actor });
  const errorSchema = z.object({ error: z.string() });
  let error = errorSchema.safeParse(result);
  if (error.success && error.data.error.startsWith("Сотрудника")) {
    // Users often omit ъ in Tajik names. Use a unique active match for this read.
    const folded = name.toLowerCase().replaceAll("ъ", "");
    const candidates = await prisma.$queryRaw<{ fullName: string }[]>`
      SELECT "fullName" FROM "Agent"
      WHERE "isActive" AND replace(lower("fullName"), 'ъ', '') LIKE ${`%${folded}%`}
      ORDER BY id LIMIT 2
    `;
    if (candidates.length === 1) {
      result = await findClientsTool.run({ agentName: candidates[0].fullName, limit: 5 }, { actor });
      error = errorSchema.safeParse(result);
    }
  }
  if (error.success) return error.data.error;
  const { total, shown, agentsMatched, items, note } = rosterSchema.parse(result);
  if (note && !total) return note;
  // Вид — общий модуль списков помощницы (telegram/assistantList.ts).
  return renderAssistantListText({
    icon: "👥",
    title: `Клиенты агента ${agentsMatched?.[0] ?? name}`,
    total,
    items: items.map(item => ({ code: item.code, href: item.href, title: nameForLink(item.name) })),
    note: total > shown ? `Показываю ${shown} из ${total}, остальные — в CRM.` : undefined,
    empty: "Доступных карточек нет.",
  }).join("\n\n");
}

export function isVoiceReplayRequest(text: string): boolean {
  return /^(?:(?:озвучь|озвучьте|прочитай)(?:\s+(?:это|ответ|последний ответ))?|(?:отправь|отправьте|пришли|пришлите|ответь|ответьте)(?:\s+(?:мне|это|ответ|предыдущий ответ)){0,3}\s+(?:голосом|голсоом|голосовым)(?:\s+(?:это|мне|ответ))?)[?!.]*$/iu.test(text.trim());
}

export async function replayTelegramAssistantVoice(chatId: string, text: string, replyTo?: number): Promise<boolean> {
  const clean = stripAssistantSpeechMarkup(sanitizeAssistantReply(splitReaction(text).text, true));
  const { language } = prepareAssistantReply(clean);
  if (language === "text-only") return false;
  const paragraphs = splitHumanMessages(clean).flatMap(part => part.split(/\n+/));
  const chunks = paragraphs.flatMap(paragraph => {
    // A word boundary inside a grouped amount can change the spoken value.
    const numeric = /\p{N}/u.test(paragraph);
    const normalized = paragraph.replace(/[^\S\r\n]{2,}/gu, " ");
    return splitHumanMessages(normalized, numeric ? undefined : ASSISTANT_VOICE_PART_CHARS)
      .map(text => ({ text, numeric }));
  });
  for (const [index, { text: chunk, numeric }] of chunks.slice(0, MAX_HUMAN_PARTS).entries()) {
    if (!numeric && chunk.length > ASSISTANT_VOICE_PART_CHARS) return false;
    const { part, fallbackLanguage } = prepareAssistantVoicePart(chunk, false, language);
    if (part.truncated || part.language === "text-only" || part.speech.length < 3) return false;
    const target = index === 0 ? replyTo : undefined;
    const delivered = fallbackLanguage
      ? await sendAssistantVoiceReply(chatId, chunk, target, fallbackLanguage)
      : await sendAssistantVoiceReply(chatId, chunk, target);
    if (!delivered) return false;
  }
  return chunks.length > 0 && chunks.length <= MAX_HUMAN_PARTS;
}

async function firstLocalPropertyPhoto(id: string) {
  const row = await prisma.propertyPhoto.findFirst({
    where: { property: { id, deletedAt: null } },
    orderBy: [{ order: "asc" }, { id: "asc" }],
    select: { url: true },
  });
  const name = /^\/uploads\/([a-zA-Z0-9_.-]+\.(?:jpe?g|png|webp))$/i.exec(row?.url ?? "")?.[1];
  if (!name) return null;
  try {
    const root = await realpath(uploadsDir);
    const file = await realpath(path.join(root, name));
    if (path.relative(root, file) !== name) return null;
    const info = await stat(file);
    return info.isFile() && info.size > 0 && info.size <= 10_000_000 ? file : null;
  } catch { return null; }
}

/** A photo and an ordinary CRM link are derived only from a verified property card. */
export async function sendTelegramPropertyCard(chatId: string, card: AssistantPropertyCard, maskContacts: boolean, replyTo?: number): Promise<boolean> {
  const base = process.env.CRM_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (!base || !/^\/properties\/[\da-f-]+$/i.test(card.href)) return false;
  let url: URL;
  try { url = new URL(base + card.href); } catch { return false; }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return false;
  const label = nameForLink(card.title);
  const title = sanitizeAssistantReply(label.includes(card.code) ? label : `${card.code} · ${label}`, maskContacts).slice(0, 72);
  const amount = card.price.toLocaleString("ru-RU");
  const details = [card.rooms ? `${card.rooms} комн.` : "", card.areaSqm ? `${card.areaSqm} м²` : "", card.district ?? ""].filter(Boolean).join(" · ");
  const status = ({ AVAILABLE: "В продаже", RESERVED: "Забронирован", SOLD: "Продан", WITHDRAWN: "Снят с продажи" } as Record<string, string>)[card.status];
  const caption = sanitizeAssistantReply([
    `Нашла объект. Цена — ${amount} ${card.currency === "USD" ? "USD" : "сомони"}.`,
    [details, status].filter(Boolean).join(" · "), card.agent ? `Агент: ${card.agent}` : "",
  ].filter(Boolean).join("\n"), maskContacts);
  const buttons = [[{ text: title, url: url.toString() }]];
  let photo: string | null = null;
  if (!maskContacts) {
    try { photo = await firstLocalPropertyPhoto(card.id); } catch { /* The card still works without its photo. */ }
  }
  if (photo) {
    try {
      void sendChatAction(chatId, undefined, "upload_photo");
      await sendPhotoFromDisk(chatId, photo, caption, buttons, 12_000, { singleAttempt: true, replyTo });
      return true;
    } catch (error) {
      if (!(error instanceof TelegramApiError && error.errorCode === 400)) {
        console.warn("[telegram:assistant] property photo delivery unconfirmed");
        return true;
      }
    }
  }
  await sendMessageWithButtons(chatId, caption, buttons, replyTo);
  return true;
}
