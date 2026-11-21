import { useState } from "react";
import "./updateBanner.css";

/**
 * Плашка «Есть обновление · Обновить» (21.11.2026).
 *
 * Появляется ТОЛЬКО когда автоматическое обновление сдалось: несколько попыток
 * подряд вкладка возвращалась на старую сборку (lib/appUpdateReload.ts). До
 * этого в таком случае не было видно ничего: человек сидел на старой версии,
 * видел «Страница не найдена» на новом разделе и не знал, что делать.
 *
 * Компактная пилюля внизу экрана, не карточка и не окно — договор дизайна
 * §6.1: срочное сообщается строкой, а не криком. Кнопка делает полный сброс
 * (снять воркер, очистить кэши сборки, открыть свежую страницу); загруженные
 * файлы и очереди в IndexedDB не трогаются.
 */
export function UpdateBanner({ onUpdate }: { onUpdate: () => void | Promise<void> }) {
  const [pending, setPending] = useState(false);
  return (
    <div className="rh-update-pill" role="status" aria-live="polite">
      <span className="rh-update-pill-text">Есть обновление</span>
      <button
        type="button"
        className="rh-update-pill-btn"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void Promise.resolve()
            .then(onUpdate)
            .catch(() => setPending(false));
        }}
      >
        {pending ? "Обновляю…" : "Обновить"}
      </button>
    </div>
  );
}
