import { isAssistantStaffTotpOn, ASSISTANT_STAFF_TOTP_KEY } from "@royal-home/shared";
import { prisma } from "../db.js";

/** Что двери нужно от актора брокера (lib/assistantActions.ts); своим типом — без круга импортов. */
export interface StaffWaiverActor {
  agentId: string;
  channel: "crm" | "telegram";
  telegramPrivate?: boolean;
  telegramChatId?: string;
}

/**
 * ОДНА ДВЕРЬ: «НУЖЕН ЛИ ДИРЕКТОРУ КОД GOOGLE AUTHENTICATOR НА ЭТО ДЕЙСТВИЕ С СОТРУДНИКОМ В TELEGRAM»
 * (владелец 23.11.2026: «сделай так, чтобы шабнам добавляла и удаляла сотрудников из Телеграма
 * директора без всяких разрешений, а то эти Google аутентификаторы и так далее, мне это не нужно»).
 *
 * Спрашивают ТОЛЬКО брокер (lib/assistantActions.ts: assertStepUp, assertStepUpPossible) и кнопка
 * карточки в Telegram (telegram/assistantStepUp.ts: bundleNeedsStepUp) — одна функция, чтобы
 * кнопка и исполнение никогда не расходились. CRM (окно подтверждения личности lib/stepUp.ts)
 * здесь не участвует вовсе: для канала crm ответ всегда «код нужен».
 *
 * Код НЕ нужен только когда сходится всё (каждое условие — тест в tests/assistant-staff-rights.test.ts):
 *  - рубильник `assistantStaffTotpEnabled` ВЫКЛЮЧЕН (по умолчанию так, решение владельца);
 *  - канал telegram, ЛИЧКА (`telegramPrivate` и `telegramChatId` из апдейта Telegram, не из текста);
 *  - нажавший — активный ДИРЕКТОР, и этот чат — его привязанный кодом `telegramChatId`;
 *  - действие из короткого списка, и оно не про учётку директора:
 *      create_staff — кроме роли «Директор»;
 *      update_staff — меняется ТОЛЬКО isActive и/или role (отключить, включить, сменить роль), не на директора;
 *      set_staff_permissions — добавить/снять права.
 * Всё остальное со step-up (удалить навсегда, заморозить, передать дела, сбросить 2FA, рубильники
 * Настроек, учётки директоров) — по-прежнему с кодом. Карточка и кнопка «Подтвердить» остаются
 * всегда: ошибка модели не создаёт людей молча. Сообщение руководству уходит из lib/staffAdmin.ts
 * как обычно, журнал брокера помечает такое исполнение `stepUpWaived: true`.
 *
 * Без кэша: рубильник обязан действовать со следующего нажатия.
 */

export const STAFF_STEP_UP_WAIVABLE_TOOLS = ["create_staff", "update_staff", "set_staff_permissions"] as const;

/** Поля update_staff, которые директор меняет без кода: отключить/включить учётку и роль. */
const WAIVABLE_UPDATE_FIELDS: ReadonlySet<string> = new Set(["isActive", "role"]);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Чистая часть: подходит ли само действие (без базы). */
export function isWaivableStaffAction(tool: string, args: unknown): boolean {
  const a = asRecord(args);
  if (!a) return false;
  if (tool === "create_staff") return typeof a.role === "string" && a.role !== "DIRECTOR";
  if (tool === "set_staff_permissions") return typeof a.agentId === "string";
  if (tool === "update_staff") {
    const changes = asRecord(a.changes);
    if (typeof a.agentId !== "string" || !changes) return false;
    const keys = Object.keys(changes);
    return keys.length > 0 && keys.every((key) => WAIVABLE_UPDATE_FIELDS.has(key)) && changes.role !== "DIRECTOR";
  }
  return false;
}

/** Рубильник компании: true — код нужен (как до 23.11). Нет строки настроек — выключен. */
export async function assistantStaffTotpRequired(): Promise<boolean> {
  const row = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { [ASSISTANT_STAFF_TOTP_KEY]: true } });
  return isAssistantStaffTotpOn(row as Partial<Record<typeof ASSISTANT_STAFF_TOTP_KEY, boolean>> | null);
}

/**
 * Нажавший вообще может работать без кода: рубильник выключен, личка, активный директор в своём
 * привязанном чате. Без учёта самого действия — для подсказки «без кода могу вот это».
 */
export async function staffStepUpWaiverEligible(actor: StaffWaiverActor): Promise<boolean> {
  if (actor.channel !== "telegram" || actor.telegramPrivate !== true) return false;
  const chatId = typeof actor.telegramChatId === "string" ? actor.telegramChatId.trim() : "";
  if (!chatId) return false;
  if (await assistantStaffTotpRequired()) return false;
  const me = await prisma.agent.findUnique({ where: { id: actor.agentId }, select: { role: true, isActive: true, telegramChatId: true } });
  return Boolean(me?.isActive && me.role === "DIRECTOR" && me.telegramChatId && me.telegramChatId === chatId);
}

/** Главный вопрос: это действие этому нажавшему можно исполнить без кода. */
export async function staffStepUpWaived(actor: StaffWaiverActor, tool: string, args: unknown): Promise<boolean> {
  if (!isWaivableStaffAction(tool, args)) return false;
  if (!(await staffStepUpWaiverEligible(actor))) return false;
  const targetId = asRecord(args)?.agentId;
  if (typeof targetId === "string") {
    // Учётка директора (понизить, отключить, права) — только с кодом или в CRM.
    const target = await prisma.agent.findUnique({ where: { id: targetId }, select: { role: true } });
    if (target?.role === "DIRECTOR") return false;
  }
  return true;
}

/** Подсказка модели к отказу TOTP_REQUIRED, когда часть действий директору доступна без кода. */
export const STAFF_WAIVER_HINT =
  "Без кода в Telegram могу: добавить сотрудника, отключить или включить его учётку, сменить роль или права. " +
  "Это действие — только с кодом Google Authenticator или в CRM.";
