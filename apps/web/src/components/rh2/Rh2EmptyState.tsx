import type { ComponentType, ReactNode } from "react";
import type { LucideProps } from "lucide-react";

/**
 * Общий кирпич «данных пока нет» — идиома прототипа «Royal Home 2026»
 * (`.empty` из `theme-2026-proto.css:2796`, эталон — `pages/LostClients.tsx`
 * и `pages/SiteChanges.tsx`, разбор — `docs/ui-audit-night-20-09.md` §2.6).
 *
 * Значок + фраза человеческим языком + необязательная подсказка, ЧТО здесь
 * появится и что для этого сделать + необязательное действие. Своих классов
 * не заводит — `.empty`/`.ic`/`.sub` уже есть в теме, здесь только контракт
 * пропсов, чтобы 20 экранов не изобретали разметку по-своему.
 */
export function Rh2EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: ComponentType<LucideProps>;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="ic">
        <Icon className="i" aria-hidden />
      </span>
      <p>{title}</p>
      {hint && <span className="sub">{hint}</span>}
      {action}
    </div>
  );
}
