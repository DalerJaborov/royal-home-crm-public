import type { ReactNode } from "react";
import { RoyalSection } from "../clients/RoyalSection";

/**
 * КОРЕНЬ ЭКРАНОВ КОНТРОЛЯ В «НОВОМ ВИДЕ» (пачка control, 19.11.2026) — одна дверь
 * на шесть экранов: «Контроль руководителя» (/oversight), «Здоровье системы»
 * (/health), «Что не доехало» (/stuck-work), «Служба безопасности» (/security),
 * «Обучение бота» (/ai-learning), «Резервные копии» (/backups).
 *
 * Без признака вида разметка прежняя до байта: `<div className="rh2 screens">`
 * без метки раздела и без контекста.
 * С признаком — тот же корень с классом `ry-control` и меткой
 * `data-ry-section="control"`; шторки и окна, открытые из экрана (Rh2Sheet через
 * Rh2Portal), получают метку через RoyalSection. Оформление — только в
 * theme-look-royal-control.css.
 */
export function ControlRoot({ royal, children }: { royal: boolean; children: ReactNode }) {
  return (
    <RoyalSection name={royal ? "control" : undefined}>
      <div className={royal ? "rh2 screens ry-control" : "rh2 screens"} data-ry-section={royal ? "control" : undefined}>
        {children}
      </div>
    </RoyalSection>
  );
}
