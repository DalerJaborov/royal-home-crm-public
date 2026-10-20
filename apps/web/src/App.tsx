import { Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useScreenSeen } from "./lib/screenSeen";
import { useScreenAttribute } from "./hooks/useScreenAttribute";
import { WorkIndicator } from "./components/WorkIndicator";
import { AppLayout } from "./layouts/AppLayout";
import { Toasts } from "./components/Toasts";
import { GlobalStepUpHost } from "./components/GlobalStepUpHost";
import { NotFound } from "./components/NotFound";
import { AppSkeleton } from "./components/AppSkeleton";
import { Dashboard } from "./pages/Dashboard";
import { loadCleanClients, loadCleanDeals, loadCleanFinance, loadCleanMessages, loadCleanProperties } from "./lib/cleanRouteChunks";
import { useAuthStore } from "./store/auth";
import { didRefreshFailOffline, refreshAccessToken } from "./lib/api";
import { lazyWithReload } from "./lib/lazyWithReload";

// Стенд задачи 2 (слой 2, тема 2026) — только `import.meta.env.DEV`: ленивый
// импорт под условием держит `pages/dev/*` вне прод-чанков (Vite не включает
// динамический импорт, до которого код не может дойти в проде, в граф `dist/`
// того чанка, что грузится всегда, — маршрут ниже тоже регистрируется только
// в DEV, так что ссылка на чанк вообще не попадает в собранный роутер).
const PultTilesPlayground = import.meta.env.DEV
  ? lazyWithReload(() => import("./pages/dev/PultTilesPlayground").then((m) => ({ default: m.PultTilesPlayground })))
  : null;

// Дев-стенд задачи 6 слоя 2 (строки-действия «Решить одной кнопкой») — только
// `import.meta.env.DEV`. В отличие от PultTilesPlayground (фикстура без сети),
// этот маршрут регистрируется ВНУТРИ ProtectedRoute (см. ниже): строкам нужен
// настоящий /dashboard/mission-control и реальные роуты deals/properties/
// errors/clients, а не выдуманные данные.
const PultActionsPlayground = import.meta.env.DEV
  ? lazyWithReload(() =>
      import("./pages/dev/PultActionsPlayground").then((m) => ({ default: m.PultActionsPlayground }))
    )
  : null;

/**
 * ВХОД И ПУБЛИЧНАЯ ССЫЛКА — ЛЕНИВО (10.09.2026, разгрузка входного куска).
 *
 * Эти два экрана взаимоисключающи с оболочкой: страница входа нужна ровно
 * до входа и никогда после, публичная карточка объекта — наоборот, только
 * гостю по ссылке. Статическими импортами они лежали в одном куске с
 * оболочкой, и каждый сотрудник качал их при каждой первой загрузке
 * (Login тянет за собой ещё FormField).
 */
const Login = lazyWithReload(() => import("./pages/Login").then((m) => ({ default: m.Login })));
const Pult = lazyWithReload(() => import("./pages/Pult").then((m) => ({ default: m.Pult })));
const PublicPropertyShare = lazyWithReload(() =>
  import("./pages/PublicPropertyShare").then((m) => ({ default: m.PublicPropertyShare }))
);
const PublicOwnerReport = lazyWithReload(() =>
  import("./pages/PublicOwnerReport").then((m) => ({ default: m.PublicOwnerReport }))
);

/**
 * Окно обновления — тоже лениво: на первом кадре оно ничего не рисует
 * (ждёт события от service worker), а тянет за собой virtual:pwa-register
 * и всю ветку lib/appUpdate* (~48 КБ исходника).
 */
const UpdatePrompt = lazyWithReload(() =>
  import("./components/UpdatePrompt").then((m) => ({ default: m.UpdatePrompt }))
);

