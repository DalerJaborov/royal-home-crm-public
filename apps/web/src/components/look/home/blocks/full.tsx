import { Suspense, useState, type ReactNode } from "react";
import { RoyalIcon } from "../../RoyalIcon";
import { RhBlockState, RhButton } from "../../ui";

/**
 * «Весь экран» — прежняя главная роли целиком, по нажатию и отдельным куском сборки
 * (перенесено из pages/TodayRoyal.tsx, home-core 20.11.2026). Так на главной ядра не
 * теряется ни одно действие прежней главной (ИИ, очереди, принятие задач, графики).
 */
export function FullScreenToggle({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="ry-full" aria-label={label}>
      <RhButton variant="gray" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <RoyalIcon name="layout-dashboard" size={22} />{open ? "Свернуть" : label}
      </RhButton>
      {open && <div className="ry-full-body"><Suspense fallback={<RhBlockState kind="loading" />}>{children}</Suspense></div>}
    </section>
  );
}
