import type { ReactNode } from "react";
import { useRoyalLook } from "../../../hooks/useRoyalLook";
import { RoyalSection, useRoyalSectionName } from "../clients/RoyalSection";
import { ChannelIcon, hasChannelGlyph } from "../../ChannelIcon";

/**
 * РАЗДЕЛ «МАРКЕТИНГ» НОВОГО ВИДА (пачка marketing, 19.11.2026).
 *
 * Экраны пачки — «Реклама», «Обзор»/«Монтаж», «Публикации в соцсети»,
 * «Изменения на сайте», «Цены рынка», «Комментарии» — оборачиваются в
 * `MarketingSection`: при `useRoyalLook()` она даёт контексту метку `marketing`
 * (общий механизм `RoyalSection`), корень экрана ставит её у себя через
 * `useMarketingSectionMark()`, а окна и шторки (Rh2Portal) получают её из
 * контекста сами. Без признака вида метки нет: ни атрибута, ни класса, ни
 * одного пикселя изменений (слой theme-look-royal-marketing.css весь под меткой).
 */
export const MARKETING_SECTION = "marketing";

export function MarketingSection({ children }: { children: ReactNode }) {
  const royal = useRoyalLook();
  return <RoyalSection name={royal ? MARKETING_SECTION : undefined}>{children}</RoyalSection>;
}

/** Значение `data-ry-section` для корня экрана: «marketing» в новом виде, иначе атрибута нет. */
export function useMarketingSectionMark(): string | undefined {
  return useRoyalSectionName() === MARKETING_SECTION ? MARKETING_SECTION : undefined;
}

/**
 * Знак площадки в РОДНЫХ цветах (закон вида: соцсети в своих цветах) — круг цвета
 * бренда с белым знаком, рядом с названием площадки. Рисуется только в новом виде
 * раздела: в прежнем разметка не меняется вовсе. Название площадки стоит рядом
 * текстом, поэтому знак для экранного чтеца скрыт (не дублирует подпись).
 */
export function MarketingBrandMark({ channel, size = 28 }: { channel: string | null | undefined; size?: 28 | 36 }) {
  const mark = useMarketingSectionMark();
  const key = (channel ?? "").toUpperCase();
  if (!mark || !hasChannelGlyph(key)) return null;
  return (
    <span className="ry-mkt-brand" data-channel={key} data-size={size} aria-hidden="true">
      <ChannelIcon channel={key} tone="ink" size={Math.round(size * 0.56)} />
    </span>
  );
}
