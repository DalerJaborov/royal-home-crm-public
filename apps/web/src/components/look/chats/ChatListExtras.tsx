import { useEffect, useRef, useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";

/**
 * МЕЛКИЕ ЧАСТИ СПИСКА ЧАТОВ (макет владельца 26.11.2026): серые строки на время подгрузки, вход в «Архив»
 * и шапка самого архива. Своих запросов нет: счётчик и переключение приходят от списка.
 */

/** Серые строки: список подгружается при прокрутке сам, кнопки «Показать ещё» нет. */
export function ChatSkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <div role="status" aria-label="Подгружаем ещё" data-testid="chat-skeleton">
      {Array.from({ length: count }, (_, index) => (
        <div className="ry-chat-skel" key={index} aria-hidden="true">
          <i />
          <span><i /><i /></span>
        </div>
      ))}
    </div>
  );
}

/**
 * Тихая строка «Архив · N» В КОНЦЕ списка «Все» (владелец 27.11.2026: архив нужен редко, наверху ему не место).
 * Ещё один вход — пункт «Архив» в меню фильтров рядом со вкладками.
 */
export function ArchiveEntryRow({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <button type="button" className="ry-chat-archive ry-chat-archive-quiet" onClick={onOpen} data-testid="chat-archive-entry">
      <Archive aria-hidden="true" width={18} height={18} />
      <span>Архив</span>
      <b className="ry-chat-archive-n">{count}</b>
      <ChevronRight aria-hidden="true" width={18} height={18} />
    </button>
  );
}

/** Пункт «Архив (N)» в меню фильтров (кнопка с ползунками рядом со вкладками). */
export function ArchiveMenuItem({ count, active, onOpen }: { count: number; active: boolean; onOpen: () => void }) {
  return (
    <button type="button" className="ry-chats-chip" aria-pressed={active} onClick={onOpen} data-testid="chat-archive-menu">
      <Archive aria-hidden="true" />Архив<b className="ry-num">{count}</b>
    </button>
  );
}

/** Длинная загрузка не должна выглядеть вечной: через 8 секунд серые строки сопровождает пояснение и «Повторить». */
export function SlowLoadHint({ onRetry, afterMs = 8000 }: { onRetry: () => void; afterMs?: number }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), afterMs);
    return () => clearTimeout(timer);
  }, [afterMs]);
  if (!slow) return null;
  return (
    <div className="ry-chat-slow" role="status" data-testid="chat-slow-hint">
      <span>Список грузится дольше обычного.</span>
      <button type="button" onClick={onRetry}>Повторить</button>
    </div>
  );
}

/** Ширина открытой кнопки «В архив» при свайпе влево, px (совпадает с CSS `.ry-chat-swipe-act`). */
export const CHAT_SWIPE_REVEAL = 96;
/** Долгое нажатие на строку на телефоне открывает то же меню, мс. */
export const LONG_PRESS_MS = 550;

/**
 * СТРОКА С ДЕЙСТВИЕМ «В архив / Вернуть» (макет владельца 26.11.2026, вариант B + меню на компьютере):
 *  - телефон: свайп влево открывает синюю кнопку; тап по строке при открытой кнопке только закрывает её;
 *  - компьютер: кнопка «…» у строки и правый щелчок открывают то же действие; с клавиатуры «…» видна по фокусу.
 * Сама строка (`children`) не меняется: действие живёт рядом, а не внутри её кнопки.
 */
