import {
  Activity as ActivityIcon,
  Antenna,
  Archive as ArchiveIcon,
  ArrowLeftRight,
  BarChart3,
  Calendar,
  Clapperboard,
  Clock,
  Compass,
  Filter,
  Gauge,
  Globe,
  GraduationCap,
  Grip,
  HeartPulse,
  Home,
  Inbox,
  BriefcaseBusiness,
  LayoutGrid,
  Map as MapIcon,
  Megaphone,
  MessageCircle,
  MessageSquare,
  PhoneCall,
  Radar,
  Settings,
  Share2,
  ShieldAlert,
  DatabaseBackup,
  Plug,
  TimerReset,
  UserX,
  Users,
  UsersRound,
  Wallet,
  Workflow,
} from "lucide-react";
import type { PermissionId, Role } from "@royal-home/shared";
import { useAuthStore } from "../store/auth";
import { useCan } from "./permissions";
import { useCounters } from "../hooks/useCounters";
import { useSiteNotifications } from "../hooks/useSiteNotifications";
import { useOversightSummary } from "../hooks/useOversight";
import { useMarketingSummary, useEditorsLoad } from "../hooks/useMarketing";
import { useSettings } from "../hooks/useSettings";
import { useDeleteRequests, usePropertyDeleteRequests } from "../hooks/useDeleteRequests";
import { BrainCircuit } from "lucide-react";

/**
 * ОДИН реестр разделов CRM — для всех точек входа сразу.
 *
 * ЗАЧЕМ. Карта навигации была написана руками ТРИЖДЫ: в Sidebar.tsx (компьютер),
 * BottomNav.tsx (нижние вкладки телефона) и ProfileMenu.tsx (меню под аватаркой).
 * Три списка неизбежно разъезжаются, и разъехались: сайдбар помечен
 * `hidden md:flex`, а в меню профиля перечислена лишь часть разделов — на
 * телефоне не существовало пути в «Горячих клиентов», «Потерянных», «Продавцов»,
 * «Звонки», «Телефонию», «Контроль руководителя», «Службу безопасности» и
 * «Активность команды». Восемь разделов, до которых нельзя дойти с устройства,
 * с которого агенты и работают.
 *
 * Теперь состав, права и счётчики живут здесь, а Sidebar/BottomNav/ProfileMenu
 * только рисуют. Добавить раздел — одна строка в одном месте, и он появляется
 * везде, где положено.
 *
 * Слой 4 (docs/pult/theme-2026/layer-3-plan.md §4.3.4) снял флаг `isRH2026`:
 * тема «Royal Home 2026» — единственная, поэтому реестр 7+3 групп
 * (`buildNavigation` ниже, бывший `buildNavigationV2`) — единственная версия
 * меню. Старый реестр (`main`/`sections`/`system` с восемью пунктами) удалён.
 */

export type NavGroupKey =
  | "main"
  | "inbox"
  | "people"
  | "objects"
  | "team"
  | "money"
  | "ads"
  | "system";

export interface NavItem {
  to: string;
  end?: boolean;
  label: string;
  icon: typeof LayoutGrid;
  badge?: number;
  /** Счётчик справочный, а не «требует действия»: в сумму группы не входит
   *  (например, кандидаты в «Вакансиях» — их 64, и они не горят). */
  badgeQuiet?: boolean;
  group: NavGroupKey;
}

export interface NavGroup {
  key: NavGroupKey;
  title: string;
  icon: typeof LayoutGrid;
  items: NavItem[];
}

export interface Navigation {
  /** Ежедневное — плоским списком наверху меню. */
  main: NavItem[];
  /**
   * Нижняя группа рейки ПК и хвост экрана «Ещё»: то, что роль не держит на
   * виду. Сейчас заполнено только у AGENT (Звонки, Команда); у остальных пусто.
   */
  more: NavItem[];
  /** Складки: 7 групп таблицы `roles-check.md` §1. */
  sections: NavGroup[];
  /** Не используется отдельно — группа «Настройки» входит в `sections`. */
  system: NavItem[];
  /** Всё подряд: меню профиля на телефоне и поиск по разделам. */
  all: NavItem[];
  /** Нижние вкладки телефона: 2 слева и 2 справа от кнопки «+». */
  bottom: { left: NavItem[]; right: NavItem[] };
}