// Дев-стенд задачи 7 слоя 2 (EventFeed) — только `import.meta.env.DEV`, не
// собирается и не роутится в проде; лениво, чтобы `pages/dev/*` не попадал в
// граф обычного бандла даже случайно.
const EventFeedPlayground = import.meta.env.DEV
  ? lazyWithReload(() => import("./pages/dev/EventFeedPlayground"))
  : null;

// Дев-стенд задачи 5 слоя 2 (AskPanel) — только `import.meta.env.DEV`, тот же
// приём: не собирается и не роутится в проде.
const AskPanelPlayground = import.meta.env.DEV
  ? lazyWithReload(() => import("./pages/dev/AskPanelPlayground"))
  : null;

// Дев-стенд переноса «Звонков»/«Телефонии»/окна звонка на эталон темы 2026
// (09.09.2026): подменяет только fetch на /api/v1, экраны рендерятся своим
// настоящим кодом. Тот же приём, что выше: в прод-бандл не попадает.
const CallsPortPlayground = import.meta.env.DEV
  ? lazyWithReload(() => import("./pages/dev/CallsPortPlayground"))
  : null;

// Дев-стенд переноса ОКОН на эталон темы 2026 (09.09.2026) — обе волны сразу:
// окна клиентов, сделок и объектов и окна команды, системы и навигации. Каждое
// окно открывается отдельным адресом `?w=<ключ>`, api подменён фикстурами.
// Окна уходят порталом в body — забытая обёртка `.rh2` не ломает ни сборку, ни
// консоль, и видна только глазами на открытом окне, ради чего стенд и заведён.
// Тот же приём, что выше: в прод-бандл не попадает.
const SheetsPortPlayground = import.meta.env.DEV
  ? lazyWithReload(() => import("./pages/dev/SheetsPortPlayground"))
  : null;

// Второй стенд той же задачи — окна, меню и панели команды, системы и навигации
// (`?w=<ключ>`). Стендов два, потому что фикстуры двух волн независимы и имена
// констант в них совпадают; корпус окна при этом ОДИН (Rh2Sheet + Rh2Portal).
const SystemSheetsPortPlayground = import.meta.env.DEV
  ? lazyWithReload(() => import("./pages/dev/SystemSheetsPortPlayground"))
  : null;

// Витрина набора «Royal Home 2026» (06.10.2026) — живая версия дизайн-контракта
// `docs/design/contract-2026-10/`: настоящие классы темы и компоненты rh2 на
// тестовых данных, без сети. Только `import.meta.env.DEV`, как остальные /dev/*.
const DesignLabPlayground = import.meta.env.DEV
  ? lazyWithReload(() => import("./pages/dev/DesignLabPlayground").then((m) => ({ default: m.DesignLabPlayground })))
  : null;

/**
 * РАЗДЕЛЫ ГРУЗЯТСЯ ПО МЕРЕ ОТКРЫТИЯ (13.08.2026).
 *
 * До этого весь интерфейс собирался в один файл на 1,5 МБ: агент, открывающий
 * «Клиентов», качал заодно телефонию, отчёты, кабинет маркетинга и центр
 * безопасности — всё, куда он за день не заглянет. На телефоне это первый экран
 * через несколько секунд вместо доли секунды.
 *
 * Второе, что важнее первого: выкаты у нас частые, а один файл означает, что
 * ЛЮБАЯ правка делает недействительным весь кэш. Каждый сотрудник после каждого
 * выката качал всё заново. Отдельными файлами перекачивается только изменившееся.
 *
 * Эагерно (без разрезания) оставлены ровно три вещи, которые нужны всегда и сразу:
 * вход, каркас приложения и «Главная» — экран, на который человек попадает после
 * входа. Ставить перед ней ещё одно ожидание было бы разменом худшим, чем выигрыш.
 *
 * Заглушка на время загрузки — Suspense в AppLayout вокруг Outlet.
 *
 * Обёртка `.then` нужна из-за именованных экспортов: lazy() ждёт `default`, а
 * страницы у нас экспортируются по имени, и переводить их на default-экспорт ради
 * этого — правка в три десятка файлов без единой выгоды.
 *
 * ЗАГРУЖАЕМ ТОЛЬКО ЧЕРЕЗ `lazyWithReload`, НЕ через голый `lazy` (14.08.2026).
 * Куски сборки именуются с хешем и после выката исчезают с сервера. Вкладка,
 * открытая до выката, идёт за старым хешем и получает 404 — раздел не
 * открывается вовсе. Ровно это и случилось в ночь на 14.08: в журнале
 * «Failed to fetch dynamically imported module: /assets/Oversight-CNpJF5aX.js».
 * `lazyWithReload` обновляет service worker и один раз перезагружает страницу
 * под новую сборку (подробности и защита от петли — в самом модуле).
 */
