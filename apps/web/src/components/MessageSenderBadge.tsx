import { Bot, Send, Smartphone, User } from "lucide-react";
import type { MessageSender } from "@royal-home/shared";

/**
 * Кто написал реплику со стороны компании — бот, конкретный сотрудник или сама
 * CRM (автоматическая рассылка).
 *
 * До 12.08.2026 под каждым ответом стояла одна и та же подпись «Royal Home» с
 * иконкой бота, независимо от того, кто на самом деле писал: сама модель, агент,
 * ответивший вручную из инбокса или карточки, или служебная рассылка (просьба
 * подтвердить показ). Найдено владельцем: «всегда указывать, кто отвечает — бот
 * или какой оператор, соответствующие значки».
 *
 * `pill` (19.08.2026, просьба владельца — имя агента «прижато к сообщению»,
 * нечитаемо): десктопные диалоги (ClientChatPanel, Messages.tsx) передают
 * `pill` — закруглённый фон под цвет отправителя вместо голого текста впритык.
 * Мобильный вид (MobileChatView) СВОЙ пилл уже собрал сам через className
 * (чинили 18.08.2026 по отдельной жалобе — «CRM» выглядело отладочной
 * надписью) — там `pill` не передаётся, чтобы не наложить два разных фона
 * друг на друга.
 *
 * `sender` не задан — старая запись без поля или сбой разбора; трактуется как
 * бот, потому что подавляющее большинство таких реплик им и было (см.
 * MessageSender в @royal-home/shared).
 */
/** «Бот:»/«CRM:»/«Далер:» — короткий текстовый префикс для превью в списке
 *  диалогов, где иконке и badge-стилю уже нет места. */
export function senderPrefix(sender: MessageSender | undefined): string {
  if (!sender || sender.kind === "bot") return "Бот";
  if (sender.kind === "system") return "CRM";
  // Ответ руками из самого мессенджера: кто писал — Meta не сообщает (см. MessageSender).
  if (sender.kind === "manual") return "Вручную";
  return sender.agentName;
}

function Badge({
  tone,
  pillBg,
  pill,
  icon: Icon,
  label,
  className,
  title,
}: {
  tone: string;
  pillBg: string;
  pill: boolean;
  icon: typeof Bot;
  label: string;
  className: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 leading-none ${tone} ${pill ? `rounded-full px-1.5 py-[3px] ${pillBg}` : ""} ${className}`}
    >
      <Icon className={pill ? "w-2.5 h-2.5 shrink-0" : "w-3 h-3 shrink-0"} strokeWidth={2.3} />
      {label}
    </span>
  );
}

export function MessageSenderBadge({
  sender,
  className = "",
  pill = false,
  viewerAgentId,
}: {
  sender: MessageSender | undefined;
  className?: string;
  /** Плашка с фоном под цвет отправителя вместо голого текста — см. комментарий выше. */
  pill?: boolean;
  /**
   * ID того, кто сейчас смотрит переписку (07.09.2026, просьба владельца:
   * «как в обычном мессенджере — там своё имя над своими же сообщениями не
   * пишут»). Своё имя видеть незачем — и так понятно, кто писал; а вот имя
   * КОЛЛЕГИ, ответившего в тот же диалог, по-прежнему важно директору и
   * другим агентам с доступом (`messages.view`) — поэтому скрываем ТОЛЬКО
   * при точном совпадении agentId, не вообще все именные плашки.
   */
  viewerAgentId?: string | null;
}) {
  if (sender?.kind === "agent" && viewerAgentId && sender.agentId === viewerAgentId) {
    return null;
  }
  if (!sender || sender.kind === "bot") {
    return <Badge tone="text-blue" pillBg="bg-blue/10" pill={pill} icon={Bot} label="Бот" className={className} />;
  }
  if (sender.kind === "system") {
    return <Badge tone="text-gray-400" pillBg="bg-line-soft" pill={pill} icon={Send} label="CRM" className={className} />;
  }
  // Кто-то ответил из приложения Instagram/Messenger, минуя CRM. Имени нет
  // намеренно: Meta его не сообщает, а выдумывать нельзя (см. MessageSender).
  if (sender.kind === "manual") {
    return (
      <Badge
        tone="text-amber"
        pillBg="bg-amber-bg"
        pill={pill}
        icon={Smartphone}
        label="Вручную"
        className={className}
        title="Ответ отправлен прямо в Instagram/Messenger, в обход CRM. Кто именно писал, неизвестно: Meta сообщает только аккаунт страницы, а не сотрудника"
      />
    );
  }
  return <Badge tone="text-green" pillBg="bg-green-bg" pill={pill} icon={User} label={sender.agentName} className={className} />;
}
