import { useLegacyAgentMobile } from "../hooks/useLegacyAgentMobile";
import { NavLink } from "react-router-dom";
import { Plus } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import { hapticSuccess, hapticTap } from "../lib/haptics";
/**
 * МЕНЮ «+» ЗАГРУЖАЕТСЯ ПО НАЖАТИЮ (10.09.2026).
 *
 * Оно открывается только по нажатию, но статический импорт тянул его в общий
 * входной кусок сборки, который телефон обязан скачать и разобрать ДО первой
 * отрисовки. Заглушка `null`: меню — поверхность поверх экрана, мигать пустой
 * шторкой хуже, чем открыться на кадр позже; файл предзагружается service
 * worker, поэтому и офлайн меню открывается.
 */
const FabMenu = lazy(() => import("./FabMenu").then((m) => ({ default: m.FabMenu })));
// Панель ассистента — общей обёрткой на все места оболочки (там же разобрано,
// почему ленивый импорт обязан быть во ВСЕХ них, иначе сборщик оставляет модуль
// во входном куске).
import { preloadAssistantPanel } from "./AssistantPanelLazy";
import { useAssistantUi } from "../store/assistantUi";
import { useSettings } from "../hooks/useSettings";
// Состав вкладок — из общего реестра разделов (lib/navigation.ts). Раньше он был
// прошит здесь отдельным списком и расходился с сайдбаром: 2+2 вокруг «+»
// подбирались вручную, а подписи и счётчики жили в двух местах сразу.
import { useNavigation, type NavItem } from "../lib/navigation";
import { useUiPrefs } from "../store/uiPrefs";
import { legacyAgentBottomNavStyles as legacyStyle } from "../lib/legacyAgentBottomNavStyles";

type BottomNavVariant = "current" | "legacy-agent";

/**
 * Короткий отклик на переключение вкладки.
 *
 * Своя реализация переехала в lib/haptics.ts: отклик понадобился ещё и на
 * сохранение с ошибкой, а три разных длительности, разбросанные по файлам,
 * расходятся при первой же правке и превращают подтверждение в шум.
 */
const tapFeedback = hapticTap;

function Tab({ to, end, icon: Icon, label, badge, variant }: NavItem & { variant: BottomNavVariant }) {
  const legacy = variant === "legacy-agent";
  return (
    <NavLink
      to={to}
      end={end}
      onClick={tapFeedback}
      // Метрики и цвета — CSS оболочки (`.sh-tab`, theme-royal-home-2026.css):
      // ячейка 56x52, значок 24, подпись 13, активная вкладка — акцентом, отклик на
      // нажатие scale .97. Активность красит `aria-current="page"`, который
      // react-router ставит сам, поэтому цвет в разметке не задаётся.
      className={legacy ? legacyStyle.tab : "sh-tab"}
    >
      {({ isActive }) => (
        <>
          {/* data-tab-icon/data-tab-label — точки входа для скина темы Royal
              Home 2026 (theme-royal-home-2026.css): под старыми темами эти
              атрибуты ничем не заняты, скин целится строго через
              html[data-theme^="royal-home-2026-"], механика вкладки не тронута. */}
          <span className="relative" data-tab-icon>
            <Icon className={legacy ? legacyStyle.icon(isActive) : "w-6 h-6"} strokeWidth={1.6} />
            {/* Значок непрочитанного — по прототипу: 15px, прижат к правому
                верхнему углу иконки (top:-2px; right:-7px), цифра 9px. */}
            {!!badge && (
              <span
                data-tab-badge
                className={legacy ? legacyStyle.badge : "absolute -top-0.5 right-[-7px] px-1 rounded-badge font-bold flex items-center justify-center"}
              >
                {badge > 9 ? "9+" : badge}
              </span>
            )}
          </span>
          <span data-tab-label className={legacy ? legacyStyle.label(isActive) : undefined}>{label}</span>
        </>
      )}
    </NavLink>
  );
}

