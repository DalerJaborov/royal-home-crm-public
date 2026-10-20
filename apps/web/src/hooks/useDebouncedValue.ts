import { useEffect, useState } from "react";

/** Возвращает значение с задержкой delayMs — используется для полей поиска, чтобы не
 *  дёргать API на каждое нажатие клавиши. */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
