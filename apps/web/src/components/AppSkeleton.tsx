import { useEffect, useState } from "react";
import { Skeleton } from "./rh2/Skeleton";

/**
 * Экран восстановления сессии — каркас того интерфейса, который сейчас появится.
 *
 * Раньше здесь была строка «Восстановление сессии…» посреди пустого экрана.
 * Восстановление занимает 100–300 мс, поэтому первые 220 мс не показываем
 * ничего: при быстром входе человек не увидит вообще никакой заглушки, без
 * вспышки. Если сессия восстанавливается дольше, появляется каркас — глаз
 * успевает разобрать раскладку, пока едут данные, и загрузка ощущается короче,
 * чем при виде крутилки на пустом фоне.
 *
 * Мерцание — общий класс `.animate-pulse`, как у остальных скелетонов CRM. Он
 * заглушается при системной настройке «уменьшить движение» правилом в index.css:
 * сам Tailwind её не учитывает.
 */
const SHOW_AFTER_MS = 220;

export function AppSkeleton() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      // Экран объявляется скринридеру один раз и вежливо: это состояние загрузки,
      // а не сообщение, которое надо перебивать.
      role="status"
      aria-live="polite"
      aria-label="Загрузка рабочего стола"
      className={`min-h-screen flex transition-opacity duration-200 ${visible ? "opacity-100" : "opacity-0"}`}
    >
      {/* Боковое меню */}
      <div className="hidden md:flex w-[248px] shrink-0 flex-col gap-3 border-r border-line-soft p-4">
        <div className="flex items-center gap-2.5 mb-2">
          <Skeleton className="w-9 h-9 rounded-xl" />
          <div className="flex flex-col gap-1.5 flex-1">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-2 w-32" />
          </div>
        </div>
        <Skeleton className="h-9 w-full rounded-lg" />
        {/* Ширины разной длины: ровные полоски читаются как таблица, а не как
            пункты меню. Классы записаны строками — Tailwind не видит значения,
            собранные в рантайме. */}
        <div className="flex flex-col gap-2 mt-2">
          {["w-[70%]", "w-[55%]", "w-[62%]", "w-[48%]", "w-[58%]", "w-[66%]", "w-[52%]"].map((w, i) => (
            <Skeleton key={i} className={`h-3.5 ${w}`} />
          ))}
        </div>
      </div>

      {/* Рабочая область */}
      <div className="flex-1 flex flex-col gap-4 p-4 md:p-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-40" />
          <div className="flex items-center gap-2">
            <Skeleton className="w-8 h-8 rounded-full" />
            <Skeleton className="w-8 h-8 rounded-full" />
          </div>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[86px] rounded-card" />
          ))}
        </div>
        <Skeleton className="h-[220px] rounded-card" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Skeleton className="h-[150px] rounded-card" />
          <Skeleton className="h-[150px] rounded-card" />
        </div>
      </div>
    </div>
  );
}
