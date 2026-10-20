import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cx } from "./cx";

export type TileTone = "lime" | "aqua" | "lav" | "sky" | "pink";

/**
 * ПЛИТКА: число 28 и подпись 13 на пастельной заливке (контракт 06.10). С
 * `href` это ссылка целиком (`a.tile` темы даёт рамку, подъём и фокус), без
 * него просто блок. Ряд из трёх плиток собирает `Tiles`.
 */
export function Tile({
  value,
  label,
  tone,
  href,
  className,
  ...rest
}: {
  value: ReactNode;
  label: string;
  tone?: TileTone;
  href?: string;
  className?: string;
  "data-testid"?: string;
}) {
  const cls = cx("tile", "rh-tile", tone, className);
  const body = (
    <>
      <span className="v">{value}</span>
      <span className="l">{label}</span>
    </>
  );
  return href ? (
    <Link {...rest} to={href} className={cls}>
      {body}
    </Link>
  ) : (
    <div {...rest} className={cls}>
      {body}
    </div>
  );
}

/** Ряд плиток: три в ряд на любой ширине (число 28 на 390 px помещается). */
export function Tiles({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rh-tiles", className)}>{children}</div>;
}
