import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Check, CheckCheck } from "lucide-react";
import type { ConversationMessage } from "../../../types";
import { Rh2Sheet } from "../../rh2/Rh2Sheet";
import { BotReplyFeedback } from "../../BotReplyFeedback";
import { messageInfoRows } from "./chatThread";

/**
 * «СВЕДЕНИЯ О СООБЩЕНИИ» (новый вид, владелец 20.11.2026).
 *
 * В окне переписки наши ответы — бота и сотрудника — выглядят одинаково, как у
 * бизнес-аккаунта WhatsApp: ни метки «бот», ни «Верно/Неверно» под пузырём.
 * Кто ответил, когда и дошло ли — здесь, по долгому нажатию на пузырь (или по
 * правой кнопке / кнопке «⌄» на компьютере). Сюда же переехала оценка ответа
 * бота: BotReplyFeedback сам показывается только при `settings.manage`
 * (директор, админ) — агент её не видит, как и раньше.
 */
export function RoyalMessageInfo({
  message,
  text,
  conversationId,
  messageKey,
  index,
  readOnly,
  onClose,
}: {
  message: ConversationMessage;
  /** Текст пузыря в том виде, в каком он на экране (без служебных подсказок). */
  text: string;
  conversationId: string;
  messageKey: string;
  index: number;
  readOnly: boolean;
  onClose: () => void;
}) {
  const isBotAnswer = message.role === "assistant" && (!message.by || message.by.kind === "bot");
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
  }
  return (
    <Rh2Sheet
      title="Сведения о сообщении"
      onClose={onClose}
      layer="above-chat"
      className="ry-msg-info"
      footer={text ? (
        <button type="button" className="pill ghost" onClick={copy}>
          {copied === "ok" ? "Скопировано" : copied === "fail" ? "Не удалось скопировать" : "Копировать текст"}
        </button>
      ) : undefined}
    >
      <dl className="ry-msg-info-rows">
        {messageInfoRows(message).map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      {isBotAnswer && !readOnly && message.sourceChannel !== "TELEGRAM_DIRECT" && (
        <section className="ry-msg-info-rate" aria-label="Оценка ответа бота">
          <BotReplyFeedback conversationId={conversationId} message={message} messageKey={messageKey} index={index} />
        </section>
      )}
    </Rh2Sheet>
  );
}

/**
 * Галочки как в мессенджере — только у наших сообщений: одна серая
 * «отправлено», две серые «доставлено», две цветные «прочитано», «!» — не дошло.
 */
export function RoyalTicks({ status }: { status: ConversationMessage["deliveryStatus"] }) {
  if (!status) return null;
  if (status === "failed") return <span className="ry-tick" data-status="failed" role="img" aria-label="Не доставлено">!</span>;
  if (status === "sent") return <Check className="ry-tick" data-status="sent" role="img" aria-label="Отправлено" strokeWidth={2.4} />;
  return <CheckCheck className="ry-tick" data-status={status} role="img" aria-label={status === "read" ? "Прочитано" : "Доставлено"} strokeWidth={2.4} />;
}

const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE = 10;

/**
 * Долгое нажатие пальцем — без таймеров на каждый пузырь заранее: таймер
 * заводится только на касание и гаснет при сдвиге (прокрутка ленты не должна
 * открывать шторку). Мышь не нужна — у неё правая кнопка и «⌄».
 */
export function useLongPress(onLongPress: (target: HTMLElement) => void) {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };
  return {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (event.pointerType === "mouse") return;
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-chat-message]");
      if (!target || (event.target as HTMLElement).closest("a, button, audio, video, input, textarea")) return;
      clear();
      start.current = { x: event.clientX, y: event.clientY };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        onLongPress(target);
      }, LONG_PRESS_MS);
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      if (!start.current) return;
      if (Math.abs(event.clientX - start.current.x) > MOVE_TOLERANCE || Math.abs(event.clientY - start.current.y) > MOVE_TOLERANCE) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
  };
}