/** Мобильная навигация — ПРИЖАТА К НИЗУ ЭКРАНА, а не «плавающая пилюля»
 * (владелец 19.08.2026, пересмотр решения от 18.08: «как в других приложениях
 * iPhone — просто прикреплён внизу экрана, зафиксирован»). Раньше была
 * отдельной панелью с отступами и скруглением со всех сторон (NAVBAR[2] «iOS
 * плавающая» из прототипа design_handoff) — теперь во всю ширину, без зазоров
 * по бокам и снизу, верхняя граница вместо скругления. Стекло (блюр) осталось
 * тем же — владелец просил оставить именно его, поменять только форму.
 *
 * Пять равных колонок — Главная, Клиенты, «+», Объекты, Чаты (у агента; состав
 * задаёт `bottom` в lib/navigation.ts, «Ещё» ушло в шторку по аватару в шапке).
 * Центральная кнопка «+» — круг 56px внутри панели. Правый нижний угол не занимаем — там живёт кнопка ИИ-ассистента.
 *
 * КНОПКА «+» ОТКРЫВАЕТ МЕНЮ, А НЕ СРАЗУ ФОРМУ (18.08.2026, по прототипу
 * design_handoff `Royal Home CRM - Мобайл.dc.html`, блок `sheetActs`/`SETS`).
 * Раньше клик сразу вёл на `/properties/new` — так осталось только фактическим
 * первым пунктом меню для роли агента; директор/админ и другие роли видят
 * набор из 4 пунктов, состав задаёт FabMenu.tsx по образцу `SETS.boss` и т.д.
 * из прототипа. Владелец прислал скриншот именно такого меню. */
