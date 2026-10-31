import type { PermissionId } from "@royal-home/shared";
import type { AssistantActor } from "./actor.js";

/**
 * СПРАВОЧНИК РАЗДЕЛОВ В ПРОМТЕ — ИЗ ПРАВ АКТОРА, А НЕ ИЗ РОЛИ (31.10.2026, пачка
 * П2 задача 2.5, docs/design/internal-assistant-architecture-2026-10-31.md §1.2 №14).
 *
 * Раньше промт перечислял все разделы и добавлял «агенту недоступны Отчёты,
 * Финансы…». Но права в CRM поштучные (resolvePermissions), ролей девять, а
 * промт знал две: менеджер без «Финансов» или служба безопасности без «Настроек»
 * получали путь кликов в раздел, которого у них в меню нет. Теперь модель видит
 * ровно те разделы, что открыты этому человеку, — по тем же правам, по которым их
 * рисует меню (apps/web/src/lib/navigation.ts).
 */
interface SectionLine {
  text: string;
  /** Нет условия — раздел есть у всех. */
  visible?: (ctx: { has: (permission: PermissionId) => boolean; actor: AssistantActor; isSalesRole: boolean }) => boolean;
}

const SECTIONS: SectionLine[] = [
  { text: "Главная — дашборд: задачи на сегодня, воронка, свежие лиды." },
  { text: "Объекты — каталог недвижимости: добавление, фото, публикация на сайт." },
  { text: "Клиенты — база клиентов/лидов, карточка клиента с историей.", visible: ({ isSalesRole }) => isSalesRole },
  { text: "Продавцы — собственники, предлагающие объекты.", visible: ({ isSalesRole }) => isSalesRole },
  { text: "Сделки — kanban сделок по этапам.", visible: ({ isSalesRole }) => isSalesRole },
  { text: "Календарь — задачи и встречи по датам." },
  {
    text: "Сообщения — переписка из Instagram/WhatsApp/Telegram, диалоги бота.",
    visible: ({ has }) => has("messages.view") || has("messages.viewOwn"),
  },
  { text: "Отчёты — статистика и KPI.", visible: ({ actor }) => actor.canViewReports },
  { text: "Источники лидов — аналитика каналов.", visible: ({ actor }) => actor.canViewReports },
  { text: "Команда — список сотрудников и их показатели." },
  { text: "Прочие обращения — заявки не про недвижимость.", visible: ({ has }) => has("otherInquiries.view") },
  { text: "Финансы — доходы/расходы/зарплаты, бухгалтерия.", visible: ({ actor }) => actor.canViewFinance },
  { text: "Архив — архивные клиенты и объекты.", visible: ({ has }) => has("archive.view") },
  { text: "Изменения на сайте — уведомления о правках сайта.", visible: ({ has }) => has("siteChanges.view") },
  {
    text: "Настройки CRM — ключи, бот, интеграции (вход с повторным подтверждением пароля).",
    visible: ({ has }) => has("settings.view"),
  },
  { text: "Профиль (аватар справа сверху) — тема оформления, смена пароля, 2FA, автовыход, история входов." },
];

/** Строки справочника разделов для системного промта: только доступные актору. */
export function assistantSectionsGuide(actor: AssistantActor): string {
  const has = (permission: PermissionId) => actor.permissions?.has(permission) ?? false;
  // Та же развилка, что isSalesRole в меню: у маркетинга и монтажа нет клиентского блока.
  const isSalesRole = actor.role !== "MARKETING" && actor.role !== "EDITOR";
  return SECTIONS.filter((s) => !s.visible || s.visible({ has, actor, isSalesRole }))
    .map((s) => `- ${s.text}`)
    .join("\n");
}
