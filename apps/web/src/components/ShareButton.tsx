import { useEffect, useRef, useState } from "react";
import { Check, Share2 } from "lucide-react";
import { shareOrCopy, type ShareContent } from "../lib/share";
import { toast } from "../store/toast";

interface ShareButtonProps extends ShareContent {
  /** Подпись. По умолчанию — про отправку клиенту, самый частый случай. */
  label?: string;
  /** Классы кнопки: в карточке она во всю ширину, в строке списка — значком. */
  className?: string;
}

const DEFAULT_CLASS =
  "w-full flex items-center justify-center gap-1.5 text-[15px] font-semibold rounded-lg py-2 border border-line text-gray-700 hover:bg-hover-tint";

/**
 * Кнопка «Отправить» — системное меню «Поделиться», а где его нет, буфер обмена.
 *
 * Отдельным компонентом, потому что отправлять придётся не только объект:
 * ссылка на карточку клиента коллеге, ссылка на сделку руководителю. Логика
 * отказов и подтверждений одна и та же, и дублировать её по экранам нельзя.
 */
export function ShareButton({ label = "Отправить клиенту", className, ...content }: ShareButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  // Таймер галочки живёт дольше, чем нужен, если экран закрыли раньше: без
  // снятия setState прилетит в размонтированный компонент.
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  function handleClick() {
    /**
     * Без `await` перед вызовом: право открыть системное меню живёт ровно до
     * первой паузы после нажатия (см. lib/share.ts). Поэтому обработчик
     * синхронный, а результат разбирается уже в `then`.
     */
    void shareOrCopy(content).then((result) => {
      if (result === "copied") {
        setCopied(true);
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCopied(false), 2000);
        toast.success("Ссылка скопирована");
      } else if (result === "failed") {
        toast.error("Не удалось отправить ссылку");
      }
      // "shared" — системное меню уже отчиталось само, своё сообщение поверх
      // него лишнее. "cancelled" — человек передумал, это не событие.
    });
  }

  return (
    <button type="button" onClick={handleClick} className={className ?? DEFAULT_CLASS}>
      {copied ? <Check className="w-3.5 h-3.5" /> : <Share2 className="w-3.5 h-3.5" />}
      {copied ? "Скопировано" : label}
    </button>
  );
}
