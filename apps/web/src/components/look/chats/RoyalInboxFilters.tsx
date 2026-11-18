import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { ChatSegment, ConversationSegmentCounts } from "../../../hooks/useConversations";

/**
 * ОДИН ФИЛЬТР «Ждут / Мои / Все» нового вида (владелец, макет 17–18.11.2026).
 *
 * Срезы те же, что у прежней полосы, и уходят тем же полем в GET
 * /conversations; поменялись порядок и подписи. «Все N» — то же общее число,
 * что прежнее «N всего». Редкое — «Бот на паузе», канал и аккаунт — не
 * удалено, а лежит под «Ещё»: кнопка помечена точкой, пока там что-то выбрано,
 * чтобы спрятанный фильтр не выглядел как «список пропал». «Ещё» закрывается
 * нажатием мимо, Escape и после выбора. Срезы — радиогруппа: стрелки
 * переключают, в Tab-порядке одна кнопка.
 */
export const ROYAL_SEGMENTS: Array<{ id: ChatSegment; label: string; count: keyof ConversationSegmentCounts }> = [
  { id: "needsHuman", label: "Ждут", count: "needsHuman" },
  { id: "mine", label: "Мои", count: "mine" },
  { id: "all", label: "Все", count: "all" },
];

/** Срез, на который ведёт стрелка: по кругу; из спрятанного («пауза») — с первого. */
export function segmentByArrow(current: ChatSegment, key: string): ChatSegment | null {
  const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
  if (key === "Home") return ROYAL_SEGMENTS[0].id;
  if (key === "End") return ROYAL_SEGMENTS[ROYAL_SEGMENTS.length - 1].id;
  if (!step) return null;
  const index = ROYAL_SEGMENTS.findIndex((item) => item.id === current);
  const from = index < 0 ? (step > 0 ? -1 : 0) : index;
  return ROYAL_SEGMENTS[(from + step + ROYAL_SEGMENTS.length) % ROYAL_SEGMENTS.length].id;
}

export function RoyalInboxFilters({ segment, counts, onSegmentChange, moreActive, children }: {
  segment: ChatSegment;
  counts: ConversationSegmentCounts | null | undefined;
  onSegmentChange: (segment: ChatSegment) => void;
  /** В «Ещё» выбран срез или фильтр — кнопка получает метку. */
  moreActive: boolean;
  /** Содержимое «Ещё»: пауза бота, канал и аккаунт. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDetailsElement>(null);
  const segRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => { if (!boxRef.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      boxRef.current?.querySelector("summary")?.focus();
    };
    document.addEventListener("click", onDoc);
    window.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", onDoc); window.removeEventListener("keydown", onKey); };
  }, [open]);

  const checkedIndex = ROYAL_SEGMENTS.findIndex((item) => item.id === segment);
  const onArrow = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = segmentByArrow(segment, event.key);
    if (!next) return;
    event.preventDefault();
    onSegmentChange(next);
    segRef.current?.querySelector<HTMLButtonElement>(`[data-segment="${next}"]`)?.focus();
  };

  return (
    <div className="ry-chats-filters">
      <div ref={segRef} className="ry-chats-seg" role="radiogroup" aria-label="Какие разговоры показать" onKeyDown={onArrow}>
        {ROYAL_SEGMENTS.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            data-segment={item.id}
            aria-checked={segment === item.id}
            tabIndex={index === (checkedIndex < 0 ? 0 : checkedIndex) ? 0 : -1}
            onClick={() => onSegmentChange(item.id)}
          >
            {item.label}
            {counts && <b className="ry-num">{counts[item.count]}</b>}
          </button>
        ))}
      </div>
      <details
        ref={boxRef}
        className="ry-chats-more"
        data-active={moreActive || undefined}
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary aria-label={moreActive ? "Ещё фильтры, выбран фильтр" : "Ещё фильтры: бот на паузе, канал, аккаунт"} title="Ещё фильтры">
          <SlidersHorizontal aria-hidden="true" />
        </summary>
        {/* Выбор сделан — меню закрывается: кнопка среза или смена поля. */}
        <div
          className="ry-chats-more-body"
          onClick={(event) => { if ((event.target as HTMLElement).closest("button")) setOpen(false); }}
          onChange={() => setOpen(false)}
        >
          {children}
        </div>
      </details>
    </div>
  );
}
