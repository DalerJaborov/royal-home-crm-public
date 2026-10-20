import type { ConversationMessage } from "../types";
import { dushanbeTime } from "./date";

/**
 * СПИСОК ФОТО ВСЕЙ ПЕРЕПИСКИ — для просмотрщика ChatPhotoViewer (21.09.2026,
 * макет «Объект из переписки»: «свайп листает ВСЕ фото этой переписки, а не
 * только одного сообщения»).
 *
 * Список строится из уже загруженной вкладкой истории (allMessages в
 * Messages.tsx/MobileChatView.tsx) — второго похода на сервер нет, фото уже
 * пришли вместе с диалогом. Порядок — как в переписке, от старых к новым, тот
 * же, в котором сообщения и так отрисованы.
 */
export interface ChatPhotoEntry {
  /** Стабильный ключ строки — mid сообщения, если есть, иначе позиция. */
  key: string;
  /** Имя файла для GET /attachments/:name — null, если права нет вовсе
   *  (сервер тогда не прислал и url). */
  file: string | null;
  /** Готовый адрес — только у фото объекта, которые отправил бот (см.
   *  MessageAttachment.url); тогда качать через /attachments не нужно. */
  url: string | null;
  /** Файл убран уборкой по сроку хранения (lib/outgoingMediaCleanup.ts). */
  expired: boolean;
  /** «Фаррух, 10:14» / «Вы, 10:20» — подпись кадра в просмотрщике. */
  caption: string;
}

/** Все фото (kind:"image") из истории диалога, в порядке переписки. */
export function buildChatPhotoList(messages: ConversationMessage[], clientName: string | null): ChatPhotoEntry[] {
  const out: ChatPhotoEntry[] = [];
  messages.forEach((m, mi) => {
    if (!m.attachments?.length) return;
    m.attachments.forEach((a, ai) => {
      if (a.kind !== "image") return;
      const who = m.role === "user" ? clientName || "Клиент" : "Вы";
      const when = m.at ? dushanbeTime(m.at) : "";
      out.push({
        key: m.mid ? `${m.mid}:${ai}` : `msg-${mi}:${ai}`,
        file: a.file,
        url: a.url ?? null,
        expired: !!a.expiredAt,
        caption: when ? `${who}, ${when}` : who,
      });
    });
  });
  return out;
}

/** Сколько фото (kind:"image") стоит ПЕРЕД сообщением с абсолютным индексом
 *  `messageIndex` — смещение, которое прибавляют к индексу кадра внутри
 *  самого сообщения, чтобы получить его позицию в общем списке `buildChatPhotoList`.
 *  История диалога ограничена сотнями сообщений (окно чата, не архив за годы),
 *  поэтому линейный подсчёт на каждый клик — не проблема производительности. */
export function chatPhotoOffsetForMessage(messages: ConversationMessage[], messageIndex: number): number {
  let n = 0;
  for (let i = 0; i < messageIndex && i < messages.length; i++) {
    n += messages[i]?.attachments?.filter((a) => a.kind === "image").length ?? 0;
  }
  return n;
}
