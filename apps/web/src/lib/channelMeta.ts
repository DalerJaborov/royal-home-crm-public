import { AtSign, Instagram, MessageSquare, Music2, Phone, SendHorizonal, Youtube } from "lucide-react";

/**
 * Метаданные канала мессенджера — в одном месте для десктопного инбокса
 * (pages/Messages.tsx) и мобильного списка чатов (components/mobile/MobileChatsList.tsx).
 * Жили локально в Messages.tsx; вынесены при мобильном редизайне 17.08.2026,
 * чтобы мобильные компоненты не импортировали страницу (цикл) и не копировали список.
 */
export const CHANNEL_META: Record<string, { label: string; icon: typeof Instagram; tint: string }> = {
  INSTAGRAM: { label: "Instagram", icon: Instagram, tint: "text-pink-500" },
  WHATSAPP: { label: "WhatsApp", icon: Phone, tint: "text-green" },
  FACEBOOK: { label: "Facebook", icon: MessageSquare, tint: "text-blue" },
  TELEGRAM: { label: "Telegram", icon: SendHorizonal, tint: "text-blue" },
  VIBER: { label: "Viber", icon: MessageSquare, tint: "text-purple-500" },
  VK: { label: "ВКонтакте", icon: MessageSquare, tint: "text-blue" },
  // Площадки публикации, а не мессенджеры: в переписке они не встречаются, но
  // раздел «Расписание» в маркетинге показывает, куда уйдёт ролик, теми же
  // подписями. Без этих двух строк запасная ветка ниже давала «Youtube» и
  // «Tiktok» — написание, которого у самих площадок нет.
  YOUTUBE: { label: "YouTube", icon: Youtube, tint: "text-red-500" },
  TIKTOK: { label: "TikTok", icon: Music2, tint: "text-gray-400" },
  THREADS: { label: "Threads", icon: AtSign, tint: "text-gray-400" },
};

/** Метаданные канала; незнакомый канал не теряется —
 *  показывается с нейтральной иконкой и «очеловеченным» названием.
 *
 *  Тип допускает null/undefined НАМЕРЕННО. Раньше стояло `channel: string`, и
 *  этого хватало, чтобы `tsc` был доволен: типы ответа API описаны оптимистично,
 *  а канал у диалога в базе может быть пустым. В проде это давало падение всего
 *  экрана «Сообщения» — в журнале ошибок 08.09.2026 дважды за день
 *  `null is not an object (evaluating 't.charAt')`, где `t` — этот параметр
 *  после минификации. Проверка типов такое не ловит по определению: она верит
 *  описанию ответа, а не самому ответу. */
export function channelMeta(
  channel: string | null | undefined,
): { label: string; icon: typeof Instagram; tint: string } {
  if (!channel) return { label: "Без канала", icon: MessageSquare, tint: "text-gray-400" };
  return (
    CHANNEL_META[channel] ?? {
      label: channel.charAt(0) + channel.slice(1).toLowerCase().replace(/_/g, " "),
      icon: MessageSquare,
      tint: "text-gray-400",
    }
  );
}

/** Инициалы для аватара — из первых двух слов имени.
 *  Без имени (бот его ещё не узнал) — нейтральный «?». */
export function initialsFromName(name: string | null): string {
  if (!name) return "?";
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}
