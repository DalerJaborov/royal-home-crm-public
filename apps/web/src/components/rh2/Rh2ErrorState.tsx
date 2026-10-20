import { RefreshCw } from "lucide-react";

/**
 * Общий кирпич «не удалось загрузить» — та же идиома `.empty`, что у
 * `Rh2EmptyState`, но с кнопкой повтора вместо второстепенной подсказки.
 * Разбор §2.6 `docs/ui-audit-night-20-09.md`: раньше это была то голая
 * красная строка вне карточки, то `.quiet crit` с подчёркнутой ссылкой —
 * владелец читал это как поломку. Здесь — тихая строка ВНУТРИ карточки,
 * серый значок (не `--crit`), одна человеческая фраза без слов вроде «сбой
 * связи»/«снимок»/«журнал недоступен», и кнопка-пилюля «Попробовать снова»,
 * а не подчёркнутая ссылка.
 *
 * `message` — необязательный, для тех редких случаев, где стоит уточнить
 * что именно не загрузилось («Не удалось загрузить звонки. Попробуйте ещё
 * раз.»); формулировка всё равно должна остаться человеческой.
 */
export function Rh2ErrorState({
  message = "Не удалось загрузить. Попробуйте ещё раз.",
  onRetry,
  retrying,
}: {
  message?: string;
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="empty">
      <span className="ic">
        <RefreshCw className="i" aria-hidden />
      </span>
      <p>{message}</p>
      <button className="pill ghost" type="button" onClick={onRetry} disabled={retrying}>
        {retrying ? "Пробуем снова…" : "Попробовать снова"}
      </button>
    </div>
  );
}
