import type { ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { ChatSegment, ConversationSegmentCounts } from "../../../hooks/useConversations";

/**
 * ОДИН ФИЛЬТР «Ждут / Мои / Все» нового вида (владелец, макет 17–18.11.2026).
 *
 * Срезы те же, что у прежней полосы, и уходят тем же полем в GET
 * /conversations; поменялись порядок и подписи. Редкое — «Бот на паузе», канал
 * и аккаунт — не удалено, а лежит под «Ещё» (`more`): кнопка помечена точкой,
 * пока там что-то выбрано, чтобы спрятанный фильтр не выглядел как «список
 * пропал».
 */
const MAIN: Array<{ id: ChatSegment; label: string; count: keyof ConversationSegmentCounts }> = [
  { id: "needsHuman", label: "Ждут", count: "needsHuman" },
  { id: "mine", label: "Мои", count: "mine" },
  { id: "all", label: "Все", count: "all" },
];

export function RoyalInboxFilters({ segment, counts, onSegmentChange, moreActive, children }: {
  segment: ChatSegment;
  counts: ConversationSegmentCounts | null | undefined;
  onSegmentChange: (segment: ChatSegment) => void;
  /** В «Ещё» выбран срез или фильтр — кнопка получает метку. */
  moreActive: boolean;
  /** Содержимое «Ещё»: пауза бота, канал и аккаунт. */
  children: ReactNode;
}) {
  return (
    <div className="ry-chats-filters">
      <div className="ry-chats-seg" role="radiogroup" aria-label="Какие разговоры показать">
        {MAIN.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={segment === item.id}
            onClick={() => onSegmentChange(item.id)}
          >
            {item.label}
            {counts && <b className="ry-num">{counts[item.count]}</b>}
          </button>
        ))}
      </div>
      <details className="ry-chats-more" data-active={moreActive || undefined}>
        <summary aria-label={moreActive ? "Ещё фильтры, выбран фильтр" : "Ещё фильтры: бот на паузе, канал, аккаунт"} title="Ещё фильтры">
          <SlidersHorizontal aria-hidden="true" />
        </summary>
        <div className="ry-chats-more-body">{children}</div>
      </details>
    </div>
  );
}
