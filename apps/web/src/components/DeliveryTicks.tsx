import { CheckCheck } from "lucide-react";
import type { ConversationMessage } from "@royal-home/shared";

/**
 * Галочки доставки WhatsApp (18.08.2026) — только WhatsApp присылает эти статусы
 * (см. messengers/meta.ts: parseStatusUpdates), поэтому у остальных каналов
 * `deliveryStatus` всегда пуст и компонент рендерит null сам, без доп. проверки
 * канала на месте вызова.
 */
/**
 * ОБЛИК. Галочек доставки в прототипе темы «Royal Home 2026» нет вовсе — класс
 * `.tick` там занят числовой метрикой (17px, табличные цифры), а не значком
 * состояния. Поэтому в новом облике признак собран из тех же классов макета:
 * значок наследует цвет подписи `.bub .tm`, в которой стоит, а «прочитано»
 * помечается токеном `--ok` (не доставлено — `--crit`). Ничего не выброшено:
 * состояние и его подпись для чтения с экрана остались прежними.
 *
 * Проп `rh2` необязателен: компонент рендерят ещё инбокс (Messages.tsx) и
 * мобильный диалог (MobileChatView.tsx), которые пока живут вне `.rh2` и
 * должны выглядеть ровно как раньше.
 */
export function DeliveryTicks({
  status,
  className = "",
  rh2 = false,
}: {
  status?: ConversationMessage["deliveryStatus"];
  className?: string;
  rh2?: boolean;
}) {
  if (!status || status === "sent") return null;
  const read = status === "read";
  if (rh2) {
    if (status === "failed")
      return (
        <span style={{ color: "var(--crit)" }} title="Не доставлено">
          !
        </span>
      );
    return (
      <CheckCheck
        className="i"
        style={{ width: 13, height: 13, color: read ? "var(--ok)" : undefined }}
        strokeWidth={2.5}
        aria-label={read ? "Прочитано" : "Доставлено"}
      />
    );
  }
  if (status === "failed") return <span className={`text-red ${className}`} title="Не доставлено">!</span>;
  return (
    <CheckCheck
      className={`inline-block w-3 h-3 ${read ? "text-blue" : ""} ${className}`}
      strokeWidth={2.5}
      aria-label={read ? "Прочитано" : "Доставлено"}
    />
  );
}
