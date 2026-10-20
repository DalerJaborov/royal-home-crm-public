import type { Client } from "../types";

/**
 * id самого свежего диалога клиента (та же сортировка, что в `conversationsOf`
 * в pages/ClientDetail.tsx) — для перехода на телефоне в `/messages?open=<id>` (хвосты оболочки
 * 17.09.2026, п.5: «Написать» должно вести в обычный чат, а не открывать
 * шторку-пузырь поверх карточки). `ClientConversation` не хранит id (панели
 * переписки он не нужен), поэтому здесь читаем его прямо из `client`.
 */
export function primaryConversationId(client: Client): string | null {
  const list: { id: string; lastAt?: string }[] = client.botConversation.map((c) => ({
    id: c.id,
    lastAt: c.messages.at(-1)?.at,
  }));
  if (client.telegramConversation) {
    // Список «Сообщений» и сервер (routes/conversations.ts) различают Telegram
    // по префиксу `tg_`: без него /messages?open= искал id среди диалогов
    // Instagram/WhatsApp и открывал пустоту (23.09.2026, перенос правки #479).
    list.push({ id: `tg_${client.telegramConversation.id}`, lastAt: client.telegramConversation.messages.at(-1)?.at });
  }
  if (list.length === 0) return null;
  list.sort((a, b) => {
    if (!a.lastAt) return 1;
    if (!b.lastAt) return -1;
    return new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime();
  });
  return list[0].id;
}
