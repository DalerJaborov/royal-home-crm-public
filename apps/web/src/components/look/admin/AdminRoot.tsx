import type { ReactNode } from "react";
import { RoyalSection } from "../clients/RoyalSection";
import { Rh2Screen, type Rh2ScreenProps } from "../../rh2/Rh2Screen";
import { useShellClaim } from "../../../store/shell";

/**
 * КОРЕНЬ СЛУЖЕБНЫХ ЭКРАНОВ В «НОВОМ ВИДЕ» (пачка admin, 20.11.2026) — одна дверь на
 * семь экранов: «Права по ролям» (/settings/roles), «Состояние функций»
 * (/settings/functions), «Мой профиль» (/profile), «Интеграции и каналы»
 * (/integrations), карточка канала (/integrations/:name), «Уведомления»
 * (/notifications) и «Страница не найдена».
 *
 * Без признака вида разметка прежняя до байта: `<div className="rh2 screens">` или
 * прежний Rh2Screen с прежним классом, без метки раздела и без контекста.
 * С признаком — тот же корень с классом `ry-admin` и меткой `data-ry-section="admin"`;
 * шторки, открытые из экрана (подтверждение личности StepUpDialog → Rh2Sheet →
 * Rh2Portal), получают метку через RoyalSection. Оформление — только в
 * theme-look-royal-admin.css.
 */
export function AdminRoot({ royal, title, children }: { royal: boolean; title?: string; children: ReactNode }) {
  return (
    <RoyalSection name={royal ? "admin" : undefined}>
      <div className={royal ? "rh2 screens ry-admin" : "rh2 screens"} data-ry-section={royal ? "admin" : undefined}>
        {royal && title ? <AdminTitle title={title} /> : null}
        {children}
      </div>
    </RoyalSection>
  );
}

/**
 * Название экрана в шапке оболочки на телефоне — только в новом виде. Прежний вид
 * писал там имя раздела («Настройки CRM»), а заголовок страницы прятал (правило
 * theme-2026-clean-section-surfaces.css): человек не видел, какой экран открыт.
 */
function AdminTitle({ title }: { title: string }) {
  useShellClaim({ title });
  return null;
}

/** Экран на Rh2Screen: метку ставит сам Rh2Screen из контекста, класс `ry-admin` — только с признаком. */
export function AdminScreen({ royal, className, ...rest }: Rh2ScreenProps & { royal: boolean }) {
  const cls = royal ? [className, "ry-admin"].filter(Boolean).join(" ") : className;
  return (
    <RoyalSection name={royal ? "admin" : undefined}>
      <Rh2Screen {...rest} className={cls} />
    </RoyalSection>
  );
}
