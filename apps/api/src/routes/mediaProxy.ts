import { Router } from "express";
import { r2PresignDownloadUrl } from "../lib/r2Client.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { prisma } from "../db.js";
import type { ConversationMessage } from "@royal-home/shared";

/**
 * Раздача ФОТО/ВИДЕО, отправленных агентом клиенту (18.08.2026), клиентам браузера
 * (тот же файл, который до этого забрала Meta). БЕЗ requireAuth — намеренно, тот же
 * компромисс, что раньше давала статика `/uploads`: секрета в файле нет (оператор
 * уже решил отправить его клиенту), а найти чужой ключ перебором нельзя — UUID в
 * имени (см. lib/outgoingMedia.ts). Гейтить правом `messages.viewAttachments`, как
 * закрытые вложения КЛИЕНТА (routes/attachments.ts), тут не нужно по той же причине,
 * по которой этого не требовал прежний путь `/uploads/msg-media/...`.
 *
 * 302 на presigned R2-ссылку, а не проксирование потоком (в отличие от
 * /properties/:id/videos/:videoId/file) — картинку в переписке рисует обычный
 * <img src>/<video src>, которому CORS/Blob-обходы не нужны, а лишний трафик через
 * наш сервер тут ни к чему.
 *
 * Ключ ограничен префиксом `chat-media/` — тем самым явно нельзя подсунуть сюда
 * произвольный ключ бакета (например, ключ видео объекта из другого раздела).
 */
export const mediaProxyRouter = Router();

// Express 5: безымянная звёздочка в пути больше не поддерживается — у шаблона
// обязано быть имя (`*splat`), а его значение приезжает МАССИВОМ сегментов, а не
// строкой под ключом «0», как было в Express 4.
mediaProxyRouter.get("/chat/*splat", async (req, res) => {
  const splat = (req.params as Record<string, string[] | string | undefined>).splat;
  const rest = Array.isArray(splat) ? splat.join("/") : (splat ?? "");
  const key = `chat-media/${rest}`;
  // Защита от обхода пути: ключ обязан остаться внутри своего префикса.
  const match = /^chat-media\/([^/]+)\/[a-zA-Z0-9-]+\.[a-z0-9]+$/.exec(key);
  if (!match) {
    return res.status(404).json({ error: "Файл не найден" });
  }

  // Уборка по сроку (lib/outgoingMediaCleanup.ts, 7 суток) стирает файл из R2, но
  // саму ссылку в переписке — нет: старая ссылка (открытая вкладка, пересланное
  // сообщение) без этой проверки редиректила бы на presigned-адрес НЕСУЩЕСТВУЮЩЕГО
  // объекта — R2 ответил бы 404 без какого-либо понятного текста. 410 Gone здесь
  // честнее 404: файл был, и мы точно знаем, почему его больше нет.
  const conversationId = match[1];
  try {
    const conv = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { messages: true } });
    const messages = (Array.isArray(conv?.messages) ? conv.messages : []) as unknown as ConversationMessage[];
    const expired = messages.some((m) => m.attachments?.some((a) => a.url === `/api/v1/media/chat/${rest}` && a.expiredAt));
    if (expired) {
      return res.status(410).json({ error: "Файл удалён по сроку хранения (7 дней) — доступен только в архиве Meta" });
    }
  } catch {
    // Отказ проверки не должен блокировать раздачу ещё живого файла — просто идём
    // дальше обычным путём, как если бы отметки об истечении не было.
  }

  let url: string | null;
  try {
    url = await r2PresignDownloadUrl(key);
  } catch (err) {
    void logSystemError("storage", `Файл переписки ${key} не подписан для скачивания: ${describeError(err)}`);
    return res.status(502).json({ error: "Не удалось получить файл" });
  }
  if (!url) return res.status(503).json({ error: "Хранилище файлов не настроено" });

  res.redirect(302, url);
});
