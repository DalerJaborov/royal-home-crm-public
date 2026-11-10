/**
 * Инструменты помощницы про сотрудников и права (10.11.2026). Отдельным списком,
 * чтобы общая группа Telegram (telegram/assistantBot.ts, GROUP_HIDDEN_TOOLS) закрыла
 * их все одной строкой: в группе — ничего про сотрудников и права, даже чтение.
 * Новый инструмент раздела «Команда» дописывается сюда; сверку держит
 * tests/assistant-staff-rights.test.ts.
 */
export const STAFF_TOOL_NAMES = [
  "list_staff",
  "get_staff_card",
  "staff_now",
  "create_staff",
  "update_staff",
  "delete_staff",
  "freeze_staff",
  "unfreeze_staff",
  "handover_staff_work",
  "revert_staff_handover",
  "reset_staff_2fa",
  "set_staff_permissions",
  "pause_staff_leads",
  "resume_staff_leads",
  "transfer_property",
] as const;

export type StaffToolName = (typeof STAFF_TOOL_NAMES)[number];