const Messages = lazyWithReload(loadCleanMessages);
const Comments = lazyWithReload(() => import("./pages/Comments").then((m) => ({ default: m.Comments })));
const Funnel = lazyWithReload(() => import("./pages/Funnel").then((m) => ({ default: m.Funnel })));
const Properties = lazyWithReload(loadCleanProperties);
const PropertiesMap = lazyWithReload(() => import("./pages/PropertiesMap").then((m) => ({ default: m.PropertiesMap })));
const PropertyDetail = lazyWithReload(() => import("./pages/PropertyDetail").then((m) => ({ default: m.PropertyDetail })));
const Clients = lazyWithReload(loadCleanClients);
const LostClients = lazyWithReload(() => import("./pages/LostClients").then((m) => ({ default: m.LostClients })));
const DeferredClients = lazyWithReload(() =>
  import("./pages/DeferredClients").then((m) => ({ default: m.DeferredClients }))
);
const LeadFunnel = lazyWithReload(() => import("./pages/LeadFunnel").then((m) => ({ default: m.LeadFunnel })));
const ClientDetail = lazyWithReload(() => import("./pages/ClientDetail").then((m) => ({ default: m.ClientDetail })));
const Activity = lazyWithReload(() => import("./pages/Activity").then((m) => ({ default: m.Activity })));
const Deals = lazyWithReload(loadCleanDeals);
const Calendar = lazyWithReload(() => import("./pages/Calendar").then((m) => ({ default: m.Calendar })));
const Reports = lazyWithReload(() => import("./pages/Reports").then((m) => ({ default: m.Reports })));
const Sources = lazyWithReload(() => import("./pages/Sources").then((m) => ({ default: m.Sources })));
const Settings = lazyWithReload(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
const RolesMatrix = lazyWithReload(() =>
  import("./pages/settings/RolesMatrix").then((m) => ({ default: m.RolesMatrix })),
);
const Profile = lazyWithReload(() => import("./pages/Profile").then((m) => ({ default: m.Profile })));
const Finance = lazyWithReload(loadCleanFinance);
const Archive = lazyWithReload(() => import("./pages/Archive").then((m) => ({ default: m.Archive })));
const Vacancies = lazyWithReload(() => import("./pages/Vacancies").then((m) => ({ default: m.Vacancies })));
const SiteChanges = lazyWithReload(() => import("./pages/SiteChanges").then((m) => ({ default: m.SiteChanges })));
const Team = lazyWithReload(() => import("./pages/Team").then((m) => ({ default: m.Team })));
// Карточка сотрудника — единственный экран `/team/:id`, ПК и телефон в одном
// файле (20.09.2026: шторка AgentOverviewModal удалена — она и мобильный
// экран разъехались содержимым, см. docs/archive/employee-card-brief-20-09.md).
const TeamMemberDetail = lazyWithReload(() =>
  import("./pages/TeamMemberDetail").then((m) => ({ default: m.TeamMemberDetail }))
);
const SecurityCenter = lazyWithReload(() => import("./pages/SecurityCenter").then((m) => ({ default: m.SecurityCenter })));
const Calls = lazyWithReload(() => import("./pages/Calls").then((m) => ({ default: m.Calls })));
const Telephony = lazyWithReload(() => import("./pages/Telephony").then((m) => ({ default: m.Telephony })));
const MarketingCenter = lazyWithReload(() => import("./pages/MarketingCenter").then((m) => ({ default: m.MarketingCenter })));
const SocialVideos = lazyWithReload(() => import("./pages/SocialVideos").then((m) => ({ default: m.SocialVideos })));
const Pipeline = lazyWithReload(() => import("./pages/Pipeline").then((m) => ({ default: m.Pipeline })));
const Ads = lazyWithReload(() => import("./pages/Ads").then((m) => ({ default: m.Ads })));
const Oversight = lazyWithReload(() => import("./pages/Oversight").then((m) => ({ default: m.Oversight })));
// «Пульс компании» (план 31.08.2026) — агрегирующий экран ADMIN/DIRECTOR: всё,
// что происходит в компании прямо сейчас, одним ответом сервера, без кликов.
const MissionControl = lazyWithReload(() =>
  import("./pages/MissionControl").then((m) => ({ default: m.MissionControl }))
);
const PropertyNew = lazyWithReload(() => import("./pages/PropertyForm").then((m) => ({ default: m.PropertyNew })));
// «Здоровье системы» — вынесено из Настроек отдельным пунктом меню (18.08.2026).
const Health = lazyWithReload(() => import("./pages/Health").then((m) => ({ default: m.Health })));
// «Интеграции и каналы» / «Резервные копии» — перенос мобильного макета
// 14.09.2026, шаг 5: раньше не было ни маршрута, ни данных вообще.
const ChannelDetail = lazyWithReload(() =>
  import("./pages/ChannelDetail").then((m) => ({ default: m.ChannelDetail }))
);
const Integrations = lazyWithReload(() =>
  import("./pages/Integrations").then((m) => ({ default: m.Integrations }))
);
const Backups = lazyWithReload(() => import("./pages/Backups").then((m) => ({ default: m.Backups })));
const StuckWork = lazyWithReload(() => import("./pages/StuckWork").then((m) => ({ default: m.StuckWork })));
// «Обучение бота» — отдельно от «Здоровья системы» (19.08.2026, просьба владельца:
// ошибки/сбои и то, чему бот учится сам, — разные вопросы, разные экраны).
const AiLearning = lazyWithReload(() => import("./pages/AiLearning").then((m) => ({ default: m.AiLearning })));
// «Инсайты от ИИ» — разбор звонков с подсветкой ошибок и рекомендациями.
const Insights = lazyWithReload(() => import("./pages/Insights").then((m) => ({ default: m.Insights })));
// «Ещё» — пятая вкладка нижней навигации телефона (прототип design_handoff,
// view 'more'): все разделы роли, не поместившиеся в нижнюю панель.
const More = lazyWithReload(() => import("./pages/More").then((m) => ({ default: m.More })));
// Полноэкранные «Уведомления» на телефоне (18.08.2026) — открывается кликом
// по колокольчику в MobileHomeHeader, см. pages/Notifications.tsx.
const Notifications = lazyWithReload(() => import("./pages/Notifications").then((m) => ({ default: m.Notifications })));
const PropertyEdit = lazyWithReload(() => import("./pages/PropertyForm").then((m) => ({ default: m.PropertyEdit })));

/** Access-токен живёт только в памяти, поэтому после перезагрузки страницы его нет.
 * Если сессия была (hasSession в localStorage), тихо восстанавливаем её по refresh-cookie,
 * и только при неудаче отправляем на /login. */
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const hasSession = useAuthStore((s) => s.hasSession);
  const accessToken = useAuthStore((s) => s.accessToken);
  const [restoring, setRestoring] = useState(hasSession && !accessToken);

  useEffect(() => {
    if (hasSession && !accessToken) {
      refreshAccessToken().finally(() => setRestoring(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!hasSession) return <Navigate to="/login" replace />;
  // Вместо строки «Восстановление сессии…» на пустом экране — каркас интерфейса,
  // который сейчас появится (см. AppSkeleton: первые миллисекунды он молчит,
  // чтобы быстрый вход прошёл вообще без заглушки).
  if (restoring) return <AppSkeleton />;
  // Нет токена и НЕТ СВЯЗИ — это не «выкинуло из системы», а «не смогли обновить
  // токен». Показываем приложение: внутри висит OfflineBanner, который честно
  // объясняет происходящее, а разделы отдают то, что успел закэшировать service
  // worker. Раньше отсюда уводило на /login, и агент с плохим интернетом видел
  // форму входа — пытался залогиниться, не мог, и решал, что CRM сломалась.
  // Сам баннер живёт в AppLayout, то есть на экране входа показаться не может.
  if (!accessToken) {
    if (!navigator.onLine || didRefreshFailOffline()) return <>{children}</>;
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  // Карта обследованного: отмечает, что экран открывали (см. lib/screenSeen.ts).
  // Стоит здесь, а не в AppLayout: часть экранов рендерится мимо него.
  useScreenSeen();
  // Режим «показан экран» артефакта (см. hooks/useScreenAttribute.ts) — тоже
  // здесь: без него стили экранов темы прячут содержимое, включая экран входа.
  useScreenAttribute();

  return (
    <>
    <Routes>
      <Route
        path="/login"
        element={
          <Suspense fallback={<AppSkeleton />}>
            <Login />
          </Suspense>
        }
      />
      {/* Дев-стенд задачи 7 слоя 2 — вне ProtectedRoute/AppLayout: своя фикстура,
          api не нужен. Маршрут существует только в DEV (см. EventFeedPlayground выше). */}
      {EventFeedPlayground && (
        <Route
          path="/dev/event-feed"
          element={
            <Suspense fallback={<AppSkeleton />}>
              <EventFeedPlayground />
            </Suspense>
          }
        />
      )}
      {/* Приватная ссылка на объект (docs/plan-18-08-private-listings-and-video.md §4) —
          публичная, без ProtectedRoute: клиент открывает её без входа в CRM, и без
          AppLayout — ни сайдбара, ни навигации на остальные разделы. */}
      <Route
        path="/l/:token"
        element={
          <Suspense fallback={<AppSkeleton />}>
            <PublicPropertyShare />
          </Suspense>
        }
      />
      {/* «Отчёт владельцу объекта» (03.10.2026) — публичная страница по секретной ссылке:
          владелец квартиры не пользователь CRM, поэтому без ProtectedRoute и без AppLayout. */}
      <Route
        path="/o/:token"
        element={
          <Suspense fallback={<AppSkeleton />}>
            <PublicOwnerReport />
          </Suspense>
        }
      />
      {/* МАСТЕР ДОБАВЛЕНИЯ ОБЪЕКТА — НА ВЕСЬ ЭКРАН, БЕЗ ХРОМА CRM (владелец
          12.09.2026: «должно было быть без шапки CRM и полностью перекрывать
          весь экран»). Раньше `properties/new` был обычным дочерним маршрутом
          AppLayout (см. блок ниже) — сайдбар/Topbar/BottomNav рисуются им
          безусловно, и собственная шапка мастера (WizardShell) ничего не
          меняла, оставаясь ПОД оболочкой CRM. Здесь — свой top-level маршрут,
          по-прежнему под ProtectedRoute (вход обязателен), но без AppLayout:
          в дереве нет ни сайдбара, ни Topbar, ни BottomNav вовсе. */}
      <Route
        path="/properties/new"
        element={
          <ProtectedRoute>
            <Suspense fallback={<AppSkeleton />}>
              <PropertyNew />
            </Suspense>
          </ProtectedRoute>
        }
      />
      {/* Дев-стенд задачи 5 слоя 2 — реальный вызов /mission-control/ask (нужен вход
          в этой вкладке); вне ProtectedRoute/AppLayout, как и остальные /dev/*. */}
      {AskPanelPlayground && (
        <Route
          path="/dev/ask-panel"
          element={
            <Suspense fallback={<AppSkeleton />}>
              <AskPanelPlayground />
            </Suspense>
          }
        />
      )}
      {CallsPortPlayground && (
        <Route
          path="/dev/calls-port"
          element={
            <Suspense fallback={<AppSkeleton />}>
              <CallsPortPlayground />
            </Suspense>
          }
        />
      )}
      {SheetsPortPlayground && (
        <Route
          path="/dev/sheets-port"
          element={
            <Suspense fallback={<AppSkeleton />}>
              <SheetsPortPlayground />
            </Suspense>
          }
        />
      )}
      {SystemSheetsPortPlayground && (
        <Route
          path="/dev/system-sheets-port"
          element={
            <Suspense fallback={<AppSkeleton />}>
              <SystemSheetsPortPlayground />
            </Suspense>
          }
        />
      )}
      {import.meta.env.DEV && DesignLabPlayground && (
        <Route
          path="/dev/design-lab"
          element={
            <Suspense fallback={null}>
              <DesignLabPlayground />
            </Suspense>
          }
        />
      )}
      {import.meta.env.DEV && PultTilesPlayground && (
        <Route
          path="/dev/pult-tiles"
          element={
            <Suspense fallback={null}>
              <PultTilesPlayground />
            </Suspense>
          }
        />
      )}
      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        {/* The existing address shares home's role, mobile and rollout selection. */}
        <Route path="pult" element={<Pult />} />
        <Route path="activity" element={<Activity />} />
        <Route path="properties" element={<Properties />} />
        <Route path="properties/map" element={<PropertiesMap />} />
        <Route path="properties/:id/edit" element={<PropertyEdit />} />
        <Route path="properties/:id" element={<PropertyDetail />} />
        {/* `key` у четырёх маршрутов списка клиентов (02.10.2026): компонент один,
            и без ключа React переиспользовал его при переходе между разделами —
            страница ленты, статус и источник уезжали из «Покупателей» в
            «Продавцов». С ключом каждый раздел открывается заново, из своего адреса. */}
        <Route path="clients" element={<Clients key="clients" />} />
        <Route path="sellers" element={<Clients key="sellers" kind="SELLER" />} />
        {/*
          «Горячие клиенты» отдельным разделом больше нет (владелец 09.09.2026,
          docs/theme-2026-missing.md §6): горячесть определяет ИИ и она видна
          плашкой прямо в строке списка, а отдельная вкладка под неё только
          путала. Маршрут оставлен ПЕРЕХОДОМ на «Покупателей»: адрес разослан
          пушами и лежит в закладках, и удали его совсем — старая ссылка отдала
          бы «страницу не найдено» вместо списка.
        */}
        <Route path="hot-clients" element={<Navigate to="/clients" replace />} />
        {/* «Потерянные клиенты» — предел передач исчерпан (решение владельца 11.08.2026). */}
        <Route path="lost-clients" element={<LostClients />} />
        {/* «Неактивные» (владелец 17.09.2026) — оба вида сразу, тот же список
            «Клиенты» с фильтром workStatus=INACTIVE (см. Clients.tsx,
            trafficLightDrilldown), а не отдельный компонент: второго источника
            правды по светофору заводить незачем. Настоящий маршрут, а не
            редирект на /clients?workStatus=INACTIVE: тот путь сливался с
            «Покупателями» (тот же /clients), и подсветка активной вкладки
            (ScreenTabs сравнивает pathname) указывала на неверную вкладку.
            kind не важен — Clients.tsx сам решает по pathname, см. ниже. */}
        <Route path="inactive-clients" element={<Clients key="inactive-clients" kind="BUYER" />} />
        {/* «Все мои клиенты» (18.09.2026, задание В §f п.1, Р-2/Р-7
            docs/audit/lead-ownership-17-09.md) — тот же список без Корзины/
            kind-среза, у своего агента показывает буквально всё, где он
            держатель сейчас или был последним (см. Clients.tsx, isAllMineRoute
            и scope=allMine на сервере, routes/clients/list.ts). */}
        <Route path="clients/all-mine" element={<Clients key="all-mine" kind="BUYER" />} />
        {/* «Отложенные» — задача G, план 03-04.09.2026: EXPENSIVE/FINANCE_ISSUE/
            WRONG_OBJECT, обычный исход рынка, не отказ. */}
        <Route path="deferred-clients" element={<DeferredClients />} />
        {/* «Воронка лидов» — лиды по стадиям ClientStatus (макет c99db05f,
            renderFunnel). НЕ путать с /funnel (лид-магниты маркетинга). */}
        <Route path="lead-funnel" element={<LeadFunnel />} />
        <Route path="other-inquiries" element={<Clients kind="OTHER" />} />
        <Route path="clients/:id" element={<ClientDetail />} />
        <Route path="deals" element={<Deals />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="messages" element={<Messages />} />
        {/* Лента комментариев Instagram: что бот ответил публично и что скрыл. */}
        <Route path="comments" element={<Comments />} />
        <Route path="funnel" element={<Funnel />} />
        <Route path="reports" element={<Reports />} />
        <Route path="sources" element={<Sources />} />
        <Route path="settings" element={<Settings />} />
        {/* «Права по ролям» — таблица роль на роль по пресетам shared/permissions.ts,
            вход из Настройки → Сотрудники. Право settings.view, как у самой страницы. */}
        <Route path="settings/roles" element={<RolesMatrix />} />
        <Route path="profile" element={<Profile />} />
        <Route path="finance" element={<Finance />} />
        <Route path="ads" element={<Ads />} />
        {/* Студия запуска рекламы убрана 12.10.2026: старые закладки ведут на доску. */}
        <Route path="ads/launch/*" element={<Navigate to="/ads" replace />} />
        <Route path="archive" element={<Archive />} />
        <Route path="vacancies" element={<Vacancies />} />
        <Route path="site-changes" element={<SiteChanges />} />
        <Route path="team" element={<Team />} />
        <Route path="team/:id" element={<TeamMemberDetail />} />
        <Route path="hall-of-fame" element={<Team />} />
        {/* Кабинет службы безопасности — доступ по праву clients.securityReview
            (см. SecurityCenter.tsx), а не по роли: страница сама показывает
            заглушку тому, у кого права нет. */}
        <Route path="security" element={<SecurityCenter />} />
        {/* Разговоры: свои — по праву calls.ownTranscripts, чужие и всё
            общекомандное — по calls.transcripts. Страница сама объясняет отказ
            тому, у кого нет ни того, ни другого, как SecurityCenter. */}
        <Route path="calls" element={<Calls />} />
        {/* Дашборд телефонии: состояние станции, аппараты сотрудников, живые
            звонки и счётчики за день. То же право, что и у «Звонков», — и та же
            заглушка внутри страницы для тех, у кого его нет. */}
        <Route path="telephony" element={<Telephony />} />
        {/* Кабинет маркетинга — доступ по роли (MARKETING/DIRECTOR), проверяется
            и здесь (Sidebar.tsx не даёт ссылки остальным), и на бэкенде
            (routes/marketing.ts) — как единственный источник истины для доступа. */}
        <Route path="marketing" element={<MarketingCenter />} />
        {/* «Ролики в соцсети» (12.10.2026): страница сама показывает заглушку не
            маркетингу/директору/администратору, сервер отвечает 403 остальным. */}
        <Route path="social-videos" element={<SocialVideos />} />
        <Route path="pipeline" element={<Pipeline />} />
        {/* «Контроль руководителя» (ТЗ п. 32) — сводный дашборд по просрочкам,
            лимитам лидов, зависшим горячим клиентам и переводам/передачам.
            Право dashboard.analytics — страница сама показывает заглушку тому,
            у кого его нет, как SecurityCenter/Calls. */}
        <Route path="oversight" element={<Oversight />} />
        {/* «Пульс компании» — тот же гейт dashboard.analytics, страница сама
            показывает заглушку тому, у кого права нет (как Oversight/Calls). */}
        <Route path="mission-control" element={<MissionControl />} />
        {import.meta.env.DEV && PultActionsPlayground && (
          <Route
            path="dev/pult-actions"
            element={
              <Suspense fallback={<AppSkeleton />}>
                <PultActionsPlayground />
              </Suspense>
            }
          />
        )}
        {/* Право auditLog.view — страница сама показывает заглушку тому, у кого
            его нет, как SecurityCenter/Calls/Oversight. */}
        <Route path="health" element={<Health />} />
        <Route path="integrations" element={<Integrations />} />
        <Route path="integrations/:name" element={<ChannelDetail />} />
        <Route path="backups" element={<Backups />} />
        <Route path="stuck-work" element={<StuckWork />} />
        {/* Право settings.view — та же заглушка, что и у самой страницы. */}
        <Route path="ai-learning" element={<AiLearning />} />
        {/* «Инсайты от ИИ» — разбор звонков с подсветкой ошибок и рекомендациями. */}
        <Route path="insights" element={<Insights />} />
        {/* Слияние экранов 15.09.2026: «Тренировка» стала вкладкой «Манера» на
            /ai-learning — редирект оставлен ради старых ссылок и закладок. */}
        <Route path="bot-training" element={<Navigate to="/ai-learning?tab=manner" replace />} />
        {/* «Ещё» — меню разделов для телефона (вкладка нижней навигации);
            собирается из реестра lib/navigation.ts, прав своих не имеет. */}
        <Route path="more" element={<More />} />
        <Route path="notifications" element={<Notifications />} />
        {/* Неизвестный адрес внутри приложения — понятная заглушка вместо пустого
            Outlet (сайдбар есть, контента нет), см. components/NotFound.tsx. */}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
    {/* Единый указатель долгой работы (07.10.2026): загрузки мастера «Новый объект»
        — на любом экране, очередь карточки — на `/properties/new`, куда
        AppLayout с его UploadIndicator не доходит. Сиблинг `<Routes>`, не внутри
        AppLayout, по той же причине, что UpdatePrompt ниже. */}
    <WorkIndicator />
    {/* «Вышла новая версия» — молчаливая подмена. Сиблинг `<Routes>` —
        см. UpdatePrompt.tsx/store/appUpdate.ts: раньше монтировался внутри
        AppLayout (за ProtectedRoute), терял состояние при пересборке дерева и
        не работал вовсе на /login. App() живёт всю жизнь вкладки — сюда
        UpdatePrompt смонтируется РОВНО ОДИН РАЗ, и обновление ловится в том
        числе на экране входа. Ничего не рисует: подмена сборки молчит. */}
    {/* Своя граница ожидания, а не общая: пока едет её кусок, `<Routes>` рядом
        обязаны остаться на экране — иначе первый кадр ждал бы окна обновления,
        ради разгрузки которого его и вынесли. */}
    <Suspense fallback={null}>
      <UpdatePrompt />
    </Suspense>
    {/* Окно «Подтвердите, что это вы» на любом экране, не только в Настройках. */}
    <GlobalStepUpHost />
    {/* Подтверждения «Сохранено»/«Приложение обновлено». Сиблинг `<Routes>`, как
        UpdatePrompt рядом: до 10.09.2026 стопка жила внутри AppLayout, то есть
        под ProtectedRoute — на /login и во время восстановления сессии показать
        уведомление было некому, хотя стор их исправно копил. */}
    <Toasts />
    </>
  );
}
