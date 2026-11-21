import { useEffect, useRef, useState, type ReactNode } from "react";
import { RhSegmented, rhStepByKey } from "../ui";
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
  // Одно правило клавиш на все переключатели (RhSegmented, ui.tsx).
  return rhStepByKey(ROYAL_SEGMENTS.map((item) => item.id), current, key) ?? null;
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

  return (
    <div className="ry-chats-filters">
      <RhSegmented
        className="ry-chats-seg"
        label="Какие разговоры показать"
        value={segment}
        onChange={onSegmentChange}
        options={ROYAL_SEGMENTS.map((item) => ({
          id: item.id,
          attrs: { "data-segment": item.id },
          label: <>{item.label}{counts && <b className="ry-num">{counts[item.count]}</b>}</>,
        }))}
      />
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
