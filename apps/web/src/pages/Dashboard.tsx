import { Suspense } from "react";
import { Link } from "react-router-dom";
import { lazyWithReload } from "../lib/lazyWithReload";
import { useAuthStore } from "../store/auth";
import { useLegacyAgentMobile } from "../hooks/useLegacyAgentMobile";
import { useMobileUx } from "../hooks/useMobileUx";
import { useCleanShell } from "../hooks/useCleanShell";
import { loadCleanPult } from "../lib/cleanRouteChunks";
const PultClean = lazyWithReload(loadCleanPult);

/**
 * КАЖДАЯ ГЛАВНАЯ — СВОИМ КУСКОМ (10.09.2026, разгрузка входного куска).
 *
 * Роль у сотрудника одна, а статические импорты складывали в оболочку все
 * пять главных сразу — вместе с их хуками (useClients, useConversations,
 * useMarketing, useSecurity) это около 110 КБ исходника, из которых нужен
 * один. Пульт директора уже был ленивым по той же причине, теперь тем же
 * способом разведены остальные. Кусок общий с /mission-control и прочими
 * маршрутами, задвоения нет.
 */
const EditorDashboard = lazyWithReload(() =>
  import("../components/EditorDashboard").then((m) => ({ default: m.EditorDashboard }))
);
const MobileAgentHome = lazyWithReload(() => import("../components/home/mh/MobileAgentHome").then((m) => ({ default: m.MobileAgentHome })));
const AgentHome = lazyWithReload(() => import("../components/home/AgentHome").then((m) => ({ default: m.AgentHome })));
const ManagerHome = lazyWithReload(() =>
  import("../components/home/ManagerHome").then((m) => ({ default: m.ManagerHome }))
);
const MarketingHome = lazyWithReload(() =>
  import("../components/home/MarketingHome").then((m) => ({ default: m.MarketingHome }))
);

// «/» для DIRECTOR/ADMIN — один адаптивный пульт на ПК и телефоне (контракт
// 06.10.2026, задание E4). Админ видит то же самое, что директор (решение
// владельца 14.09 и 06.10). Ленивая загрузка: ролям без пульта он не нужен.
const DirectorHome = lazyWithReload(() =>
  import("../components/pult/DirectorHome").then((m) => ({ default: m.DirectorHome }))
);

/**
 * ГЛАВНЫЕ ПО РОЛЯМ НА ТЕЛЕФОНЕ — второй артефакт владельца (11.09.2026).
 *
 * У владельца ДВА разных макета: «Единый пульт директора» для ПК и
 * «мобильная навигация» (c99db05f) для телефона. До сих пор телефон получал
 * разметку ПК, сжатую медиазапросами, — владелец 11.09 это отверг («главные
 * в белой коробке с рамкой поверх фона»). Теперь на узком экране рисуется
 * мобильный макет, на широком — прежний, без изменений.
 *
 * Разными кусками сборки, а не одним компонентом с ветвлением внутри: иначе
 * телефон качал бы и разбирал пульт директора (самый тяжёлый файл в
 * приложении), которого он никогда не покажет, и наоборот.
 */
const MobileManagerHome = lazyWithReload(() =>
  import("../components/home/mh/MobileManagerHome").then((m) => ({ default: m.MobileManagerHome }))
);
// MARKETING/SECURITY/EDITOR — обёртки MhScreen вокруг тех же MarketingHome/
// SecurityHome/EditorDashboard (перенос 14.09.2026, раздел 3 п.1 плана):
// данные и права не менялись, только разметка сравнялась с остальными 4 ролями.
const MobileMarketingHome = lazyWithReload(() =>
  import("../components/home/mh/MobileMarketingHome").then((m) => ({ default: m.MobileMarketingHome }))
);
const MobileEditorHome = lazyWithReload(() =>
  import("../components/home/mh/MobileEditorHome").then((m) => ({ default: m.MobileEditorHome }))
);

/**
 * Главная — развилка по роли и по ширине, и только она.
 *
 * На ПК роль получает свой экран по макету «Единый пульт директора»
 * (`tpl-home-*` в docs/pult/theme-2026/artifact-ff1d9d17-pult-director.html);
 * шапку страницы там рисует HomePageHead (components/home/HomeHead.tsx).
 * На телефоне у всех ролей своя разметка по ВТОРОМУ артефакту владельца
 * (мобильная навигация, c99db05f) — см. components/home/mh/. Маркетинг,
 * Служба безопасности и Монтаж получили свою обёртку `MhScreen` 14.09.2026
 * (перенос макета на прод, раздел 3 п.1): данные и права те же самые, что у
 * десктопных MarketingHome/SecurityHome/EditorDashboard, только разметка.
 *
 * «Классический дашборд» с графиками и набором виджетов удалён 10.09.2026
 * вместе с переносом на макет: в макете его нет, директор и администратор
 * смотрят пульт, у остальных ролей свои главные. Графики по источникам и
 * динамике живут в Отчётах и Источниках.
 *
 * Роль MANAGER в хендоффе владельца называется «Оператор» (звонки, приём
 * лидов, номера клиентов маскируются) — по правам это ROLE_PRESETS.MANAGER.
 */
export function Dashboard() {
  const clean = useCleanShell();
  const legacyAgentMobile = useLegacyAgentMobile();
  const role = useAuthStore((s) => s.agent?.role);
  // Телефон и планшет с пальцем — по устройству, а не по ширине окна
  // (hooks/useMobileUx.ts): у макета владельца это одно и то же «в руке».
  const mobile = useMobileUx();
  // Одна граница ожидания на все ветки: экран у роли ровно один, и держать
  // по <Suspense> в каждом ветвлении незачем.
  return (
    <Suspense fallback={<div role="status" aria-busy="true" className="min-h-48 rounded-2xl bg-row-alt p-6 text-[16px]">Загружаем рабочий экран…</div>}>
      {/* У монтажёра Главная — очередь монтажа, не дашборд продавца. */}
      {role === "EDITOR" ? (
        mobile ? (
          <MobileEditorHome />
        ) : (
          <EditorDashboard />
        )
      ) : role === "DIRECTOR" || role === "ADMIN" ? (
        clean ? <PultClean /> : <DirectorHome />
      ) : role === "AGENT" ? (
        legacyAgentMobile ? <MobileAgentHome /> : <AgentHome />
      ) : role === "MARKETING" ? (
        mobile ? (
          <MobileMarketingHome />
        ) : (
          <MarketingHome />
        )
      ) : role === "SECURITY" ? (
        <section className="card"><h1>Рабочие разделы</h1><div className="wrap">
          <Link className="pill" to="/clients">Клиенты</Link>
          <Link className="pill" to="/properties">Объекты</Link>
        </div></section>
      ) : mobile ? (
        <MobileManagerHome />
      ) : (
        <ManagerHome />
      )}
    </Suspense>
  );
}
