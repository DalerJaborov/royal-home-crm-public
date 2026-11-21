import type { ReactNode } from "react";
import { useRoyalSectionName } from "../clients/RoyalSection";

/**
 * Корень `.rh2` экрана мастера с меткой раздела «Нового вида» из контекста
 * (пачка wizard). Отдельным компонентом, а не хуком в контроллере мастера:
 * PropertyWizard вызывают в тестах как функцию с подменёнными хуками React, и
 * лишний хук в нём сдвинул бы их порядок. Без признака вида метки нет.
 */
export function WizardRoot({ children }: { children: ReactNode }) {
  const section = useRoyalSectionName();
  return <div className="rh2" data-ry-section={section}>{children}</div>;
}
