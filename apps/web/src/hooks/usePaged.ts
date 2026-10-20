import { useState } from "react";

/**
 * Показывает первые N элементов и подгружает ещё по N.
 *
 * Родился в pages/Deals.tsx (архивные списки сделок копятся годами и не должны
 * рендерить тысячи строк разом), а с появлением мобильной доски (компонент
 * components/mobile/MobileDeals.tsx) стал нужен в двух файлах сразу — поэтому
 * живёт отдельным хуком, а не копией в каждом.
 */
export function usePaged<T>(items: T[], pageSize = 8) {
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const visible = items.slice(0, visibleCount);
  return {
    visible,
    hasMore: visibleCount < items.length,
    showMore: () => setVisibleCount((v) => v + pageSize),
  };
}
