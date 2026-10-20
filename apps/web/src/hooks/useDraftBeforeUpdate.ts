import { useEffect, useRef } from "react";
import { consumeDraftBeforeUpdate, subscribeDraftBeforeUpdate } from "../lib/draftBeforeUpdate";

/**
 * Спасает несохранённое значение поля/формы от принудительной перезагрузки
 * при автообновлении приложения — см. `lib/draftBeforeUpdate.ts` (находка
 * ночной проверки 24.09.2026, №246/К2-4).
 *
 * Подключается там, где есть незафиксированный ввод: поле ответа в чате
 * (`Messages.tsx`/`MobileChatView.tsx` — ключ id разговора) и форма клиента
 * (`ClientFormModal.tsx` — ключ id клиента или вида новой карточки).
 *
 * @param key      стабильный ключ (id разговора/клиента); `null` — сохранять
 *                 нечего (например, разговор ещё не выбран).
 * @param value    текущее значение поля/формы.
 * @param restore  вызывается один раз при монтировании/смене `key`, если для
 *                 него нашёлся черновик.
 * @param isEmpty  что считать «нечего сохранять»; по умолчанию — фальшивое
 *                 значение (пустая строка и т.п.), подходит для текстовых полей.
 */
export function useDraftBeforeUpdate<T>(
  key: string | null,
  value: T,
  restore: (value: T) => void,
  isEmpty: (value: T) => boolean = (v) => !v
): void {
  // Рефы, а не зависимости эффектов: событие может прийти в любой момент,
  // читать нужно самое свежее значение, а не то, что было при подписке.
  const valueRef = useRef(value);
  valueRef.current = value;
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  const isEmptyRef = useRef(isEmpty);
  isEmptyRef.current = isEmpty;

  // Восстановление — один раз на каждый key (открыли этот разговор/эту карточку).
  useEffect(() => {
    if (!key) return;
    const draft = consumeDraftBeforeUpdate<T>(key);
    if (draft !== null && !isEmptyRef.current(draft)) restoreRef.current(draft);
    // isEmptyRef/restoreRef — рефы, намеренно вне зависимостей.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Сохранение — по сигналу перед подменой сборки, не на каждое изменение.
  useEffect(() => {
    if (!key) return;
    return subscribeDraftBeforeUpdate(
      key,
      () => valueRef.current,
      (v) => isEmptyRef.current(v)
    );
  }, [key]);
}
