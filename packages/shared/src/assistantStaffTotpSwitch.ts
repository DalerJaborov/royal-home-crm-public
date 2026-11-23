import { z } from "zod";

/**
 * РУБИЛЬНИК «КОД GOOGLE AUTHENTICATOR ДЛЯ ДЕЙСТВИЙ С СОТРУДНИКАМИ В TELEGRAM» (владелец 23.11.2026).
 *
 * Слова владельца: «сделай так, чтобы шабнам добавляла и удаляла сотрудников из Телеграма
 * директора без всяких разрешений, а то эти Google аутентификаторы и так далее, мне это не нужно».
 *
 * ПО УМОЛЧАНИЮ ВЫКЛЮЧЕН (`@default(false)` в базе). Пока выключен, ДИРЕКТОР в СВОЕЙ личке с Шабнам
 * (чат привязан к его учётке кодом) подтверждает одним нажатием «Подтвердить», без кода:
 *  - добавить сотрудника (create_staff);
 *  - отключить или включить обратно учётку (update_staff, только isActive), сменить роль;
 *  - добавить или снять права (set_staff_permissions).
 * Учётки директоров (создать директора, сменить роль на директора, тронуть учётку директора) —
 * всё равно только с кодом или в CRM. Удаление навсегда, заморозка, передача дел, сброс 2FA,
 * рубильники Настроек — тоже с кодом, как раньше. Сообщение руководству и запись в журнал — всегда.
 *
 * Включён — всё как до 23.11: каждое такое действие из Telegram только с кодом Google Authenticator.
 *
 * Сервер решает в одном месте — apps/api/src/lib/assistantStaffStepUpWaiver.ts, экран —
 * apps/web/src/pages/settings/SystemTab.tsx (Настройки → Система → Безопасность). Подписи — здесь.
 */
export const ASSISTANT_STAFF_TOTP_KEY = "assistantStaffTotpEnabled" as const;

/** Нет строки настроек — ВЫКЛЮЧЕНО: то же умолчание, что у колонки в базе. */
export const ASSISTANT_STAFF_TOTP_DEFAULT = false;

export type AssistantStaffTotpSwitch = Record<typeof ASSISTANT_STAFF_TOTP_KEY, boolean>;

/** Часть схемы PATCH /settings — встраивается через `.shape`. */
export const assistantStaffTotpSwitchUpdateSchema = z.object({
  [ASSISTANT_STAFF_TOTP_KEY]: z.boolean().optional(),
});

export function isAssistantStaffTotpOn(
  settings: Partial<Record<typeof ASSISTANT_STAFF_TOTP_KEY, boolean | null | undefined>> | null | undefined
): boolean {
  return settings?.[ASSISTANT_STAFF_TOTP_KEY] ?? ASSISTANT_STAFF_TOTP_DEFAULT;
}

export const ASSISTANT_STAFF_TOTP_LABEL = {
  title: "Код Google Authenticator для действий с сотрудниками в Telegram",
  /** Пока ВКЛЮЧЁН (подпись SwitchRow — про текущее положение). */
  on: "Добавить, отключить сотрудника или поменять ему права через Шабнам можно только с кодом из Google Authenticator.",
  /** Пока ВЫКЛЮЧЕН. */
  off: "Директор в своей личке с Шабнам добавляет, отключает сотрудников и меняет права одной кнопкой «Подтвердить», без кода. Руководству приходит сообщение, всё пишется в журнал.",
} as const;
