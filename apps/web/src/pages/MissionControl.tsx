import { Navigate } from "react-router-dom";

/**
 * Маршрут `/mission-control` (App.tsx) сохранён ради старых прямых ссылок,
 * закладок и писем (layer-3-plan.md §1.2), но всегда ведёт на «/»: пульт
 * директора и администратора живёт там же, один экран на ПК и телефоне
 * (`components/pult/DirectorHome.tsx`, контракт 06.10.2026).
 */
export function MissionControl() {
  return <Navigate to="/" replace />;
}
