import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cx } from "./cx";
import type { TileTone } from "./Tile";

/**
 * СТРОКА СПИСКА (контракт 06.10): аватар 44, имя 16, вторая строка 13, справа
 * чип или мета и действия. Высота не меньше 56, наведение `--soft`.
 *
 * СТРОКА ЦЕЛИКОМ НАЖИМАЕМА, ДЕЙСТВИЯ СПРАВА НЕ ВСПЛЫВАЮТ. Реализовано не
 * обработчиком на корне (тогда каждая кнопка в `actions` обязана вызывать
 * `stopPropagation`, и забытая открывает карточку вместо звонка), а приёмом
 * «растянутой ссылки»: имя строки это настоящая ссылка или кнопка, её
 * псевдоэлемент `::after` накрывает всю строку (`.rh-row-link`), а блок
 * `actions` поднят над ним по z-index. Вложенных интерактивных элементов нет,
 * средний клик и «открыть в новой вкладке» у ссылки работают.
 */
/** Заголовок длиннее этого числа знаков: кнопки строки встают под текст (телефон). */
export const ROW_STACK_TITLE = 40;

/** `node` заменяет инициалы своим содержимым (фото клиента); `label` остаётся запасным текстом. */
export type RowAvatar = { label: string; tone?: TileTone; node?: ReactNode };

export function Row({
  avatar,
  title,
  line,
  chip,
  meta,
  actions,
  href,
  onClick,
  linkLabel,
  actionCount,
  done = false,
  className,
  ...rest
}: {
  avatar?: RowAvatar;
  title: string;
  line?: ReactNode;
  /** Обычно `<Chip>`: один чип на строку (словарь в Chip.tsx). */
  chip?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  /** Внутренний маршрут: строка становится ссылкой. */
  href?: string;
  /** Нет маршрута: строка становится кнопкой. `href` главнее. */
  onClick?: () => void;
  /** Метка ссылки/кнопки строки для скринридера, когда одного имени мало («Открыть карточку: …»). */
  linkLabel?: string;
  /** Сколько кнопок в `actions`: больше одной уводит их под текст (телефон), см. `ROW_STACK_TITLE`. */
  actionCount?: number;
  done?: boolean;
  className?: string;
  "data-testid"?: string;
}) {
  const hit = href != null || onClick != null;
  // Правило телефона (< 820, CSS `.rh-row-wrap`): несколько кнопок или длинный
  // заголовок уводят действия под текст на всю ширину, а не вправо.
  const stack = actions != null && ((actionCount ?? 0) > 1 || title.length > ROW_STACK_TITLE);
  const name = href != null ? (
    <Link to={href} className="rh-row-link" aria-label={linkLabel}>
      {title}
    </Link>
  ) : onClick != null ? (
    <button type="button" className="rh-row-link" onClick={onClick} aria-label={linkLabel}>
      {title}
    </button>
  ) : (
    title
  );
  return (
    <div {...rest} className={cx("row", "rh-row", hit && "rh-row-hit", stack && "rh-row-wrap", done && "done", className)}>
      {avatar ? (
        <span className={cx("av", avatar.tone)} aria-hidden>
          {avatar.node ?? avatar.label}
        </span>
      ) : null}
      <div className="t">
        <b>{name}</b>
        {line ? <span>{line}</span> : null}
      </div>
      {chip}
      {meta ? <span className="meta">{meta}</span> : null}
      {actions ? <div className="act">{actions}</div> : null}
    </div>
  );
}

/** Контейнер строк: `.list` темы (разделители, последняя без черты). */
export function List({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
  "data-testid"?: string;
}) {
  return (
    <div {...rest} className={cx("list", className)}>
      {children}
    </div>
  );
}