/** Входные данные реестра — считаются хуками один раз в `useNavigation()`.
 * Вынесены в отдельный тип, чтобы `buildNavigation` строилась и тестировалась
 * чистыми данными, без похода в React-дерево (см. `__tests__/navigation.test.ts`). */
export interface NavInputs {
  role: Role | undefined;
  can: (permission: PermissionId) => boolean;
  counters?: { clients?: number; deals?: number; calendar?: number; messages?: number; comments?: number; calls?: number; vacancies?: number };
  /** `total` — честное число ВСЕХ неразобранных, не длина обрезанного пределом
   *  списка (см. hooks/useSiteNotifications.ts). */
  siteNotifications?: { total?: number };
  oversightSummary?: { overdueTasks?: number };
  marketingSummary?: { overdue?: number };
  editorsLoad?: { sharedQueue: { inEditing: number; overdue: number } };
  deleteRequests?: { items: unknown[] };
  propertyDeleteRequests?: { items: unknown[] };
  settings?: { botTrainingScreenEnabled?: boolean };
}

export function useNavigation(): Navigation {
  const can = useCan();
  const role = useAuthStore((s) => s.agent?.role);
  const { data: counters } = useCounters();
  const { data: siteNotifications } = useSiteNotifications({ enabled: can("siteChanges.view") });
  const { data: oversightSummary } = useOversightSummary(can("dashboard.analytics"));
  const { data: marketingSummary } = useMarketingSummary(
    role === "MARKETING" || role === "DIRECTOR" || role === "ADMIN"
  );
  const { data: editorsLoad } = useEditorsLoad(role === "EDITOR");
  // Заявки агентов на удаление клиентов — только тому, кто их и рассматривает.
  const { data: deleteRequests } = useDeleteRequests(can("archive.view") && can("clients.delete"));
  // То же самое для объектов (31.08.2026) — отдельный счётчик, суммируется в
  // один значок «Архива» ниже: обе очереди живут на одной странице.
  const { data: propertyDeleteRequests } = usePropertyDeleteRequests(can("archive.view") && can("properties.delete"));
  // Экран «Тренировка» читает свой же рубильник из общих настроек — запрос уже
  // закэширован (staleTime 60с), другие потребители Настроек его не заметят.
  const { data: settings } = useSettings();

  const inputs: NavInputs = {
    role,
    can,
    counters,
    siteNotifications,
    oversightSummary,
    marketingSummary,
    editorsLoad,
    deleteRequests,
    propertyDeleteRequests,
    settings,
  };

  return buildNavigation(inputs);
}

/**
 * Раздел «Маркетинг»/«Монтаж» — видимость по ПРАВУ, не по роли
 * (layer-3-plan.md §2.2, `roles-check.md` §2.3): то же условие, что стоит на
 * сервере (`properties.moderate` для одобрения, `properties.aiListing` для
 * генерации описаний/подписи к видео). На день правки задачи 3 право уже есть в
 * пресетах MARKETING/EDITOR/DIRECTOR/ADMIN (см. `permissions.ts`), поэтому
 * предикат-заглушка с TODO на L3-T1 не понадобился — если задача 1 слоя 3
 * когда-нибудь сузит пресеты, эта строка обязана быть частью того же PR.
 */
function canSeeMarketing(inputs: Pick<NavInputs, "can">): boolean {
  return inputs.can("properties.moderate") || inputs.can("properties.aiListing");
}

/**
 * Реестр меню — 7 групп + 3 плоских пункта, таблица
 * `spec-pult-v8-07-09.md`/`roles-check.md` §1 (layer-3-plan.md §1, §3 задача 3).
 * «Ключи» не заводится: право `keys.*` в коде отсутствует (`roles-check.md` §3,
 * вопрос владельцу §5.3) — раздел не строится без права на сервере.
 */
