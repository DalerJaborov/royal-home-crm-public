import type { NotificationLevel } from "@royal-home/shared";

export const PINNED_NOTIFICATION_LEVELS: readonly NotificationLevel[] = ["APPROVAL", "CRITICAL"];
export function notificationLevel(notification: { level?: string | null }): NotificationLevel {
  return notification.level === "APPROVAL" || notification.level === "CRITICAL" || notification.level === "INSIGHT" ? notification.level : "OTHER";
}
export function notificationGroupDescriptors(role?: string) {
  return role === "ADMIN" || role === "DIRECTOR" ? [
    { level: "APPROVAL", levels: ["APPROVAL"], title: "Согласования", note: "Решения, которых ждут сотрудники" },
    { level: "CRITICAL", levels: ["CRITICAL"], title: "Контроль", note: "Случаи, требующие внимания" },
    { level: "INSIGHT", levels: ["INSIGHT", "OTHER"], title: "Мои задачи и подсказки", note: "Остальные уведомления и сведения системы" },
  ] : [
    { level: "APPROVAL", levels: ["APPROVAL"], title: "Ждёт решения", note: "Пока не решите, работа других стоит" },
    { level: "CRITICAL", levels: ["CRITICAL"], title: "Критичное", note: "Теряем клиента или деньги" },
    { level: "INSIGHT", levels: ["INSIGHT"], title: "Инсайты", note: "Что подсказала система" },
    { level: "OTHER", levels: ["OTHER"], title: "Прочее", note: "К сведению" },
  ];
}

/** Presentation only: approval/critical still come from the full pinned queue.
 * Deduplicate before assigning groups so a polled notification never appears twice.
 */
export function groupNotifications<T extends { id: string; level?: string | null }>(role: string | undefined, items: T[], pinned: T[]) {
  const all = new Map<string, T>();
  for (const item of [...pinned, ...items]) if (!all.has(item.id)) all.set(item.id, item);
  return notificationGroupDescriptors(role).map(descriptor => ({ ...descriptor,
    section: [...all.values()].filter(item => descriptor.levels.includes(notificationLevel(item))),
  })).filter(group => group.section.length > 0);
}
