import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * КАРТОЧКА: «одна карточка = одна мысль» (контракт 06.10). Обёртка над `.card`
 * темы; `tight` (r18, поля 16) и `flat` (без тени, контур) — модификаторы
 * самой темы. `title` рисует `.sec-t` первым ребёнком.
 */
export function Card({
  as: Tag = "section",
  tight = false,
  flat = false,
  title,
  className,
  children,
  ...rest
}: {
  as?: "section" | "div" | "article";
  tight?: boolean;
  flat?: boolean;
  title?: ReactNode;
  className?: string;
  children?: ReactNode;
  "aria-label"?: string;
  "data-testid"?: string;
  id?: string;
}) {
  return (
    <Tag {...rest} className={cx("card", "rh-card", tight && "tight", flat && "flat", className)}>
      {title ? <p className="sec-t">{title}</p> : null}
      {children}
    </Tag>
  );
}
