import type { Role } from "@royal-home/shared";
import { useAuthStore } from "../store/auth";

/**
 * Предзагрузка кусков главной и чатов в простое браузера, а не по клику
 * (perf/web-instant-11-09). Ту же самую главную по роли и так грузит
 * pages/Dashboard.tsx при заходе на "/" — здесь тот же динамический import(),
 * просто запущенный раньше, на idle; повторный вызов Vite дедуплицирует,
 * повторной загрузки с сети не будет. Куски «Сообщений» (App.tsx, маршрут
 * /messages) без этого качаются только по клику в навигации.
 */
function onIdle(cb: () => void): void {
  const ric = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
    .requestIdleCallback;
  if (typeof ric === "function") ric(cb, { timeout: 4_000 });
  else setTimeout(cb, 2_000);
}

const HOME_CHUNK_BY_ROLE: Record<Role, () => Promise<unknown>> = {
  DIRECTOR: () => import("../pages/MissionControl"),
  ADMIN: () => import("../pages/MissionControl"),
  EDITOR: () => import("../components/EditorDashboard"),
  AGENT: () => import("../components/home/AgentHome"),
  MARKETING: () => import("../components/home/MarketingHome"),
  SECURITY: () => import("../components/home/SecurityHome"),
  MANAGER: () => import("../components/home/ManagerHome"),
  // Акционер смотрит пульт директора в режиме чтения; РОП — экран руководителя (10.10.2026, роли).
  SHAREHOLDER: () => import("../pages/MissionControl"),
  HEAD_OF_SALES: () => import("../components/home/ManagerHome"),
};

function prefetchForRole(role: Role | undefined): void {
  onIdle(() => {
    void (HOME_CHUNK_BY_ROLE[role ?? "MANAGER"] ?? HOME_CHUNK_BY_ROLE.MANAGER)();
    void import("../pages/Messages");
  });
}

let started = false;
/** main.tsx вызывает один раз при старте приложения. */
export function startPostLoginPrefetch(): void {
  if (started) return;
  started = true;
  // Вкладка открыта с уже действующей сессией (обычная перезагрузка) — сразу.
  const initial = useAuthStore.getState();
  if (initial.hasSession) prefetchForRole(initial.agent?.role);
  // Свежий вход в этой вкладке — как только появилась сессия.
  useAuthStore.subscribe((state, prev) => {
    if (state.hasSession && !prev.hasSession) prefetchForRole(state.agent?.role);
  });
}
