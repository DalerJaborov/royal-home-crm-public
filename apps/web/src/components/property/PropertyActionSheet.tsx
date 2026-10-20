import type { ReactNode } from "react";
import { List, Row } from "../rh2/Row";
import { Rh2Sheet } from "../rh2/Rh2Sheet";

/**
 * Шторка со списком пунктов: «Изменить» и «Ещё» карточки объекта. Одна на оба
 * меню, чтобы пункты выглядели и вели себя одинаково (строка 56, нажимается
 * целиком, нажатие закрывает шторку и делает дело). Без логики: что делает
 * пункт, решает вызывающий.
 */
export interface ActionSheetItem {
  id: string;
  title: string;
  line?: ReactNode;
  onSelect: () => void;
}

export function PropertyActionSheet({
  title,
  items,
  onClose,
  children,
}: {
  title: string;
  items: ActionSheetItem[];
  onClose: () => void;
  /** Нестандартные пункты под списком (например, «Поделиться» с системным меню). */
  children?: ReactNode;
}) {
  return (
    <Rh2Sheet title={title} onClose={onClose}>
      {items.length > 0 && (
        <List>
          {items.map((it) => (
            <Row
              key={it.id}
              title={it.title}
              line={it.line}
              data-testid={`sheet-item-${it.id}`}
              onClick={() => {
                onClose();
                it.onSelect();
              }}
            />
          ))}
        </List>
      )}
      {children}
    </Rh2Sheet>
  );
}
