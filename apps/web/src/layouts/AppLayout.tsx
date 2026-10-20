import { usePushSubscriptionRefresh } from "../hooks/usePushSubscriptionRefresh";
import { Suspense, useEffect, useLayoutEffect, useRef } from "react";
import { Outlet, useNavigate, useLocation, useNavigationType } from "react-router-dom";
import { Skeleton } from "../components/Skeleton";
import { Sidebar } from "../components/Sidebar";
import { PullToRefresh } from "../components/PullToRefresh";
import { Topbar } from "../components/Topbar";
import { BottomNav } from "../components/BottomNav";
import { OfflineBanner } from "../components/OfflineBanner";
import { UploadIndicator } from "../components/UploadIndicator";
import { Toaster } from "../components/ui/Toaster";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { useMyProfile } from "../hooks/useMe";
import { useAuthStore } from "../store/auth";
import { useAppBadge } from "../hooks/useAppBadge";
import { useIdleLogout } from "../hooks/useIdleLogout";
import { useEdgeSwipeBack } from "../hooks/useEdgeSwipeBack";
import { useLiveEvents } from "../hooks/useLiveEvents";
import { useUiPrefs } from "../store/uiPrefs";
import { lazyWithReload } from "../lib/lazyWithReload";
import { isRh2Route } from "../lib/navigation";
import { useCleanShellSelection } from "../hooks/useCleanShell";
import { CleanShell } from "../components/clean/CleanShell";
import { useCleanViewport } from "../hooks/useCleanViewport";
import { ShellAppearanceRecovery } from "../components/clean/ShellAppearanceRecovery";

/**
 * СПУТНИКИ ОБОЛОЧКИ — СВОИМ КУСКОМ (10.09.2026, разгрузка входного куска).
 *
 * Все они висят в разметке постоянно, но на первом кадре не рисуют ничего:
 * баннеры ждут своих данных, окна — звонка и лида, подсказка установки —
 * третьего захода. При этом статическими импортами они держали во входном
 * куске около 230 КБ исходника.
 *
 * Самым крупным здесь был PendingSummaryBanner (2358 строк, а с ним запись
 * голоса, распознавание речи, useClients и useProperties). 13.09.2026 он удалён
 * вместе со всем механизмом обязательных окон (владелец: «вообще убери») —
 * механизм и так стоял на паузе рубильником с 08.09.2026 и не рисовал ничего.
 *
 * Ленивая загрузка НИЧЕГО не откладывает по смыслу: React начинает тянуть
 * кусок сразу, как только доходит до компонента, то есть в том же кадре.
 * Разница в том, что первая отрисовка его не ждёт — куски едут параллельно,
 * а не одним куском перед стартом.
 *
 * Через `lazyWithReload`, а не голый `lazy`: после выката старый кусок
 * исчезает с сервера, и открытая вкладка должна не падать, а обновиться.
 */
const InstallAppHint = lazyWithReload(() =>
  import("../components/InstallAppHint").then((m) => ({ default: m.InstallAppHint }))
);
const OwnerQuestionsBanner = lazyWithReload(() =>
  import("../components/OwnerQuestionsBanner").then((m) => ({ default: m.OwnerQuestionsBanner }))
);
const OwnerQuestionsStrip = lazyWithReload(() =>
  import("../components/OwnerQuestionsBanner").then((m) => ({ default: m.OwnerQuestionsStrip }))
);
const CallWindow = lazyWithReload(() => import("../components/CallWindow").then((m) => ({ default: m.CallWindow })));
const IncomingLeadWindow = lazyWithReload(() =>
  import("../components/IncomingLeadWindow").then((m) => ({ default: m.IncomingLeadWindow }))
);
const NotificationsBanner = lazyWithReload(() =>
  import("../components/NotificationsBanner").then((m) => ({ default: m.NotificationsBanner }))
);
/** Место содержимого, пока догружается файл раздела. Обычно это доли секунды на
 *  первом заходе в раздел; дальше файл лежит в кэше браузера и заглушки не видно. */
