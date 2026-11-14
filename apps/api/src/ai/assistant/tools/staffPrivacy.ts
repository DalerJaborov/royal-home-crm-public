/**
 * ТЕЛЕФОН И ПОЧТА СОТРУДНИКА ДЛЯ ПОМОЩНИЦЫ (10.11.2026, ревью безопасности).
 *
 * Отдельного права «видеть телефоны сотрудников» в реестре нет (clients.viewPhone —
 * про клиентов). Поэтому модели номер и почта сотрудника не отдаются никогда целиком:
 * список их не содержит вовсе, карточка — только хвост (последние 2 цифры) и домен
 * почты. Полный номер виден в CRM (раздел «Команда»), а телефон — это логин входа:
 * в чате с моделью ему не место.
 */
export function maskStaffPhone(value: string | null | undefined): string {
  const digits = (value ?? "").replace(/\D/g, "");
  if (digits.length < 2) return "—";
  return `•••${digits.slice(-2)}`;
}

export function maskStaffEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = value.lastIndexOf("@");
  if (at <= 0) return "•••";
  return `${value[0]}•••${value.slice(at)}`;
}