function buildNavigation(inputs: NavInputs): Navigation {
  const { role, can, counters, siteNotifications, oversightSummary, marketingSummary, editorsLoad, deleteRequests, propertyDeleteRequests, settings } =
    inputs;

  const isSalesRole = role !== "MARKETING" && role !== "EDITOR";
  const marketingVisible = canSeeMarketing(inputs);
  // Подпись/иконка выбираются РОЛЬЮ отдельно от видимости (право решает видимость,
  // роль — как назвать пункт), см. layer-3-plan.md §2.2.
  const isEditorLabel = role === "EDITOR";

  // 3 плоских пункта верха: Главная + Календарь (роут `/mission-control` не
  // заводится под новой темой — редирект на «/» делает `MissionControl.tsx`,
  // задача 4). «Поиск ⌘K» — не элемент реестра: он уже рисуется самим Sidebar
  // (см. шапку файла), под обеими темами одинаково.
  const main = compact<NavItem>([
    {
      to: "/",
      end: true,
      icon: LayoutGrid,
      label: "Главная",
      badge: role === "EDITOR" ? editorsLoad?.sharedQueue.inEditing ?? 0 : undefined,
      group: "main",
    },
    { to: "/calendar", icon: Calendar, label: "Календарь", badge: counters?.calendar ?? 0, group: "main" },
  ]);

  /** Группа 1 — Обращения (без «Воронки»: она переехала в «Рекламу», см. группу 6). */
  const inboxItems = compact<NavItem>([
    (can("messages.view") || can("messages.viewOwn")) && {
      to: "/messages",
      icon: MessageSquare,
      label: "Сообщения",
      badge: counters?.messages ?? 0,
      group: "inbox",
    },
    can("messages.view") && {
      to: "/comments",
      icon: MessageCircle,
      label: "Комментарии",
      badge: counters?.comments ?? 0,
      group: "inbox",
    },
    (can("calls.transcripts") || can("calls.ownTranscripts")) && {
      to: "/calls",
      icon: PhoneCall,
      label: can("calls.transcripts") ? "Звонки" : "Мои звонки",
      badge: counters?.calls ?? 0,
      group: "inbox",
    },
    can("calls.transcripts") && { to: "/telephony", icon: Antenna, label: "Телефония", group: "inbox" },
  ]);

  /** Группа 2 — Клиенты и сделки (переименована из «Люди», §1 spec-pult-v8). */
  const peopleItems = compact<NavItem>([
    isSalesRole && { to: "/clients", icon: Users, label: "Клиенты", badge: counters?.clients ?? 0, group: "people" },
    // «Воронка лидов» (макет c99db05f, renderFunnel, 14.09.2026) — НЕ путать с
    // «/funnel» ниже (лид-магниты маркетинга, группа «ads», другая сущность).
    isSalesRole && { to: "/lead-funnel", icon: Radar, label: "Воронка лидов", group: "people" },
    // «Отложенные» (задача G, план 03-04.09.2026) — отдельный пункт меню, НЕ
    // только вкладка внутри ClientsTabs: та скрыта для role="AGENT" целиком (см.
    // components/ClientsTabs.tsx), а этот раздел агенту нужен не меньше, чем
    // руководству («агенту — свои отложенные, руководителю — все», решение
    // владельца) — сервер (GET /clients/deferred) сам скоупит по своему агенту.
    isSalesRole && { to: "/deferred-clients", icon: Clock, label: "Отложенные", group: "people" },
    // «Потерянные» (раздел 3, п.4 плана переноса 14.09.2026) — страница уже
    // существовала (GET /clients?status=lost, решение владельца 11.08.2026),
    // но ни один пункт меню на неё не ссылался.
    // Право то же, что у сервера (GET /clients/lost — `clients.assign`) и у
    // вкладки в ClientsSectionLane: агенту пункт обещал экран, которого у него нет.
    isSalesRole && can("clients.assign") && { to: "/lost-clients", icon: UserX, label: "Потерянные", group: "people" },
    isSalesRole && { to: "/deals", icon: ArrowLeftRight, label: "Сделки", badge: counters?.deals ?? 0, group: "people" },
  ]);

  /** Группа 3 — Объекты («Ключи» пропущен, права нет — см. комментарий над функцией). */
  const objectsItems = compact<NavItem>([
    { to: "/properties", icon: Home, label: "Объекты", group: "objects" },
    { to: "/properties/map", icon: MapIcon, label: "Карта объектов", group: "objects" },
    can("siteChanges.view") && {
      to: "/site-changes",
      icon: Globe,
      label: "Изменения на сайте",
      badge: siteNotifications?.total ?? 0,
      group: "objects",
    },
  ]);

  /** Группа 4 — Команда. */
  const teamItems = compact<NavItem>([
    { to: "/team", icon: UsersRound, label: "Команда", group: "team" },
    {
      to: "/activity",
      icon: ActivityIcon,
      label: can("clients.viewAll") ? "Активность команды" : "Моя активность",
      group: "team",
    },
    can("dashboard.analytics") && {
      to: "/oversight",
      icon: Gauge,
      label: "Контроль руководителя",
      badge: oversightSummary?.overdueTasks ?? 0,
      group: "team",
    },
    can("vacancies.view") && {
      to: "/vacancies",
      icon: BriefcaseBusiness,
      label: "Вакансии",
      badge: counters?.vacancies ?? 0,
      badgeQuiet: true,
      group: "team",
    },
    can("clients.securityReview") && { to: "/security", icon: ShieldAlert, label: "Служба безопасности", group: "team" },
  ]);

  /** Группа 5 — Деньги. */
  const moneyItems = compact<NavItem>([
    can("finance.view") && { to: "/finance", icon: Wallet, label: "Финансы", group: "money" },
    can("reports.view") && { to: "/reports", icon: BarChart3, label: "Отчёты", group: "money" },
    can("reports.view") && { to: "/sources", icon: Compass, label: "Источники лидов", group: "money" },
    // Экран «Инсайты» рисует вкладки «Денег» (MoneyTabs в SectionTabs.tsx), а в
    // меню стоял в «Настройках»: открыл из одного раздела, оказался в другом.
    can("insights.view") && { to: "/insights", icon: BrainCircuit, label: "Инсайты от ИИ", group: "money" },
  ]);

  /** Группа 6 — Реклама и публикации (сюда же переехала «Воронка»). */
  const adsItems = compact<NavItem>([
    (can("finance.view") || role === "MARKETING") && { to: "/ads", icon: Megaphone, label: "Реклама", group: "ads" },
    marketingVisible && {
      to: "/marketing",
      icon: isEditorLabel ? Clapperboard : Megaphone,
      label: isEditorLabel ? "Монтаж" : "Маркетинг",
      badge: isEditorLabel ? editorsLoad?.sharedQueue.overdue ?? 0 : marketingSummary?.overdue ?? 0,
      group: "ads",
    },
    // «Ролики в соцсети» (12.10.2026) — свободный промо-ролик без объекта во все
    // сети. Видимость по РОЛИ, а не по canSeeMarketing: то право есть и у
    // монтажёра, которому сервер (/social-videos) ответит 403.
    (role === "MARKETING" || role === "DIRECTOR" || role === "ADMIN") && {
      to: "/social-videos",
      icon: Share2,
      label: "Ролики в соцсети",
      group: "ads",
    },
    // «Подготовка объектов» (до 25.09.2026 — «Конвейер», переименовано
    // владельцем: «имя непрофессиональное»; перенос мобильного макета
    // 14.09.2026, функция renderPipeline) — то же право, что открывает
    // «Маркетинг»/«Монтаж» выше: отдельный экран с чипом «Ждёт меня», раньше
    // попасть сюда можно было только фильтром в общем списке объектов.
    marketingVisible && {
      to: "/pipeline",
      icon: Workflow,
      label: "Подготовка объектов",
      group: "ads",
    },
    can("settings.view") && { to: "/funnel", icon: Filter, label: "Воронка", group: "ads" },
  ]);

  /** Группа 7 — Настройки (система растворяется в эту группу, §1 spec-pult-v8). */
  const systemItems = compact<NavItem>([
    can("settings.view") && { to: "/settings", icon: Settings, label: "Настройки CRM", group: "system" },
    can("auditLog.view") && { to: "/health", icon: HeartPulse, label: "Здоровье системы", group: "system" },
    // «Интеграции и каналы» / «Резервные копии» (раздел 3, п.2 плана переноса
    // 14.09.2026) — раньше в коде не было ни маршрута, ни данных вообще; шаг 5.
    can("auditLog.view") && { to: "/integrations", icon: Plug, label: "Интеграции и каналы", group: "system" },
    can("auditLog.view") && { to: "/backups", icon: DatabaseBackup, label: "Резервные копии", group: "system" },
    // «Что не доехало» (владелец 21.09.2026) — задания фоновой очереди,
    // исчерпавшие попытки или зависшие, см. pages/StuckWork.tsx.
    can("auditLog.view") && { to: "/stuck-work", icon: TimerReset, label: "Что не доехало", group: "system" },
    // «Тренировка» перестала быть отдельным пунктом меню (слияние экранов
    // 15.09.2026): это теперь вкладка «Манера» на /ai-learning, тот же
    // рубильник settings?.botTrainingScreenEnabled решает видимость самой
    // вкладки внутри экрана, а не строки меню.
    can("settings.view") && { to: "/ai-learning", icon: GraduationCap, label: "Обучение бота", group: "system" },
    can("archive.view") && {
      to: "/archive",
      icon: ArchiveIcon,
      label: "Архив",
      badge: (deleteRequests?.items.length ?? 0) + (propertyDeleteRequests?.items.length ?? 0),
      group: "system",
    },
  ]);

  // Свёрнутая рейка показывает только группы, у которых есть хотя бы один пункт
  // для этой роли (тот же приём, что был у v1 — `sections.filter(items.length>0)`).
  /**
   * ПЛОСКОЕ МЕНЮ ИЗ ДЕВЯТИ СТРОК (вариант «плоские восемь», решение владельца
   * 15.09.2026, вторая волна).
   *
   * Группа перестала быть складкой и стала ОДНОЙ строкой, ведущей в свой
   * раздел; соседи по смыслу живут вкладками на самом экране
   * (components/SectionTabs.tsx и полосы на экранах). Причина: складка — это
   * ещё одно решение, которое человек обязан принять ДО того, как доберётся до
   * данных, и новичок на нём и застревал.
   *
   * Значок строки — СУММА значков внутри группы: непрочитанное не имеет права
   * спрятаться за тем, что мы свернули. Справочные счётчики (`badgeQuiet`,
   * например кандидаты в «Вакансиях» — их шестьдесят и они не горят) в сумму
   * не входят, иначе «Команда» светилась бы красным всегда.
   *
   * Вход в группу — ПЕРВЫЙ ДОСТУПНЫЙ пункт, а не жёстко заданный маршрут:
   * массивы уже отфильтрованы правами, поэтому у роли без «Финансов» строка
   * «Деньги» ведёт в «Отчёты», а у роли без обоих — не рисуется вовсе.
   */
  function entry(items: NavItem[], title: string, icon: typeof LayoutGrid): NavItem | undefined {
    const first = items[0];
    if (!first) return undefined;
    const badge = items.reduce((sum, i) => sum + (i.badgeQuiet ? 0 : (i.badge ?? 0)), 0);
    return { ...first, label: title, icon, badge: badge || undefined };
  }

  const dealsItem = peopleItems.find((i) => i.to === "/deals");
  // АГЕНТ: шесть строк на виду (ревью ПК 06.10.2026, review-pc.md §1): Главная,
  // Клиенты, Объекты, Чаты, Календарь, Сделки. «Обращения» растворяются: «Чаты»
  // (сообщения) встают на виду, «Звонки» и «Команда» уходят в `more`. Права не
  // трогаем: каждый пункт уже отфильтрован `can(...)` выше, меняется только
  // видимость в основной группе. Остальные роли видят меню прежним.
  const callsItem = inboxItems.find((i) => i.to === "/calls");
  const messagesItem = inboxItems.find((i) => i.to === "/messages");
  const calendarItem = main.find((i) => i.to === "/calendar");
  const homeItem = main.find((i) => i.to === "/");
  const agentChats: NavItem | undefined = messagesItem ? { ...messagesItem, label: "Чаты" } : undefined;
  const agentRail =
    role === "AGENT"
      ? compact<NavItem>([
          homeItem,
          entry(peopleItems.filter((i) => i !== dealsItem), "Клиенты", Users),
          entry(objectsItems, "Объекты", Home),
          agentChats,
          calendarItem,
          dealsItem,
        ])
      : null;
  const agentMore =
    role === "AGENT" ? compact<NavItem>([callsItem, entry(teamItems, "Команда", UsersRound)]) : [];

  const flatMain = compact<NavItem>([
    ...main,
    entry(inboxItems, "Обращения", Inbox),
    entry(peopleItems.filter((i) => i !== dealsItem), "Клиенты", Users),
    // «Сделки» — отдельной строкой, а не вкладкой «Клиентов» (23.09.2026).
    // С 21.09 у «Клиентов» остались ровно две вкладки, Продавцы и Покупатели
    // (решение владельца), и «Сделки» не открывались ни из меню, ни из вкладок:
    // агенты жаловались, что не могут найти сделку. Сделка — своё место работы
    // (доска стадий, документы, закрытие), а не срез списка людей.
    dealsItem,
    entry(objectsItems, "Объекты", Home),
    entry(teamItems, "Команда", UsersRound),
    entry(moneyItems, "Деньги", Wallet),
    // У монтажёра этот пункт открывает «Монтаж» (/marketing под его подписью):
    // подпись «Маркетинг» над экраном «Монтаж» путала — называем по экрану.
    entry(adsItems, isEditorLabel ? "Монтаж" : "Маркетинг", isEditorLabel ? Clapperboard : Megaphone),
    entry(systemItems, "Настройки", Settings),
  ]);

  const sections: NavGroup[] = (
    [
      { key: "inbox", title: "Обращения", icon: Inbox, items: inboxItems },
      { key: "people", title: "Клиенты и сделки", icon: Users, items: peopleItems },
      { key: "objects", title: "Объекты", icon: Home, items: objectsItems },
      { key: "team", title: "Команда", icon: UsersRound, items: teamItems },
      { key: "money", title: "Деньги", icon: Wallet, items: moneyItems },
      { key: "ads", title: "Реклама и публикации", icon: Megaphone, items: adsItems },
      // Пункты «Настройки CRM», «Здоровье», «Обучение бота»… рисуются хвостом меню
      // (поле `system` ниже) — отдельной складкой «Настройки» они шли ВТОРОЙ РАЗ
      // (кадр владельца 11.09: одно и то же дважды на экране).
    ] as NavGroup[]
  ).filter((s) => s.items.length > 0);

  // Нижний таб-бар телефона не меняется слоем 3 (layer-3-plan.md §1.4 риск 2) —
  // та же механика nav2/chats/more, что и в v1, но собирается из новых групп.
  const byPath = (path: string) => main.find((i) => i.to === path) ?? objectsItems.find((i) => i.to === path);
  const isPipelineRole = role === "MARKETING" || role === "EDITOR";

  const nav2: NavItem | undefined =
    role === "SECURITY" && can("clients.securityReview")
      ? { to: "/security", icon: ShieldAlert, label: "Проверки", group: "team" }
      : role === "MANAGER"
        ? { to: "/calls", icon: PhoneCall, label: "Звонки", group: "inbox" }
        : isPipelineRole
          ? byPath("/properties")
          : peopleItems.find((i) => i.to === "/clients");

  const canSeeChats = can("messages.view") || can("messages.viewOwn");
  const chats: NavItem | undefined = canSeeChats
    ? { to: "/messages", icon: MessageSquare, label: "Чаты", badge: counters?.messages ?? 0, group: "inbox" }
    : undefined;

  // Таббар (06.10.2026, ревью телефона): Главная · Клиенты · «+» · Объекты · Чаты.
  // «Ещё» с вкладки ушло в шторку по нажатию на аватар в шапке (components/MoreSheet.tsx):
  // те же права и тот же реестр, а путь `/more` остался для «Все разделы».
  // Роли без клиентов (маркетинг, монтаж) уже получают «Объекты» вторым пунктом слева,
  // поэтому справа у них место «Объектов» занимает «Календарь»; повтор пункта отсекается.
  const objects = byPath("/properties");
  const third = nav2?.to === "/properties" ? byPath("/calendar") : objects;
  const bottom = {
    left: compact<NavItem>([byPath("/"), nav2]),
    right: role === "AGENT"
      ? compact<NavItem>([chats ?? byPath("/calendar"), { to: "/more", icon: Grip, label: "Ещё", group: "system" }])
      : compact<NavItem>([third, chats]).filter((item, i, all) => all.findIndex((x) => x.to === item.to) === i),
  };

  return {
    // Рейка рисует ТОЛЬКО этот список — девять строк (см. `flatMain` выше);
    // у агента шесть, остальное в `more`.
    main: agentRail ?? flatMain,
    more: agentMore,
    // Складок больше нет. Поле осталось в типе, потому что мобильное «Ещё»
    // (pages/More.tsx) перебирает его; пустой массив означает «групп нет», и
    // «Ещё» показывает ровно те же девять строк, без второго слоя.
    sections: [],
    // Профиль (ProfileMenu) больше не берёт «Настройки CRM» отсюда — он знает
    // свою единственную ссылку сам. Пустой список здесь убирает последний
    // источник, из-за которого системные разделы показывались дважды.
    system: [],
    all: [...main, ...inboxItems, ...peopleItems, ...objectsItems, ...teamItems, ...moneyItems, ...adsItems, ...systemItems],
    bottom,
  };
}

