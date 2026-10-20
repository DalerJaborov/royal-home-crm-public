/**
 * ПЕРЕХОДНИК. Заглушка загрузки теперь одна: `components/rh2/Skeleton.tsx`
 * (контракт 06.10.2026). Этот файл оставлен единственной строкой, потому что
 * его импортирует `layouts/AppLayout.tsx` (оболочка, пачка B). Когда B
 * переведёт импорт на `components/rh2`, файл удаляется целиком. Прежние
 * `RowSkeleton`/`ClientRowSkeleton`/`KpiSkeleton` не использовал никто.
 */
export { Skeleton } from "./rh2/Skeleton";
