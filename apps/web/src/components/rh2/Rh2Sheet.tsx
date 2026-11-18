import { useEffect, useRef } from "react";
import type { FormEvent, ReactNode } from "react";
import { Rh2Portal } from "./Rh2Scope";
import { useScrollLock } from "../../hooks/useScrollLock";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useMobileUx } from "../../hooks/useMobileUx";
import { useSwipeToDismiss } from "../BottomSheet";

/**
 * Шторка темы «Royal Home 2026» — единственный корпус модальных окон CRM.
 *
 * СВЕДЕНИЕ ДВУХ ВОЛН (09.09.2026). Волна окон клиентов и волна окон команды и
 * системы делали один и тот же корпус независимо и по-разному: первая — формой
 * с порталом внутри самого файла, вторая — `<aside>` внутри `Rh2Portal` из
 * `Rh2Scope`. Реализация оставлена ОДНА, собранная из обеих: корпус (форма,
 * `wide`, `dismissible`, `closeOnBackdrop`, `onSubmit`) — от волны клиентов,
 * область темы — общая, из `Rh2Scope` (её же используют меню, панели и
 * всплывающие строки), плюс `role` и `data-sheet-scroll` от волны системы.
 *
 * ПОЧЕМУ ПОРТАЛ ОБЁРНУТ В `.rh2`. Эталонный CSS (`theme-2026-proto.css`) весь
 * ограничен областью `.rh2`, а `createPortal` уносит разметку в `document.body`,
 * то есть ЗА пределы обёртки экрана (`Rh2Screen`). Без собственной обёртки
 * классы `.sheet`, `.pill`, `.fld` не значат ничего: окно рендерится голой
 * разметкой, при этом ни сборка, ни тесты, ни консоль об этом не сообщают —
 * видно только глазами на открытом окне. Обёртка живёт в `Rh2Scope`, в
 * единственном месте на все окна, меню и панели, а не переписывается в каждом.
 *
 * ПОЧЕМУ `data-no-sheet`. В `index.css` есть общее правило: любое
 * `[role="dialog"]` на узком экране превращается в шторку старого облика
 * (`height:auto!important`, свои скругления, своя ручка). У этой шторки подача
 * уже своя — прототипные `.sheet.right` / `.sheet.bottom`, — и два набора
 * правил дрались бы за высоту и радиусы. Признак снимает окно со старого
 * правила целиком; ручку жеста рисуем прототипным `.grab`.
 *
 * ПОЧЕМУ ПАНЕЛЬ ВСЕГДА `<form>`. Половина окон CRM — формы с обязательными
 * полями, и кнопка отправки живёт в подвале (`.sheet-f`). Отдельный `<form>`
 * внутри тела не накрыл бы подвал, а два варианта корневого элемента дали бы
 * две разные ветки поведения. Портал уносит окно в `body`, вложенных форм не
 * возникает — при условии, что окно не заводит свою форму внутри (окно
 * подтверждения личности такую форму имело и переведено на `onSubmit` корпуса).
 *
 * ПОЧЕМУ `data-sheet-scroll` НА ТЕЛЕ. Смахивание вниз разрешено только когда
 * содержимое прокручено в самый верх, а прокручиваемую область
 * `useSwipeToDismiss` ищет по этому признаку (запасной вариант `.overflow-y-auto`
 * — класс старого облика, у разметки эталона его нет). Без признака жест
 * «листаю форму вверх» посреди заполнения закрывал бы окно вместе с введённым.
 *
 * ЧТО СОХРАНЕНО ОТ СТАРЫХ ОКОН (ни одна функция не должна пострадать):
 * ловушка фокуса, возврат фокуса на вызвавшую кнопку, Esc, неподвижный фон,
 * смахивание вниз на телефоне, закрытие кликом по подложке.
 */
