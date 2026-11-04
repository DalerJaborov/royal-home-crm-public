import { stat, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { formatPropertyCode, type AssistantPropertyCard } from "@royal-home/shared";
import { prisma } from "../db.js";
import { uploadsDir } from "../upload.js";
import type { AssistantActor } from "../ai/assistant/actor.js";
import { findClientsTool } from "../ai/assistant/tools/findClients.js";
import { sendChatAction, sendMessageWithButtons, sendPhotoFromDisk, TelegramApiError } from "./api.js";
import { assistantCardLinks, sanitizeAssistantReply, splitHumanMessages, splitReaction } from "./assistantReply.js";
import { sendAssistantVoiceReply } from "./assistantVoice.js";

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
  const head = `Клиенты агента ${agentsMatched?.[0] ?? name}. Всего доступных карточек — ${total}.`;
  if (!shown) return head;
  const list = items.map(item => `• [${item.code} · ${nameForLink(item.name)}](${item.href})`);
  return [head, total > shown ? `Показываю ${shown} из ${total}:` : "", ...list].filter(Boolean).join("\n");
}

export function isVoiceReplayRequest(text: string): boolean {
  return /^(?:(?:озвучь|озвучьте|прочитай)(?:\s+(?:это|ответ|последний ответ))?|(?:отправь|отправьте|пришли|пришлите|ответь|ответьте)(?:\s+(?:мне|это|ответ|предыдущий ответ)){0,3}\s+(?:голосом|голсоом|голосовым)(?:\s+(?:это|мне|ответ))?)[?!.]*$/iu.test(text.trim());
}

export async function replayTelegramAssistantVoice(chatId: string, text: string, replyTo?: number): Promise<boolean> {
  const clean = splitReaction(text).text;
  const paragraphs = splitHumanMessages(clean).flatMap(part => part.split(/\n+/).map(line => line.trim()).filter(Boolean));
  for (const [index, part] of paragraphs.slice(0, 4).entries()) {
    if (!(await sendAssistantVoiceReply(chatId, part, index === 0 ? replyTo : undefined))) return false;
  }
  return paragraphs.length > 0 && paragraphs.length <= 4;
}

async function firstLocalPropertyPhoto(ref: { id: string } | { shortId: number }) {
  const row = await prisma.propertyPhoto.findFirst({
    where: { property: { ...ref, deletedAt: null } },
    orderBy: [{ order: "asc" }, { id: "asc" }],
    select: { url: true, property: { select: { id: true, title: true, shortId: true } } },
  });
  const name = /^\/uploads\/([a-zA-Z0-9_.-]+\.(?:jpe?g|png|webp))$/i.exec(row?.url ?? "")?.[1];
  if (!name) return null;
  try {
    const root = await realpath(uploadsDir);
    const file = await realpath(path.join(root, name));
    if (path.relative(root, file) !== name) return null;
    const info = await stat(file);
    return info.isFile() && info.size > 0 && info.size <= 10_000_000 && row
      ? { file, property: row.property }
      : null;
  } catch { return null; }
}

/** The full list is already delivered. Add a few actual CRM photos when available. */
export async function sendTelegramPropertyPreviews(chatId: string, reply: string, replyTo?: number): Promise<void> {
  const links = assistantCardLinks(reply, true).filter(link => link.path.startsWith("/properties/")).slice(0, 3);
  const previews = await Promise.all(links.map(async link => {
    const identifier = link.path.slice("/properties/".length);
    const ref: { id: string } | { shortId: number } = /^\d+$/.test(identifier) ? { shortId: Number(identifier) } : { id: identifier };
    if ("shortId" in ref && (!Number.isSafeInteger(ref.shortId) || ref.shortId <= 0 || ref.shortId > 2_147_483_647)) return null;
    const photo = await firstLocalPropertyPhoto(ref).catch(() => null);
    return photo && { ...photo, url: link.url };
  }));
  const seen = new Set<string>();
  for (const preview of previews) {
    if (!preview || seen.has(preview.property.id)) continue;
    seen.add(preview.property.id);
    const code = formatPropertyCode(preview.property.shortId);
    const title = sanitizeAssistantReply(nameForLink(preview.property.title), true);
    const label = (title.includes(code) ? title : `${code} · ${title}`).slice(0, 72);
    try {
      void sendChatAction(chatId, undefined, "upload_photo");
      await sendPhotoFromDisk(chatId, preview.file, label, [[{ text: label, url: preview.url }]], 8_000, { singleAttempt: true, replyTo });
    } catch {
      // The text and its links are already available if preview delivery fails.
      return;
    }
  }
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
    try { photo = (await firstLocalPropertyPhoto({ id: card.id }))?.file ?? null; } catch { /* The card still works without its photo. */ }
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
