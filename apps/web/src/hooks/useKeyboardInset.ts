import { useEffect } from "react";
import { trackKeyboard } from "../lib/keyboardInset";

/**
 * Экранная клавиатура в переменных на <html>, пока хук активен: `--rh-kb-inset`, `--rh-vv-h` и признак
 * `data-kb-open` (расчёт — lib/keyboardInset.ts, один на всё приложение).
 *
 * Зовут три места: оболочка (AppLayout — прячет нижнее меню при клавиатуре на любом экране с полем),
 * шторка (Rh2Sheet — поднимает подвал над клавиатурой) и панель ассистента. Счётчик подписчиков
 * в lib/keyboardInset.ts не даёт одному закрыться и снять переменные у остальных.
 *
 * Порог 80 px отсекает дрожание адресной строки браузера (она тоже меняет visualViewport).
 */
export function useKeyboardInset(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return trackKeyboard();
  }, [active]);
}
