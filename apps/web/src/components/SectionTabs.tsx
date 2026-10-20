import { ScreenTabs, type ScreenTab } from "./ScreenTabs";
import { useAuthStore } from "../store/auth";
import { useCan } from "../lib/permissions";
import { useCounters } from "../hooks/useCounters";
import { useOversightSummary } from "../hooks/useOversight";
import { useSiteNotifications } from "../hooks/useSiteNotifications";

/**
 * Полосы вкладок разделов — ОДИН источник на все экраны группы.
 *
 * ЗАЧЕМ. Вторая волна сокращения меню (21 строка → 9, решение владельца
 * 15.09.2026) требует, чтобы на всех экранах одной группы стояла ОДНА И ТА ЖЕ
 * полоса: человек, попавший на «Источники лидов», должен видеть, что рядом
 * «Финансы» и «Отчёты». Иначе из подраздела нет пути никуда, кроме как назад в
 * меню, которого мы его как раз и лишили.
 *
 * Состав живёт здесь, а не массивом в каждом файле: пять экранов одной группы
 * с пятью копиями массива разъедутся так же, как разъехались вкладки
 * «Клиентов» со всем остальным приложением.
 *
 * КОМПОНЕНТЫ, А НЕ ХУКИ. Полосе нужны права, роль и общие настройки, то есть
 * хуки. Если отдавать состав хуком (`tabs={useMoneyTabs()}`), любой экран, где
 * полоса рисуется под условием, нарушит правило хуков — а оно в этом
 * репозитории ошибка сборки, не замечание. Компонент вызывает свои хуки внутри
 * себя, поэтому его можно ставить где угодно, в том числе в ветке рендера.
 *
 * Условия видимости повторяют реестр меню (`lib/navigation.ts`) слово в слово.
 * Где право не одно, а «или» — поле `when`.
 */

/**
 * Полоса «Обращения» — Сообщения, Комментарии, Звонки, Телефония (решение
 * владельца 15.09.2026, вторая волна меню, `docs/archive/menu-wave2-brief-15-09.md`).
 * Один и тот же набор стоит на всех четырёх экранах (`pages/Messages.tsx`,
 * `pages/Comments.tsx`, `pages/Calls.tsx`, `pages/Telephony.tsx`, и на их живых
 * мобильных двойниках `MobileChatsList`/`MobileCallsSupervisor`/
 * `MobileCallsAgent`) — общая функция, а не четыре копии массива, ровно затем,
 * чтобы попавший на «Звонки» видел, что рядом есть «Комментарии» (§4 договора).
 *
 * «Звонки» меняют и подпись, и право в зависимости от роли — так же, как это
 * было устроено на самом экране «Звонки» до переноса в общую полосу: у кого
 * есть `calls.transcripts`, видит «Звонки» (разговоры всей команды), у кого
 * только `calls.ownTranscripts` — «Мои звонки» (сервер сам сузит список до
 * своих). «Телефония» права не меняет: это администраторский дашборд станции,
 * `ownTranscripts` туда не пускает.
 */
export function InboxTabs() {
  const can = useCan();
  const { data: counters } = useCounters();
  const canAllCalls = can("calls.transcripts");
  return (
    <ScreenTabs
      tabs={[
        {
          to: "/messages",
          label: "Сообщения",
          end: true,
          permission: can("messages.view") ? "messages.view" : "messages.viewOwn",
          count: counters?.messages,
        },
        { to: "/comments", label: "Комментарии", permission: "messages.view", count: counters?.comments },
        {
          to: "/calls",
          label: canAllCalls ? "Звонки" : "Мои звонки",
          permission: canAllCalls ? "calls.transcripts" : "calls.ownTranscripts",
        },
        { to: "/telephony", label: "Телефония", permission: "calls.transcripts" },
      ]}
    />
  );
}

/**
 * Команда. «Активность» меняет подпись по праву `clients.viewAll`: руководитель
 * смотрит активность команды, агент — свою (то же правило, что в реестре меню).
 * Счётчик «Вакансий» справочный — это кандидаты, они не горят.
 */
export function TeamTabs() {
  const can = useCan();
  const { data: counters } = useCounters();
  const { data: oversight } = useOversightSummary(can("dashboard.analytics"));
  return (
    <ScreenTabs
      tabs={[
        { to: "/team", label: "Команда", end: true },
        { to: "/activity", label: can("clients.viewAll") ? "Активность команды" : "Моя активность" },
        { to: "/vacancies", label: "Вакансии", count: counters?.vacancies, permission: "vacancies.view" },
        {
          to: "/oversight",
          label: "Контроль руководителя",
          count: oversight?.overdueTasks,
          permission: "dashboard.analytics",
        },
        { to: "/security", label: "Служба безопасности", permission: "clients.securityReview" },
      ]}
    />
  );
}

