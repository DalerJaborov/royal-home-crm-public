/**
 * Служебные пометки вместо текста сообщения и то, как их называть человеку (20.11.2026, кадры владельца).
 *
 * Бот кладёт в историю «[вложение без текста]» (клиент прислал только файл) и «[сообщение без текста]»
 * (реакция, место, неподдерживаемое), «[вложение: image]» — тип от Meta. Человеку скобки ничего не говорят.
 * ОДНА функция на все места показа (чат, список чатов, карточка клиента, push сотрудникам); сервер и
 * браузер зовут её отсюда, а не держат копии текстов.
 */
export const BARE_ATTACHMENT_MARKER = "[вложение без текста]";
export const BARE_MESSAGE_MARKER = "[сообщение без текста]";

const WHERE: Record<string, string> = {
  WHATSAPP: "WhatsApp", INSTAGRAM: "Instagram", FACEBOOK: "Messenger", MESSENGER: "Messenger", TELEGRAM: "Telegram", TELEGRAM_DIRECT: "Telegram",
};

/** «посмотрите в WhatsApp» — по каналу; неизвестный канал — «в самом мессенджере». */
export function whereToLook(channel?: string | null): string {
  const name = channel ? WHERE[channel.toUpperCase()] : undefined;
  return name ? `в ${name}` : "в самом мессенджере";
}

export type ServiceMarkerKind = "attachment" | "message";

/** Это целиком служебная пометка бота? Фраза внутри живого текста клиента — нет. */
export function serviceMarkerKind(text: string | null | undefined): ServiceMarkerKind | null {
  const bare = (text ?? "").trim();
  if (bare === BARE_ATTACHMENT_MARKER) return "attachment";
  if (bare === BARE_MESSAGE_MARKER) return "message";
  return null;
}

/**
 * Подпись вместо пометки. null — это не пометка, текст остаётся как есть. Пустая строка — пометка лишняя
 * (файл показан рядом из `attachments`). `[сообщение без текста]` вложением не прикидываем: это реакция
 * или место, файла у него нет и не было.
 */
export function describeServiceMarker(
  text: string | null | undefined,
  opts: {
    hasAttachments?: boolean;
    channel?: string | null;
    /** Вложения реплики здесь не видны (список чатов, превью): файл мог сохраниться
     *  позже (lib/customerInputMedia.ts на сервере), утверждать «не сохранился» нельзя. */
    attachmentsUnknown?: boolean;
  } = {},
): string | null {
  const kind = serviceMarkerKind(text);
  if (!kind) return null;
  if (kind === "message") return "Сообщение без текста (реакция или место)";
  if (opts.hasAttachments) return "";
  if (opts.attachmentsUnknown) return "Клиент прислал файл";
  return `Клиент прислал файл — в CRM он не сохранился, посмотрите ${whereToLook(opts.channel)}`;
}

/**
 * Нейтральная подпись для push сотрудникам, когда текста нет и неизвестно, что именно пришло
 * (файл, голосовое или реакция): ничего не утверждает про то, сохранён ли файл в CRM.
 */
export const NO_TEXT_NOTE = "Клиент прислал сообщение без текста (файл, голосовое или реакцию) — откройте чат";

const KIND_WORD: Record<string, string> = { image: "фото", video: "видео", audio: "голосовое", file: "файл", document: "документ", sticker: "стикер", location: "место", contact: "контакт" };

/**
 * Слова для push сотрудникам вместо служебной строки бота (`[вложение: image]`, `[сообщение без текста]`, пусто).
 * `[сообщение без текста]` пишется только там, где медиа точно не было (lib/customerHeldMessage.ts), поэтому
 * «реакция или место» здесь честно; «[вложение без текста]» и пустой текст — нейтрально (NO_TEXT_NOTE).
 * Обычный текст клиента возвращается как есть.
 */
export function describeForStaff(excerpt: string | null | undefined): string {
  const text = (excerpt ?? "").trim();
  if (!text) return NO_TEXT_NOTE;
  if (text === BARE_MESSAGE_MARKER) return "Сообщение без текста (реакция или место) — откройте чат";
  if (text === BARE_ATTACHMENT_MARKER) return NO_TEXT_NOTE;
  const kinds = /^\[вложение:\s*([^\]]+)\]$/u.exec(text);
  if (kinds) {
    const words = [...new Set(kinds[1].split(",").map((k) => KIND_WORD[k.trim().toLowerCase()] ?? "файл"))];
    return `Клиент прислал ${words.join(", ")} — откройте чат`;
  }
  return text;
}
