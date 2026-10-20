import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * ЧИП СОСТОЯНИЯ (контракт 06.10 + решение по `docs/design/contract-2026-10/review-statuses.md`).
 *
 * СЛОВАРЬ, а не украшение:
 *  - строка клиента: один чип, и он называет ДЕЙСТВИЕ (принять лид, позвонить
 *    сейчас, ответить, первый звонок, показ сегодня 14:00);
 *  - строка объекта: один чип ЭТАПА конвейера (проверка, фото, видео, монтаж,
 *    в продаже, резерв, продано).
 * «Горячий/холодный» чипом не бывает. Класс `chip hot` темы значит «На
 * проверке» (`lib/theme2026.ts`), поэтому набор его НЕ предлагает: тонов
 * девять, а «показ» красится `lav`.
 */
export type ChipTone = "neutral" | "ok" | "warn" | "crit" | "lime" | "aqua" | "lav" | "sky" | "pink";

export function Chip({
  tone = "neutral",
  className,
  children,
  ...rest
}: {
  tone?: ChipTone;
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
  title?: string;
}) {
  return (
    <span {...rest} className={cx("chip", "rh-chip", tone !== "neutral" && tone, className)}>
      {children}
    </span>
  );
}