/** Объекты: один список в двух видах плюс очередь изменений с сайта. */
export function ObjectsTabs() {
  const can = useCan();
  const { data: siteNotifications } = useSiteNotifications({ enabled: can("siteChanges.view") });
  return (
    <ScreenTabs
      tabs={[
        { to: "/properties", label: "Список", end: true },
        { to: "/properties/map", label: "Карта" },
        {
          to: "/site-changes",
          label: "Изменения на сайте",
          count: siteNotifications?.total,
          permission: "siteChanges.view",
        },
      ]}
    />
  );
}

/** Деньги: «Финансы» и всё, что на них смотрит. */
const MONEY_TABS: ScreenTab[] = [
  { to: "/finance", label: "Финансы", permission: "finance.view", end: true },
  { to: "/reports", label: "Отчёты", permission: "reports.view" },
  { to: "/sources", label: "Источники лидов", permission: "reports.view" },
  { to: "/insights", label: "Инсайты от ИИ", permission: "insights.view" },
];

export function MoneyTabs({ right }: { right?: React.ReactNode } = {}) {
  return <ScreenTabs tabs={MONEY_TABS} right={right} />;
}

/**
 * Реклама и публикации. Видимость решает ПРАВО, подпись — РОЛЬ: у монтажёра тот
 * же экран называется «Монтаж» (layer-3-plan.md §2.2, isEditorLabel в реестре).
 *
 * «Воронка» (/funnel) остаётся ещё и отдельным пунктом меню — решение владельца
 * 16.08.2026: во время рекламы туда смотрят каждый час, и путь через Настройки
 * превращал взгляд на цифры в ритуал. Здесь она вкладкой дополнительно.
 */
export function MarketingTabs() {
  const can = useCan();
  const role = useAuthStore((s) => s.agent?.role);
  const marketingVisible = can("properties.moderate") || can("properties.aiListing");
  return (
    <ScreenTabs
      tabs={[
        { to: "/ads", label: "Реклама", when: can("finance.view") || role === "MARKETING", end: true },
        // «Обзор», не «Маркетинг» (25.09.2026, владелец про весь ряд вкладок:
        // «вкладка "Маркетинг" внутри раздела "Маркетинг" сама по себе
        // кривая») — вкладка ведёт на MarketingCenter.tsx, общий обзор канала,
        // не второе имя раздела.
        { to: "/marketing", label: role === "EDITOR" ? "Монтаж" : "Обзор", when: marketingVisible },
        // Тот же круг ролей, что у реестра меню и сервера: монтажёру вкладка не нужна.
        {
          to: "/social-videos",
          label: "Ролики в соцсети",
          when: role === "MARKETING" || role === "DIRECTOR" || role === "ADMIN",
        },
        { to: "/pipeline", label: "Подготовка объектов", when: marketingVisible },
        { to: "/funnel", label: "Воронка", permission: "settings.view" },
      ]}
    />
  );
}

/**
 * Настройки и служебное. «Тренировка» больше не отдельная вкладка-экран
 * (слияние 15.09.2026) — она живёт вкладкой «Манера» ВНУТРИ «Обучения бота»
 * (pages/AiLearning.tsx, query-параметр ?tab=), поэтому здесь у неё больше
 * нет отдельной строки.
 */
export function SettingsTabs() {
  return (
    <ScreenTabs
      tabs={[
        { to: "/settings", label: "Настройки CRM", permission: "settings.view", end: true },
        { to: "/health", label: "Здоровье", permission: "auditLog.view" },
        { to: "/integrations", label: "Интеграции", permission: "auditLog.view" },
        { to: "/backups", label: "Резервные копии", permission: "auditLog.view" },
        // «Что не доехало» (владелец 21.09.2026) — задания фоновой очереди,
        // исчерпавшие попытки или зависшие, см. pages/StuckWork.tsx.
        { to: "/stuck-work", label: "Что не доехало", permission: "auditLog.view" },
        { to: "/ai-learning", label: "Обучение бота", permission: "settings.view" },
        { to: "/archive", label: "Архив", permission: "archive.view" },
      ]}
    />
  );
}