export function Rh2Sheet({
  open = true,
  onClose,
  title,
  children,
  footer,
  onSubmit,
  dismissible = true,
  closeOnBackdrop,
  wide = false,
  role = "dialog",
  ariaLabel,
  closeLabel,
  layer,
  className,
}: {
  /** По умолчанию окно открыто: большинство окон CRM монтируются уже открытыми. */
  open?: boolean;
  onClose: () => void;
  /** Заголовок шторки (`.sheet-h h2`) — он же метка окна для скринридера. */
  title: ReactNode;
  children: ReactNode;
  /** Подвал `.sheet-f`: главная `.pill` и `.pill.ghost` «Отмена». */
  footer?: ReactNode;
  /** Форма: отправка по Enter и по кнопке `type="submit"` в подвале. */
  onSubmit?: (e: FormEvent) => void;
  /** Окно закрывается по Esc, смахиванием и кнопкой «Закрыть» в шапке. */
  dismissible?: boolean;
  /**
   * Клик мимо окна закрывает его. По умолчанию — как `dismissible`, но формы, в
   * которых есть что терять (запись разговора, форма клиента), ставят `false`:
   * промах пальцем мимо шторки на телефоне стирал набранный текст без вопроса.
   */
  closeOnBackdrop?: boolean;
  /**
   * Широкая шторка для окон со списком карточек и двухколоночных форм.
   * Ширина задана значением, а не своим классом: прототип знает только
   * `.sheet.right` (440 px), а заводить рядом с ним `.sheet.wide` значило бы
   * добавить в тему имя, которого в договоре дизайна нет.
   */
  wide?: boolean;
  /** `alertdialog` для необратимых действий: диктор объявляет окно сразу. */
  role?: "dialog" | "alertdialog";
  /** Метка окна, когда заголовок — не простой текст. */
  ariaLabel?: string;
  /** Distinguish dismissing a confirmation from its similarly named final action. */
  closeLabel?: string;
  /**
   * Окно должно рисоваться поверх другого полноэкранного слоя — сборка
   * отдельного портала не меняет порядок в DOM, только z-index решает.
   *
   * `above-incoming` — поверх окна входящего лида (`.li-wrap.open`, z-index 44),
   * например «Отклонить лид?» из `IncomingLeadWindow`: 45/46, см.
   * theme-2026-lead-incoming.css.
   *
   * `above-chat` — поверх полноэкранного мобильного чата (`MobileChatView`,
   * z-index 45): 47/48, см. theme-2026-mobile-chat.css. Без него окно
   * «Подбор», открытое из композера чата, уезжало ПОД чат, а чат на весь
   * экран перехватывал нажатия — кнопка выглядела мёртвой (владелец
   * 19.09.2026).
   *
   * Оба — ниже обязательных окон (60).
   */
  layer?: "above-incoming" | "above-chat";
  className?: string;
}) {
  const mobile = useMobileUx();
  const swipe = useSwipeToDismiss(open && mobile && dismissible, onClose);
  const trapRef = useFocusTrap<HTMLFormElement>(open);
  const panelRef = useRef<HTMLFormElement | null>(null);

  useScrollLock(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, dismissible]);

  // Фокус переходит в окно, но НЕ на первую кнопку: первой в шапке стоит
  // «Закрыть», а в некоторых окнах первым идёт необратимое действие. Фокус
  // получает сама панель — скринридер объявляет окно, палец и клавиатура ничего
  // не нажимают случайно. Поле с `autoFocus` внутри окна остаётся главнее.
  useEffect(() => {
    if (!open) return;
    const node = panelRef.current;
    if (!node) return;
    if (node.contains(document.activeElement)) return;
    node.focus({ preventScroll: true });
  }, [open]);

  // Условный рендер, а не атрибут hidden: `[hidden]` не скрывает элемент с
  // display:flex — правило `[hidden]` лежит в слое base, а `.flex` ниже.
  if (!open) return null;

  return (
    <Rh2Portal>
      {/* Подложка. Клик по ней закрывает окно — ровно как раньше. */}
      <div
        className={`sheet-back${layer ? ` ${layer}` : ""}`}
        onClick={(closeOnBackdrop ?? dismissible) ? onClose : undefined}
        aria-hidden="true"
      />
      <form
        ref={(node) => {
          panelRef.current = node;
          swipe.ref(node);
          trapRef.current = node;
        }}
        {...swipe.handlers}
        tabIndex={-1}
        role={role}
        aria-modal="true"
        aria-label={ariaLabel ?? (typeof title === "string" ? title : undefined)}
        data-no-sheet=""
        className={`sheet ${mobile ? "bottom" : "right"}${layer ? ` ${layer}` : ""}${className ? ` ${className}` : ""}`}
        style={wide && !mobile ? { width: "min(980px, calc(100vw - 20px))" } : undefined}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit?.(e);
        }}
        // Портал уносит окно в document.body, но события React всплывают по
        // дереву JSX: без остановки клик внутри окна долетал бы до карточки,
        // из которой окно открыли, и открывал бы её (разбор в ConfirmDialog).
        onClick={(e) => e.stopPropagation()}
      >
        {/* Ручка жеста: обещание смахивания даётся только там, где оно работает. */}
        {mobile && dismissible && <div className="grab" aria-hidden="true" />}

        <div className="sheet-h">
          <h2>{title}</h2>
          {dismissible && (
            <button className="pill ghost sm" type="button" aria-label={closeLabel} onClick={onClose}>
              Закрыть
            </button>
          )}
        </div>

        <div className="sheet-b" data-sheet-scroll>
          {children}
        </div>

        {footer ? <div className="sheet-f">{footer}</div> : null}
      </form>
    </Rh2Portal>
  );
}
