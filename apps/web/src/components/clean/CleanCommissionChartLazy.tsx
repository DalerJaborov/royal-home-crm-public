import { Suspense } from "react";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { Skeleton } from "../rh2/Skeleton";
import type { CommissionChartMonth } from "./CleanCommissionChart";

const Chart = lazyWithReload(() => import("./CleanCommissionChart"));

/** Контейнер высотой задаёт вызывающий (h-[130px]); до загрузки recharts — статичная заглушка того же размера. */
export function CleanCommissionChartLazy({ months }: { months: CommissionChartMonth[] }) {
  return (
    <Suspense fallback={<Skeleton kind="tile" className="h-full w-full" />}>
      <Chart months={months} />
    </Suspense>
  );
}
