/**
 * ПОДКЛЮЧЕНИЕ СОТРУДНИКА К ШАБНАМ (Telegram) — одно правило на сервер и экран (25.11.2026).
 *
 * Привязанный Telegram получает код входа в CRM, поэтому выдать чужой учётке ссылку
 * подключения или снять её привязку может только директор или администратор. Сервер
 * (apps/api/src/lib/staffAdmin.ts) отказывает остальным, экран (apps/web/src/lib/staffShabnam.ts)
 * им кнопок не показывает; оба зовут эту функцию, чтобы правило не разъехалось.
 */
export function canManageStaffTelegram(role: string | null | undefined): boolean {
  return role === "DIRECTOR" || role === "ADMIN";
}