export function BottomNavSurface({ variant }: { variant: BottomNavVariant }) {
  const legacy = variant === "legacy-agent";
  const glass = useUiPrefs((s) => s.glass);
  const { bottom } = useNavigation();
  const { left, right } = bottom;
  const [fabOpen, setFabOpen] = useState(false);
  // Панель одна на все входы и монтируется в AssistantHost (AppLayout): здесь только
  // просьба её открыть. Поведение «+» прежнее — удержание открывает сразу с голосом.
  const openAssistant = useAssistantUi((s) => s.openAssistant);
  const { data: settings } = useSettings();
  // Долгое нажатие (не клик) — «Удержите кнопку — заполню голосом» прототипа.
  // Единственный вход в ассистента на телефоне (14.09.2026, владелец) — тот же
  // AssistantPanel, что и раньше, только в новом облике (см. его комментарий
  // «ОБЛИК НА ТЕЛЕФОНЕ»): круг-микрофон, включённый сразу, по свободной речи
  // ставит задачи/переносит встречи через /ai/assistant.
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  /**
   * Кольцо прогресса вокруг «+» на время удержания (артефакт владельца
   * c99db05f, блок `.fab`: `fab.classList.add('holding')` на pointerdown).
   *
   * Владелец 11.09: «при удержании нет анимации». Удержание 450 мс открывает
   * голосового ассистента, и до сих пор палец держали вслепую — кнопка не
   * менялась никак, и было непонятно, сработает ли вообще. Дуга замыкается
   * ровно за те же 450 мс, что идёт таймер, поэтому она честно показывает
   * остаток, а не изображает занятость. Правила — блок 7.3
   * theme-2026-mobile-shell.css (панель живёт вне области `.rh2 .mh`,
   * перенесённые стили артефакта до неё не достают).
   */
  const [holding, setHolding] = useState(false);

  function startLongPress() {
    if (!settings?.aiAssistantEnabled) return;
    // Кусок панели начинает скачиваться с касания: за 450 мс удержания он обычно
    // успевает приехать, и шторка открывается без пустого кадра.
    preloadAssistantPanel();
    longPressFired.current = false;
    setHolding(true);
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      setHolding(false);
      // Отклик на СРАБАТЫВАНИЕ, а не на касание: в артефакте здесь 15 мс,
      // то есть заметно длиннее щелчка вкладки (8 мс) — на ощупь это
      // разные события, и путать их нельзя (см. lib/haptics.ts).
      hapticSuccess();
      // Единственный вход в ассистента на телефоне (14.09.2026, владелец):
      // всегда с голосом сразу, без подсказки — второй режим (тап по пункту
      // меню с готовым текстом) убран вместе с самим пунктом в FabMenu.tsx.
      openAssistant({ autoStartVoice: true });
    }, 450);
  }
  function cancelLongPress() {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    setHolding(false);
  }

  return (
    // Единственный стеклянный слой телефона (контракт 06.10.2026): класс
    // `.rh-glass` даёт фон и блюр 16 px + saturate 160 %, тумблер «Эффект стекла»
    // и prefers-reduced-transparency гасят его правилами темы
    // (theme-2026-mobile-shell.css, блок 1). Раньше блюр был вшит inline и
    // игнорировал тумблер. Нижний отступ `calc(10px + safe-area)` — внутри панели
    // (`.sh-tabbar`): стекло тянется до края под индикатор iPhone, а строка
    // вкладок стоит выше него. Запас снизу у экранов (AppLayout.tsx, MH_HOST)
    // считан по этой же высоте: 66 + 10 + safe-area = 96.
    <nav
      data-bottomnav
      className={legacy ? legacyStyle.nav : "sh-tabbar rh-glass md:hidden fixed bottom-0 left-0 right-0 z-40"}
      style={legacy ? {
        backdropFilter: glass ? "blur(18px) saturate(160%)" : "none",
        WebkitBackdropFilter: glass ? "blur(18px) saturate(160%)" : "none",
        paddingBottom: "calc(env(safe-area-inset-bottom) + 10px)",
      } : undefined}
    >
      <div className="h-[66px] grid grid-cols-5 items-center px-0.5">
        {left.map((item) => (
          <Tab key={item.to + item.label} {...item} variant={variant} />
        ))}
        <div className="relative h-full grid place-items-center">
          <button
            onClick={() => {
              // Долгое нажатие уже открыло ассистента — клик по отпусканию
              // пальца не должен вдобавок открыть меню поверх него.
              if (longPressFired.current) return;
              tapFeedback();
              setFabOpen(true);
            }}
            onPointerDown={startLongPress}
            onPointerUp={cancelLongPress}
            onPointerLeave={cancelLongPress}
            onPointerCancel={cancelLongPress}
            onContextMenu={(e) => e.preventDefault()}
            data-holding={holding ? "true" : undefined}
            aria-label="Быстрые действия, удержите для голосового ввода"
            aria-haspopup="menu"
            aria-expanded={fabOpen}
            // 56 px: размер FAB контракта. Заливка и тень --shadow-lg: .sh-fab в CSS оболочки.
            data-fab
            className={legacy ? legacyStyle.fab : "sh-fab w-14 h-14 rounded-full flex items-center justify-center relative"}
          >
            {/* Две окружности: тихая дорожка и белая дуга поверх неё — видно и
                сколько прошло, и сколько осталось (правила в блоке 7.3
                theme-2026-mobile-shell.css). Геометрия из артефакта: viewBox 66,
                r=31, длина окружности 195 — она же stroke-dasharray. */}
            <svg data-fab-ring viewBox="0 0 66 66" aria-hidden="true">
              <circle cx="33" cy="33" r="31" />
              <circle cx="33" cy="33" r="31" />
            </svg>
            <Plus className="w-[22px] h-[22px]" strokeWidth={1.7} />
          </button>
        </div>
        {right.map((item) => (
          <Tab key={item.to + item.label} {...item} variant={variant} />
        ))}
      </div>
      {/* Условный рендер вокруг FabMenu, а не только проп `open`: пока меню не
          открывали, файл не нужно скачивать вовсе. Само меню проп `open`
          сохраняет — его анимация закрытия на нём и держится. */}
      {fabOpen && (
        <Suspense fallback={null}>
          {/* Пункта «Спросить ИИ» в этом меню больше нет (14.09.2026): единственный
              вход в ассистента на телефоне — удержание «+» ниже, onAskAssistant
              из FabMenu убран вместе с ним. */}
          <FabMenu open={fabOpen} onClose={() => setFabOpen(false)} />
        </Suspense>
      )}
    </nav>
  );
}

export function BottomNav() {
  const legacy = useLegacyAgentMobile();
  return <BottomNavSurface key={legacy ? "legacy-agent" : "current"} variant={legacy ? "legacy-agent" : "current"} />;
}
