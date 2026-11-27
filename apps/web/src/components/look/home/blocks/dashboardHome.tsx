import { lazyWithReload } from "../../../../lib/lazyWithReload";

/**
 * ДАШБОРД НА ГЛАВНОЙ РУКОВОДИТЕЛЯ (21.11.2026) — pages/DirectorDashboard.tsx отдельным куском
 * сборки, со своим запросом и своими фильтрами. С 27.11.2026 (пачка home2) он стоит под блоками
 * макета как «Аналитика» (../../home2/LeaderHome.tsx); прежняя полоса «Требует внимания сейчас»
 * ушла в плитки «Ждут ответа» и «Горит» и строки под ними (../../home2/blocks.tsx, PulseTiles):
 * пропущенные звонки и заявки без принятия видны там же, только когда их больше нуля.
 */
const DirectorDashboardBlockLazy = lazyWithReload(() => import("../../../../pages/DirectorDashboard").then((m) => ({ default: m.DirectorDashboardBlock })));

export function DashboardHomeBlock() {
  return <DirectorDashboardBlockLazy />;
}
