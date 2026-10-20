import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";

/**
 * Меню «Ещё» карточки клиента — один список на ПК (раскрывается на месте) и на
 * телефоне (шторка). Раньше каждая строка была парой «заголовок + пояснение +
 * своя кнопка справа», а две из них раскрывали форму прямо в узкой правой
 * колонке. Теперь строка целиком — одна нажимаемая цель: иконка, название,
 * при необходимости текущее значение и стрелка. Пояснение оставлено только там,
 * где название само не объясняет последствий. Выбор пункта, которому нужен
 * ввод (тип, звонок роботом), открывает свою шторку, а не растёт внутри строки.
 *
 * Права здесь не проверяются: недоступные пункты просто не попадают в список
 * (их собирает ClientDetail), поэтому рассказывать про них на экране не нужно.
 */
export type MoreItem = {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  /** Одна короткая строка — только для пунктов, чьи последствия не очевидны. */
  hint?: string;
  /** Текущее значение справа от названия («Покупатель»). */
  value?: string;
  /** Вместо стрелки: состояние, при котором нажимать уже нечего («Отправлена 12 сентября»). */
  done?: string;
  tone?: "primary" | "danger";
  disabled?: boolean;
};

export type MoreGroup = {
  key: string;
  /** Подпись группы; у первой группы не нужна. */
  title?: string;
  items: MoreItem[];
};

export function countMoreItems(groups: MoreGroup[]): number {
  return groups.reduce((n, g) => n + g.items.length, 0);
}

export function ClientMoreMenu({
  groups,
  error,
  onPick,
}: {
  groups: MoreGroup[];
  /** Причина отказа прошлого действия — видимым текстом над меню. */
  error?: string | null;
  /** Зовётся перед `onSelect`: шторка закрывается, а не остаётся под следующим окном. */
  onPick?: () => void;
}) {
  const visible = groups.filter((g) => g.items.length > 0);
  return (
    <div className="cd-menu">
      {error && (
        <p className="cd-menu-err" role="alert">
          {error}
        </p>
      )}
      {visible.map((g) => (
        <div className="cd-mg" key={g.key} role="group" aria-label={g.title ?? "Действия"}>
          {g.title && <div className="cd-mg-t">{g.title}</div>}
          {g.items.map((it) => {
            const Icon = it.icon;
            return (
              <button
                key={it.key}
                type="button"
                className={`cd-mi${it.tone ? ` ${it.tone}` : ""}`}
                disabled={it.disabled || !!it.done}
                onClick={() => {
                  onPick?.();
                  it.onSelect();
                }}
              >
                <span className="cd-mi-i" aria-hidden="true">
                  <Icon className="i" />
                </span>
                <span className="cd-mi-t">
                  <b>{it.label}</b>
                  {it.hint && <span>{it.hint}</span>}
                </span>
                {it.done ? (
                  <span className="cd-mi-v">{it.done}</span>
                ) : (
                  <>
                    {it.value && <span className="cd-mi-v">{it.value}</span>}
                    <ChevronRight className="i cd-mi-c" aria-hidden="true" />
                  </>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
