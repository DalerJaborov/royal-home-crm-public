import { useEffect } from "react";
import { useToastStore, type Toast } from "../store/toast";
import { hapticError, hapticSuccess } from "../lib/haptics";
import { playError, playSuccess } from "../lib/aiSounds";
import { Rh2Portal } from "./rh2/Rh2Scope";
import { useToastStack } from "./rh2/useToastStack";

/** Сколько уведомление висит на экране. Достаточно, чтобы заметить боковым
 *  зрением, и мало, чтобы не мешать следующему действию. Ошибка живёт дольше:
 *  её нужно успеть прочитать, а не просто увидеть. */
const LIFETIME_MS = { success: 2200, error: 5000 } as const;

function ToastCard({
  toast,
  innerRef,
  style,
}: {
  toast: Toast;
  innerRef: (el: HTMLElement | null) => void;
  style: React.CSSProperties;
}) {
  const dismiss = useToastStore((s) => s.dismiss);
  const isError = toast.kind === "error";

  useEffect(() => {
    const timer = setTimeout(() => dismiss(toast.id), LIFETIME_MS[toast.kind]);
    return () => clearTimeout(timer);
  }, [toast.id, toast.kind, dismiss]);

  /**
   * ВИБРО-ОТКЛИК НА РЕЗУЛЬТАТ — здесь, а не в каждой кнопке приложения.
   *
   * Через уведомления проходит каждое действие, у которого есть исход: сохранение
   * карточки, перетаскивание сделки, смена статуса, отказ сервера. Одно место
   * вместо десятков вызовов по кнопкам — и нельзя забыть добавить отклик в новую
   * форму: она и так покажет уведомление.
   *
   * Успех и ошибка различаются на ощупь (один импульс против двойного): телефон
   * в кармане или рука на руле — и человек уже знает исход, не глядя на экран.
   */
  useEffect(() => {
    if (toast.kind === "error") hapticError();
    else hapticSuccess();
  }, [toast.id, toast.kind]);

  /**
   * ЗВУК ИСХОДА — рядом с вибро и по той же причине (владелец 12.09.2026: «все
   * звуки, которых нет, добавь»).
   *
   * Тут же, а не в кнопках: через уведомление проходит каждое действие с
   * исходом, и новая форма получает звук, ничего про него не зная. Тумблер
   * общий («Звуки ИИ» в оформлении) — проверку делает сам lib/aiSounds.ts.
   *
   * Тихие часы этот звук НЕ глушат намеренно: он отвечает на собственное
   * нажатие человека, и молчание в ответ читается как «не сработало». Тишина
   * 21:00–08:00 накрывает звуки СОБЫТИЙ, которые приходят сами.
   */
  useEffect(() => {
    if (toast.kind === "error") playError();
    else playSuccess();
  }, [toast.id, toast.kind]);

  return (
    // Стопка — общий хук `useToastStack`: он мерит высоту каждой пилюли и
    // поднимает соседние ровно на неё (почему не постоянный шаг, см. там).
    <div ref={innerRef} className="toast" role={isError ? "alert" : "status"} style={style}>
      {/* Точка эталона вместо цветной плашки: успех и ошибка различимы глазом,
          но плашка остаётся спокойной (договор дизайна §6.1). */}
      <span className={isError ? "dot crit" : "dot ok"} aria-hidden />
      <span>{toast.text}</span>
      {/* Клик закрывает досрочно: уведомление может накрыть кнопку, до которой
          человек тянется прямо сейчас. Кнопка, а не весь блок: у строки-статуса
          не должно быть невидимой зоны нажатия во весь экран. */}
      <button type="button" className="undo" onClick={() => dismiss(toast.id)}>
        Скрыть
      </button>
    </div>
  );
}

/**
 * Стопка уведомлений над нижним краем экрана. Показывает, что действие
 * сохранилось, там где кнопки «Сохранить» нет вовсе: перетаскивание сделки,
 * галочки, смена статуса. Без такой обратной связи человек ищет кнопку
 * сохранения и не находит.
 *
 * ОБЛИК — примитив `.toast` эталона «Royal Home 2026»: тёмная пилюля по центру
 * низа, на телефоне поднятая над нижним меню самой темой. Ошибка и успех больше
 * не различаются цветом плашки: договор дизайна §6.1 запрещает кричащие
 * карточки, а разницу человек и так получает голосом диктора (`alert` против
 * `status`) и вибро-откликом.
 *
 * Портал с областью темы `.rh2` обязателен: уведомления показываются с любого
 * экрана, в том числе ещё не перенесённого, а `.toast` живёт только внутри
 * области (см. Rh2Scope.tsx).
 */
export function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const stack = useToastStack(toasts.length);
  if (toasts.length === 0) return null;

  return (
    <Rh2Portal>
      {toasts.map((toast, i) => (
        <ToastCard key={toast.id} toast={toast} innerRef={stack.ref(i)} style={stack.style(i)} />
      ))}
    </Rh2Portal>
  );
}
