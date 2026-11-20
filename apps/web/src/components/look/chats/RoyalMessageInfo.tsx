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
/** Сколько ждать «отпускания» после долгого нажатия: дольше палец не держат. */
const SWALLOW_CLICK_MS = 1500;

/**
 * Долгое нажатие ВНЕ текста (а с текстом долгое нажатие выделяет слова, как везде —
 * ревью #332): по пустому месту пузыря, по времени, по стрелке. Значит, «Сведения»
 * открываются только когда это и задумано.
 */
export function isLongPressTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  if (target.closest(".ry-msg-text, a, button, audio, video, img, input, textarea")) return null;
  return target.closest<HTMLElement>("[data-chat-message]");
}

/**
 * Первый click после долгого нажатия гасится. iOS Safari, отпуская палец, шлёт
 * click в то, что ТЕПЕРЬ под пальцем, — а там уже фон открытой шторки, и шторка
 * закрывалась сразу же (ревью #332). Перехват — в фазе захвата на документе,
 * ровно один click и не дольше SWALLOW_CLICK_MS.
 */
export function swallowNextClick(doc: Document = document, ms = SWALLOW_CLICK_MS): () => void {
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    doc.removeEventListener("click", onClick, true);
    window.clearTimeout(timer);
  };
  const onClick = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    stop();
  };
  doc.addEventListener("click", onClick, true);
  const timer = window.setTimeout(stop, ms);
  return stop;
}

/**
 * Долгое нажатие пальцем — без таймеров на каждый пузырь заранее: таймер
 * заводится только на касание и гаснет при сдвиге (прокрутка ленты не должна
 * открывать шторку). Мышь не нужна — у неё правая кнопка и стрелка.
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
      const target = isLongPressTarget(event.target);
      if (!target) return;
      clear();
      start.current = { x: event.clientX, y: event.clientY };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        start.current = null;
        swallowNextClick();
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
