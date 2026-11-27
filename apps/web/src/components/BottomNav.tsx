import { useLegacyAgentMobile } from "../hooks/useLegacyAgentMobile";
import { NavLink } from "react-router-dom";
import { Plus } from "lucide-react";
import { Suspense } from "react";
import { lazyWithReload } from "../lib/lazyWithReload";
import { hapticTap } from "../lib/haptics";
// Логика «+» (меню быстрых действий по нажатию, голос по удержанию 450 мс, кольцо) —
// одна на две кнопки: эту и «+» в шапке «Нового вида» (components/quickCreate.tsx).
// Меню грузится по нажатию (10.09.2026), заглушка `null` — см. там же.
import { QuickCreateRing, useQuickCreate } from "./quickCreate";
// Состав вкладок — из общего реестра разделов (lib/navigation.ts). Раньше он был
// прошит здесь отдельным списком и расходился с сайдбаром: 2+2 вокруг «+»
// подбирались вручную, а подписи и счётчики жили в двух местах сразу.
import { useNavigation, type NavItem } from "../lib/navigation";
import { useUiPrefs } from "../store/uiPrefs";
import { legacyAgentBottomNavStyles as legacyStyle } from "../lib/legacyAgentBottomNavStyles";

type BottomNavVariant = "current" | "legacy-agent";

/** «Новый вид»: значки капсулы своим куском, только тем, у кого вид включён. */
const RoyalNavIcon = lazyWithReload(() => import("./look/RoyalNavIcon"));

/**
 * Короткий отклик на переключение вкладки.
 *
 * Своя реализация переехала в lib/haptics.ts: отклик понадобился ещё и на
 * сохранение с ошибкой, а три разных длительности, разбросанные по файлам,
 * расходятся при первой же правке и превращают подтверждение в шум.
 */
const tapFeedback = hapticTap;

function Tab({ to, end, icon: Icon, label, badge, variant, royal }: NavItem & { variant: BottomNavVariant; royal?: boolean }) {
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
            {royal
              ? <Suspense fallback={<span className="block w-6 h-6" />}><RoyalNavIcon to={to} active={isActive} /></Suspense>
              : <Icon className={legacy ? legacyStyle.icon(isActive) : "w-6 h-6"} strokeWidth={1.6} />}
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
export function BottomNavSurface({ variant, royal = false, chatOpen = false }: { variant: BottomNavVariant; royal?: boolean; chatOpen?: boolean }) {
  const legacy = variant === "legacy-agent";
  const glass = useUiPrefs((s) => s.glass);
  const { bottom, royalBottom } = useNavigation();
  const { left, right } = bottom;
  // «+»: нажатие — меню быстрых действий, удержание — ассистент сразу с голосом (14.09.2026,
  // владелец: единственный вход в ассистента на телефоне прежнего вида). Кольцо вокруг «+»
  // замыкается за те же 450 мс, что идёт таймер (владелец 11.09: «при удержании нет анимации»).
  const quick = useQuickCreate();
  // Порядок атрибутов разметки — прежний (сторож BottomNav.test.tsx сверяет её байт в байт): обработчики
  // разметку не меняют, признаки кнопки идут в прежнем порядке ниже.
  const { "data-holding": _holding, "aria-haspopup": _haspopup, "aria-expanded": _expanded, ...quickHandlers } = quick.buttonProps;
  void _holding; void _haspopup; void _expanded;

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
      // Открыта переписка нового вида: на телефоне (< 820 px) она занимает весь экран и меню под ней не нужно —
      // скрывает CSS (theme-2026-mobile-shell.css), а не размонтирование: на планшете это боковая рейка, она остаётся.
      data-chat-open={chatOpen || undefined}
      className={legacy ? legacyStyle.nav : "sh-tabbar rh-glass md:hidden fixed bottom-0 left-0 right-0 z-40"}
      style={legacy ? {
        backdropFilter: glass ? "blur(18px) saturate(160%)" : "none",
        WebkitBackdropFilter: glass ? "blur(18px) saturate(160%)" : "none",
        paddingBottom: "calc(env(safe-area-inset-bottom) + 10px)",
      } : undefined}
    >
      {royal ? (
        // «Новый вид» (макет 27.11.2026): пять вкладок без «+» — «+» в шапке (ShellCreateButton).
        <div className="h-[66px] grid grid-cols-5 items-center px-0.5" data-royal-tabs>
          {royalBottom.map((item) => (
            <Tab key={item.to + item.label} {...item} variant={variant} royal />
          ))}
        </div>
      ) : (
      <div className="h-[66px] grid grid-cols-5 items-center px-0.5">
        {left.map((item) => (
          <Tab key={item.to + item.label} {...item} variant={variant} royal={royal} />
        ))}
        <div className="relative h-full grid place-items-center">
          <button
            {...quickHandlers}
            data-holding={quick.buttonProps["data-holding"]}
            aria-label="Быстрые действия, удержите для голосового ввода"
            aria-haspopup="menu"
            aria-expanded={quick.open}
            // 56 px: размер FAB контракта. Заливка и тень --shadow-lg: .sh-fab в CSS оболочки.
            data-fab
            className={legacy ? legacyStyle.fab : "sh-fab w-14 h-14 rounded-full flex items-center justify-center relative"}
          >
            {/* Две окружности: тихая дорожка и белая дуга поверх неё — видно и
                сколько прошло, и сколько осталось (правила в блоке 7.3
                theme-2026-mobile-shell.css). Геометрия из артефакта: viewBox 66,
                r=31, длина окружности 195 — она же stroke-dasharray. */}
            <QuickCreateRing />
            <Plus className="w-[22px] h-[22px]" strokeWidth={1.7} />
          </button>
        </div>
        {right.map((item) => (
          <Tab key={item.to + item.label} {...item} variant={variant} royal={royal} />
        ))}
      </div>
      )}
      {/* Шторка быстрых действий: монтируется только по нажатию (quickCreate.tsx). */}
      {quick.menu}
    </nav>
  );
}

export function BottomNav({ royal = false, chatOpen = false }: { royal?: boolean; chatOpen?: boolean }) {
  const legacy = useLegacyAgentMobile();
  // The legacy agent phone bar has its own contract; «Новый вид» never restyles it.
  return <BottomNavSurface key={legacy ? "legacy-agent" : "current"} variant={legacy ? "legacy-agent" : "current"} royal={royal && !legacy} chatOpen={chatOpen && !legacy} />;
}
