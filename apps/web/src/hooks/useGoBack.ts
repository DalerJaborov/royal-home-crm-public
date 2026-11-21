import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { decideBack } from "../lib/goBack";

/**
 * «Назад», который всегда возвращает В ПРИЛОЖЕНИЕ — единственная дверь (решение и история — lib/goBack.ts).
 *
 * 21.09.2026: `window.history.length > 1` врал — он считает и страницы ДО приложения, и «Назад» уносил
 * обратно в Telegram. 21.11.2026: решение вынесено в lib/goBack.ts (номер записи `idx` React Router вместо
 * одного ключа `"default"`), сюда переведены стрелка шапки, жест от края и переписка.
 *
 * `fallback` — логичный родитель экрана, обязательный нарочно: «назад» без него и есть та кнопка, которая
 * иногда никуда не ведёт. `canPop: false` — экран знает, что предыдущая запись истории не его родитель.
 *
 * Здесь же — единственный в приложении шаг по истории назад (`navigate(-1)`); сторож
 * `src/lib/__tests__/goBackGuard.test.ts` не пускает его ни в один другой файл.
 */
export function useGoBack(fallback: string, options: { canPop?: boolean } = {}): () => void {
  const navigate = useNavigate();
  const location = useLocation();
  const canPop = options.canPop ?? true;
  return useCallback(() => {
    const state = typeof window !== "undefined" ? (window.history.state as { idx?: unknown } | null) : null;
    const step = decideBack(state, location.key, fallback, canPop);
    if (step.kind === "history") navigate(-1);
    else navigate(step.to, { replace: true });
  }, [navigate, location.key, fallback, canPop]);
}
