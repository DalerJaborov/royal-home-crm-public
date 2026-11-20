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
  opts: { hasAttachments?: boolean; channel?: string | null } = {},
): string | null {
  const kind = serviceMarkerKind(text);
  if (!kind) return null;
  if (kind === "message") return "Сообщение без текста (реакция или место)";
  if (opts.hasAttachments) return "";
  return `Клиент прислал файл — в CRM он не сохранился, посмотрите ${whereToLook(opts.channel)}`;
}
