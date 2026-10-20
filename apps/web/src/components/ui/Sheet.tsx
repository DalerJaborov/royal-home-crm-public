import type { ReactNode } from "react";
import { Rh2Sheet } from "../rh2/Rh2Sheet";

/**
 * Примитив слоя 2 (тема «Royal Home 2026»): панель-шторка.
 *
 * ПОСЛЕ ПЕРЕНОСА ЭТО ТОНКАЯ ОБЁРТКА над `components/rh2/Rh2Sheet`. Раньше здесь
 * лежала вторая, своя реализация того же окна: портал, ловушка фокуса, Esc,
 * блокировка прокрутки, свайп, раскладка «справа на ПК, снизу на телефоне» —
 * всё в точности как в `Rh2Sheet`, только на утилитах Tailwind и без области
 * темы. Две копии одного окна расходятся: чинишь Esc в одной, вторая молчит.
 * Поэтому здесь остался только переходник, а разметку эталона
 * (`.sheet-back`, `.sheet.right`/`.sheet.bottom`, `.sheet-h`/`.sheet-b`/`.sheet-f`)
 * рисует общий компонент.
 *
 * `widthClassName` больше ни на что не влияет: ширину панели задаёт сам эталон
 * (`.sheet.right` — `min(440px, 100vw - 20px)`). Проп сохранён, чтобы не ломать
 * подпись у будущих вызывающих; на момент переноса вызывающих нет ни одного
 * (`grep "ui/Sheet"` по apps/web — пусто), поэтому и переходник безопасен.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  /** Заголовок в шапке шторки. */
  title?: ReactNode;
  children: ReactNode;
  /** Липкий низ (кнопки действия). */
  footer?: ReactNode;
  /** @deprecated ширину задаёт эталон темы; проп оставлен ради подписи. */
  widthClassName?: string;
}) {
  return (
    <Rh2Sheet open={open} onClose={onClose} title={title ?? "Панель"} footer={footer}>
      {children}
    </Rh2Sheet>
  );
}
