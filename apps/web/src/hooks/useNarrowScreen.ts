import { useEffect, useState } from "react";

/**
 * Экран уже, чем брейкпоинт `md` (820px) Tailwind — точка «телефон / не телефон».
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ХУК РЯДОМ С useMobileUx. useMobileUx отвечает на вопрос
 * «управление пальцем?» (жесты, шторки) и НЕ совпадает с CSS-брейкпоинтами:
 * ноутбук 800px шириной для него десктоп. А мобильные ветки «Сообщений» и
 * «Звонков» (хендофф мобильного редизайна 17.08.2026) должны включаться ровно
 * там, где двухпанельная раскладка перестаёт помещаться, — это тот же порог
 * `md:` (820px, с 06.10.2026; раньше `lg:` 1024px), которым делится раскладка
 * в Messages.tsx. Порог 819 = `screens.md - 1`, его сверяет
 * hooks/__tests__/breakpoints.test.ts. Один
 * источник правды: JS-ветка и CSS-классы переключаются на одной ширине,
 * иначе была бы полоса ширин, где рендерится мобильная разметка, а CSS уже
 * считает её десктопной.
 */
export const NARROW_QUERY = "(max-width: 819px)";

export function useNarrowScreen(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(NARROW_QUERY).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}