function SectionFallback() {
  return (
    <div className="p-4 flex flex-col gap-3" aria-busy="true" aria-label="Загрузка раздела">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

export function AppLayout() {
  const { clean, pending: shellPending, unavailable: appearanceUnavailable } = useCleanShellSelection(true);
  useCleanViewport(clean);
  usePushSubscriptionRefresh();
  const renderedContent = useRef(false);
  useLayoutEffect(() => { if (!shellPending) renderedContent.current = true; }, [shellPending]);
  useLayoutEffect(() => {
    if (clean) document.documentElement.dataset.shell = "clean";
    else delete document.documentElement.dataset.shell;
    return () => { delete document.documentElement.dataset.shell; };
  }, [clean]);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const scrollRef = useRef<HTMLDivElement>(null);
  /**
   * ПЕРЕНЕСЁН ЛИ ЭКРАН НА ТЕМУ «ROYAL HOME 2026».
   *
   * Две подсказки ниже (просьба о звонке, вопрос собственнику) монтируются
   * ЗДЕСЬ, то есть стоят над содержимым любого из 25 разделов. CSS темы
   * ограничен селектором `.rh2` и до них не достаёт, поэтому облик выбирается по
   * маршруту. Список перенесённых разделов живёт рядом с реестром:
   * `isRh2Route` в lib/navigation.ts (с 06.10.2026, раньше здесь стояла
   * регулярка, которую приходилось помнить отдельно). Добавляете экран на тему —
   * добавляйте и его путь туда.
   *
   * `NotificationsBanner` сюда не входит (21.09.2026, разбор внешнего вида,
   * §2.4) — он всегда рисуется через `Rh2Inline` и показывается только на
   * «Главной», см. вызов ниже.
   */
  const rh2Screen = isRh2Route(pathname);
  useIdleLogout();
  // Число на иконке установленного приложения — непрочитанные уведомления
  // (27.08.2026: раньше это была сумма счётчиков меню, и значок не гас никогда —
  // см. useAppBadge). Где Badging API не поддержан, вызов ничего не делает.
  useAppBadge();
  // Свайп от левого края — «назад». В установленном приложении адресной строки нет,
  // и без этого жеста вернуться можно только стрелкой внутри интерфейса.
  useEdgeSwipeBack();
  // Живые данные без перезагрузки: одно соединение SSE на вкладку, точечная
  // инвалидация ключей вместо таймеров. Опрос по таймеру оставлен запасным
  // путём — см. lib/liveEvents.ts.
  useLiveEvents();

  /**
   * ВОЗВРАТ НАЗАД ВОЗВРАЩАЕТ И МЕСТО В СПИСКЕ.
   *
   * Было: `scrollTo(0, 0)` на каждый переход. Агент долистывал список клиентов до
   * двадцатого, открывал его, нажимал «назад» — и снова смотрел на первого, потому
   * что список начинался сверху. На телефоне, где в экран помещается пять строк,
   * это означало перелистывать всё заново после каждой карточки. Ни одно телефонное
   * приложение так себя не ведёт (владелец 10.08.2026: «чтобы люди не чувствовали,
   * что они не в приложении»).
   *
   * Стало: позиция каждого экрана запоминается при уходе с него и возвращается,
   * когда на него пришли КНОПКОЙ НАЗАД. Переход вперёд по-прежнему открывает экран
   * сверху — новую карточку показывать с середины было бы странно. Отличить одно от
   * другого позволяет navigationType из React Router: POP — это «назад/вперёд» в
   * истории браузера, PUSH — новый переход.
   *
   * Позиции живут в обычном Map в памяти вкладки, а не в sessionStorage: они нужны
   * ровно до перезагрузки страницы, а после неё список всё равно перезапрашивается
   * и может оказаться другой длины.
   *
   * Скроллер разный на разных ширинах: на компьютере прокручивается внутренний div
   * (боковое меню обязано стоять на месте), на телефоне — сама страница. Поэтому
   * работаем с обоими: лишний вызов ничего не стоит.
   */
  const scrollPositions = useRef(new Map<string, number>());
  const navigationType = useNavigationType();
  const previousScrollRoute = useRef<{ pathname: string; shellPending: boolean } | null>(null);

  useEffect(() => {
    const previous = previousScrollRoute.current;
    previousScrollRoute.current = { pathname, shellPending };
    // Filter synchronisation replaces the query on the same screen. Resetting
    // here cancels deliberate in-page navigation (for example a call KPI → log).
    // A new route or a newly mounted shell still uses the normal restoration.
    if (navigationType === "REPLACE" && previous?.pathname === pathname && previous.shellPending === shellPending) return;
    const key = pathname;
    const saved = scrollPositions.current.get(key);
    if (navigationType === "POP" && saved !== undefined) {
      // Кадр ожидания: на момент смены маршрута новая страница ещё не отрисована,
      // высота у контейнера прежняя, и прокрутка к 800px просто упёрлась бы в конец
      // короткого экрана. requestAnimationFrame отдаёт управление после отрисовки.
      const restore = () => {
        scrollRef.current?.scrollTo(0, saved);
        window.scrollTo(0, saved);
      };
      const frame = requestAnimationFrame(restore);
      return () => cancelAnimationFrame(frame);
    }
    scrollRef.current?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  }, [pathname, navigationType, shellPending]);

  /**
   * Позиция запоминается ПО ХОДУ прокрутки, а не в момент ухода с экрана.
   *
   * Соблазнительно прочитать её в функции очистки эффекта — но к этому моменту
   * React уже мог заменить содержимое контейнера, и вместо позиции списка
   * запомнился бы ноль. Слушатель прокрутки таких вопросов не задаёт: он пишет
   * последнее известное значение, и оно всегда верное.
   */
  useEffect(() => {
    const key = pathname;
    const positions = scrollPositions.current;
    const node = scrollRef.current;
    const remember = () => {
      // History changes before this effect's old listener is cleaned up. A DOM
      // shrink or interrupted smooth scroll then belongs to the destination,
      // and must not overwrite the source screen's last real position.
      if (window.location.pathname !== key) return;
      positions.set(key, node?.scrollTop || window.scrollY || 0);
      // Больше тридцати экранов держать незачем: это уже не «вернуться назад»,
      // а история за весь день.
      if (positions.size > 30) positions.delete(positions.keys().next().value!);
    };
    node?.addEventListener("scroll", remember, { passive: true });
    window.addEventListener("scroll", remember, { passive: true });
    return () => {
      node?.removeEventListener("scroll", remember);
      window.removeEventListener("scroll", remember);
    };
  }, [pathname, shellPending]);

  // Тема/настройки оформления из БД: при открытом приложении без повторного логина
  // (восстановленная сессия) localStorage уже применён, здесь докатываются серверные.
  const { data: me } = useMyProfile();
  const actorId = useAuthStore((state) => state.agent?.id);
  const hydrate = useUiPrefs((s) => s.hydrateFromServer);
  useEffect(() => {
    if (me && me.id === actorId) hydrate(me.preferences);
  }, [me, hydrate, actorId]);

  // Клик по push-уведомлению шлёт сообщение из Service Worker (см. src/sw.ts,
  // notificationclick) вместо обычной ссылки — так вкладка не перезагружается,
  // а React Router просто переключает маршрут.
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === "PUSH_NAVIGATE" && typeof event.data.url === "string") {
        navigate(event.data.url);
      }
    }
    navigator.serviceWorker?.addEventListener("message", handleMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", handleMessage);
  }, [navigate]);

  // A width change must not throw away an already mounted form while policy loads.
  if (shellPending && !renderedContent.current) return <SectionFallback />;

  return (
    // ВАЖНО про прокрутку на телефоне.
    // Раньше здесь безусловно стояли `h-screen overflow-hidden` снаружи и
    // `overflow-y-auto` внутри. На десктопе это правильно: сайдбар обязан стоять
    // на месте, пока едет контент. Но на iPhone тот же приём давал ровно то, на
    // что жаловался владелец — «тянется туда-сюда»:
    //   · два вложенных упругих контейнера (страница и div) отскакивают каждый
    //     по-своему, палец получает двойную резину;
    //   · Safari прячет адресную строку только при прокрутке САМОЙ страницы —
    //     внутренний скроллер этого не запускает, поэтому строка висела всегда;
    //   · 100vh на iOS больше видимой области (в него заложена спрятанная адресная
    //     строка), из-за чего низ экрана прыгал.
    // Ниже скроллер включается только с md: на телефоне прокручивается обычная
    // страница, как на любом нормальном сайте. Высота — 100dvh (динамическая,
    // равна тому, что видно сейчас), а не 100vh.
    <div className={clean ? "app-shell clean-shell text-ink font-sans" : "app-shell flex min-h-dvh md:h-screen text-ink font-sans md:overflow-hidden"}>
      {clean && <a href="#main" className="clean-skip-link">К содержимому</a>}
      {!clean && <Sidebar />}
      {/* overscroll-contain на десктопном скроллере: докрутив список до конца,
          колесо больше не «пробивает» прокрутку наружу. */}
      <div
        ref={scrollRef}
        // pt-[env(safe-area-inset-top)] — на телефоне (standalone PWA, status-bar-style
        // black-translucent + viewport-fit=cover в index.html) контент рисуется ПОД
        // вырезом/островом камеры без этого отступа: шапка (Topbar или своя шапка
        // MobileHome*) заезжала под часы и заряд батареи вместо того, чтобы стоять
        // ниже них (жалоба владельца 19.08.2026). На десктопе и на телефонах без
        // выреза переменная равна нулю — правило безвредно везде.
        className={clean ? "clean-frame" : "flex-1 flex flex-col min-w-0 md:overflow-y-auto md:overscroll-contain pt-[env(safe-area-inset-top)]"}
      >
        {clean ? <CleanShell /> : <Topbar />}
        {appearanceUnavailable && <ShellAppearanceRecovery />}
        {/* Загрузка файлов идёт минутами, а человек за это время уходит на другие
            экраны. Указатель липнет под верхней панелью и виден отовсюду, пока
            очередь не пуста, — иначе агент решает, что всё пропало. */}
        <UploadIndicator />
        <OfflineBanner />
        {/* 1600px: на больших мониторах CRM заполняет экран как десктоп-приложение, а не узкая колонка.
            Запас снизу: на телефоне — под нижнюю навигацию (BottomNav.tsx: mb-3 + h-[66px] +
            safe-area ≈ 78px), берём с малым запасом. На ПК 12.09.2026 убран вовсе (было md:pb-20
            под плавающую кнопку ассистента, которой больше нет): пустая полоса в 80px внизу
            каждого экрана ПК ни под что не отведена, и на коротких экранах она отнимала строку. */}
        {/* Clean keeps the viewport/Suspense mounted while a cold route chunk loads.
            The legacy shell retains its established per-route entrance behavior. */}
        <main id="main" tabIndex={-1}
          key={clean ? "clean-main" : pathname}
          data-page-enter
          // px-4 md:px-6 — боковые поля контракта оболочки (06.10.2026: 16 на
          // телефоне, 24 от 820 px). Было px-5 с 10.09 ради полосы, в которой
          // читается подложка-аврора; контракт вернул 16 — сетка кратна восьми.
          // Области `.mh` гасят эти поля отрицательным отступом -16px
          // (MH_HOST в MhScreen/MhList и страницах), число обязано совпадать.
          // pb-[96px+safe] — под таббар (66 + 10 + safe-area) только на < 820.
          // app-main-col — зацепка для CSS темы: на пульте директора
          // (html без data-screen) потолок колонки поднимается до 1880px,
          // иначе восемь разделов не во что раскладывать в два столбца
          // (theme-royal-home-2026.css, блок «ПК: пульт в два столбца»).
          className="app-main-col px-4 md:px-6 pt-4 pb-[calc(96px+env(safe-area-inset-bottom))] md:pb-8 max-w-[1600px] w-full mx-auto"
        >
          {/* Баннеры под одной границей ожидания: пока их куски едут,
              на месте каждого пусто — ровно то же, что они рисуют, когда
              показывать нечего.
              «Включите уведомления» — только на «Главной» (21.09.2026,
              разбор внешнего вида, §2.4): это первое, что видел человек на
              32 экранах из 36, стоя выше заголовка раздела. Один раз на
              сессию и так достаточно — крестик и так напоминает через
              RENUDGE_DAYS, а показывать его заново на каждом переходе между
              разделами незачем. */}
          <Suspense fallback={null}>
            {pathname === "/" && <NotificationsBanner />}
            {/* Плашки «Клиент просит звонок» здесь больше нет (владелец 24.09.2026:
                «мне не нужна просьба позвонить и плашка» — её видели директор и
                админ, хотя звонить должен агент). Прямая просьба о живом человеке
                приходит пушем адресату: lib/callbackRequests.ts, notifyHumanAsk. */}
            {/* Полная панель — только там, где на неё специально смотрят (Главная,
                Сообщения). Остальные 23 экрана получают OwnerQuestionsStrip: тот же
                вопрос ждёт ответа, но строкой, а не карточкой на ~320px/две трети
                телефона — компонент был написан именно под это (см. его комментарий
                в OwnerQuestionsBanner.tsx), но подключить его сюда забыли, и полная
                панель до сих пор занимала верх каждого раздела. */}
            {pathname === "/" || pathname === "/messages" ? (
              <OwnerQuestionsBanner />
            ) : (
              <OwnerQuestionsStrip rh2={rh2Screen} />
            )}
          </Suspense>
          {/* Потянуть вниз — обновить. Обёртка вокруг содержимого страницы, а не
              вокруг всего приложения: жест должен обновлять раздел, в котором
              человек находится, и не мешать шапке с меню. Внутри границы ошибок
              нет смысла — она про падение экрана, а не про жест. */}
          <PullToRefresh>
            {/* Вторая граница ошибок — вокруг содержимого страницы, а не всего
                приложения. Падение одного экрана больше не уносит меню и шапку:
                человек видит ошибку в области контента и может уйти в другой
                раздел, не перезагружая страницу. resetKey сбрасывает ошибку при
                переходе — верхняя граница этого не умела, потому что стоит выше
                роутера и о смене маршрута не знает. */}
            <ErrorBoundary key={clean ? "clean-route" : pathname} resetKey={clean ? pathname : undefined}>
              {/* Разделы грузятся отдельными файлами (см. App.tsx): без этого при
                  первом заходе в раздел React выбрасывал бы «suspended while
                  rendering» вместо экрана. Заглушка нарочно скромная и только на
                  месте содержимого — шапка, меню и сайдбар остаются на месте,
                  поэтому переход между разделами не выглядит перезагрузкой. */}
              <Suspense fallback={<SectionFallback />}>
                <Outlet />
              </Suspense>
            </ErrorBoundary>
          </PullToRefresh>
        </main>
      </div>
      <BottomNav />
      {/* Предложение установить CRM как приложение — на третий заход, только на
          телефоне и только если она ещё не установлена. См. InstallAppHint. */}
      <Suspense fallback={null}>
        <InstallAppHint />
      </Suspense>
      {/* UpdatePrompt переехал на уровень App.tsx (сиблинг <Routes>, монтируется
          один раз на жизнь вкладки) — см. комментарий в UpdatePrompt.tsx: здесь,
          внутри ProtectedRoute/AppLayout, компонент терял состояние при
          пересборке дерева и не показывался вовсе на /login. */}
      {/* Окно исходящего звонка. На уровне layout, а не страницы: разговор не
          привязан к разделу — агент может уйти в календарь и продолжать говорить.
          18.08.2026 отсюда исчезли карточка входящего с разбором обращения и
          управление браузерной трубкой: роль оператора входящих отменена, а
          вместе с ней удалён и софтфон (см. CallWindow.tsx). */}
      <Suspense fallback={null}>
        <CallWindow />
      </Suspense>
      {/* Входящий лид как звонок — полноэкранное окно на телефоне у роли AGENT.
          Здесь, а не на Главной, ровно по той же причине, что и окно разговора:
          лид приходит, пока агент работает в любом из 25 разделов, и до сих пор
          он узнавал о нём только вернувшись на Главную. Свой слой (z-index 44)
          лежит ниже окна разговора (45) — идущий разговор важнее нового лида —
          и ниже обязательного окна (60). Push и приём в карточке не тронуты:
          это дополнительный путь, а не замена (см. IncomingLeadWindow.tsx). */}
      <Suspense fallback={null}>
        <IncomingLeadWindow />
      </Suspense>
      {/* «Пробуждение» — заставка-приветствие ИИ. ПЕРЕЕХАЛА в App.tsx (08.09.2026,
          docs/ai-greeting-08-09/reports/P1-splash-v2.md) — здесь она жила внутри
          ProtectedRoute, чьё поддерево (AppSkeleton ⇄ AppLayout ⇄ Navigate)
          пересобиралось при восстановлении сессии/логине, роняя видимость и
          таймеры заставки на середине показа («была на секунду»). См. комментарий
          в начале GreetingSplash.tsx. */}
      {/* Подтверждения «Сохранено» ПЕРЕЕХАЛИ в App.tsx (10.09.2026): здесь они
          жили под ProtectedRoute и потому не показывались ни на /login, ни во
          время восстановления сессии — тот же класс ошибки, что был у
          UpdatePrompt до переезда. Строку «Приложение обновлено» после
          молчаливой подмены сборки показывать некому было бы. */}
      <Toaster />
    </div>
  );
}