/** Списки собираются выражениями `условие && пункт` — здесь отсеиваем несработавшие. */
function compact<T>(items: (T | false | undefined | null)[]): T[] {
  return items.filter(Boolean) as T[];
}

/**
 * ПЕРЕНЕСЁН ЛИ МАРШРУТ НА ТЕМУ «ROYAL HOME 2026» (06.10.2026, заменила регулярку
 * в `layouts/AppLayout.tsx`).
 *
 * Подсказки, которые монтирует рамка приложения над содержимым любого раздела
 * (вопрос собственнику), рисуются в облике прототипа только на уже перенесённых
 * страницах: CSS темы ограничен областью `.rh2`, и на ещё не перенесённых экранах
 * та же подсказка осталась бы без стилей. Добавляете экран на тему — добавляйте
 * его корневой путь сюда. Реестр разделов (`buildNavigation`) права и состав
 * меню не меняет: это только признак облика, поэтому он живёт отдельным списком
 * рядом, а не флагом у пункта (часть путей реестру не принадлежит).
 */
const RH2_ROUTE_ROOTS = ["/clients", "/sellers", "/lost-clients", "/other-inquiries"] as const;

export function isRh2Route(pathname: string): boolean {
  return RH2_ROUTE_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

// Экспорт для юнит-тестов (__tests__/navigation.test.ts) — билдеры принимают
// чистые данные, без похода в React-дерево/хуки.
export { buildNavigation };