export function ArchivableRow({ id, inArchive, onAction, children }: {
  id: string;
  inArchive: boolean;
  onAction: (id: string, action: "archive" | "restore") => void;
  children: ReactNode;
}) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState(false);
  // Мышь есть — действие в меню «…»; нет (телефон) — свайп. Решаем в коде, а не прятанием в CSS.
  const [fine] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches);
  const boxRef = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number; base: number; axis: "x" | "y" | null } | null>(null);
  const swiped = useRef(false);
  // Долгое нажатие — запасной путь на телефоне (iPhone не шлёт contextmenu, а свайп не всем удобен).
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelLongPress = () => { if (longPress.current) { clearTimeout(longPress.current); longPress.current = null; } };
  useEffect(() => cancelLongPress, []);
  const open = offset <= -CHAT_SWIPE_REVEAL / 2;
  const action = inArchive ? "restore" : "archive";
  const label = inArchive ? "Вернуть" : "В архив";
  const Icon = inArchive ? ArchiveRestore : Archive;

  useEffect(() => {
    if (!menu) return;
    const onDoc = (event: MouseEvent) => { if (!boxRef.current?.contains(event.target as Node)) setMenu(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(false); };
    document.addEventListener("click", onDoc);
    window.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", onDoc); window.removeEventListener("keydown", onKey); };
  }, [menu]);

  const run = () => { setMenu(false); setOffset(0); onAction(id, action); };

  return (
    <div
      ref={boxRef}
      className="ry-chat-item"
      data-swipe-open={open || undefined}
      data-dragging={dragging || undefined}
      onContextMenu={(event) => { event.preventDefault(); setMenu(true); }}
      onTouchStart={(event) => {
        const t = event.touches[0];
        if (!t) return;
        touch.current = { x: t.clientX, y: t.clientY, base: offset, axis: null };
        swiped.current = false;
        cancelLongPress();
        longPress.current = setTimeout(() => {
          longPress.current = null;
          // Отпускание пальца после долгого нажатия не должно открыть чат.
          swiped.current = true;
          setMenu(true);
        }, LONG_PRESS_MS);
      }}
      onTouchMove={(event) => {
        const state = touch.current;
        const t = event.touches[0];
        if (!state || !t) return;
        const dx = t.clientX - state.x;
        const dy = t.clientY - state.y;
        if (!state.axis && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) state.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (state.axis) cancelLongPress();
        if (state.axis !== "x") return;
        swiped.current = true;
        setDragging(true);
        setOffset(Math.max(-CHAT_SWIPE_REVEAL, Math.min(0, state.base + dx)));
      }}
      onTouchEnd={() => {
        cancelLongPress();
        touch.current = null;
        setDragging(false);
        setOffset((value) => (value <= -CHAT_SWIPE_REVEAL / 2 ? -CHAT_SWIPE_REVEAL : 0));
      }}
      onClickCapture={(event) => {
        // Сама кнопка действия и пункты меню жмутся всегда: раньше перехват глотал и их, и свайп «В архив» не работал.
        if ((event.target as HTMLElement).closest(".ry-chat-swipe-act, .ry-chat-menu")) { swiped.current = false; return; }
        // После свайпа и при открытой кнопке тап по строке не открывает чат: он только закрывает кнопку.
        if (swiped.current || offset !== 0) {
          event.preventDefault();
          event.stopPropagation();
          swiped.current = false;
          if (offset !== 0) setOffset(0);
        }
      }}
    >
      {!fine && (
        <button type="button" className="ry-chat-swipe-act" tabIndex={open ? 0 : -1} aria-hidden={!open} onClick={run} data-testid="chat-swipe-action">
          <Icon aria-hidden="true" /><span>{label}</span>
        </button>
      )}
      <div className="ry-chat-item-row" style={{ transform: offset ? `translateX(${offset}px)` : undefined }}>
        {children}
      </div>
      {fine && (
        <button
          type="button"
          className="ry-chat-menu-btn"
          aria-label="Действия с чатом"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={(event) => { event.stopPropagation(); setMenu((value) => !value); }}
          data-testid="chat-row-menu"
        >
          <MoreHorizontal aria-hidden="true" />
        </button>
      )}
      {menu && (
        <div className="ry-chat-menu" role="menu">
          <button type="button" role="menuitem" onClick={run} data-testid="chat-menu-action"><Icon aria-hidden="true" />{label}</button>
        </div>
      )}
    </div>
  );
}

/** Шапка внутри архива: как сюда попали, чем он безопасен и как вернуться. */
export function ArchiveHeaderRow({ count, onBack }: { count: number; onBack: () => void }) {
  return (
    <button type="button" className="ry-chat-archive" onClick={onBack} data-testid="chat-archive-back">
      <span className="ry-chat-archive-ic" aria-hidden="true"><ChevronLeft /></span>
      <span className="ry-chat-archive-tx">
        <b>Архив · {count}</b>
        <span>Поиск находит эти переписки, новое сообщение возвращает чат в список. Нажмите, чтобы вернуться ко всем.</span>
      </span>
    </button>
  );
}
