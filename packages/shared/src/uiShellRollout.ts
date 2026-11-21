import { z } from "zod";
import { ROLES, type Role } from "./enums.js";

const employeeIdSchema = z.string().trim().min(1).max(128);

/** UI availability only: this configuration never grants business permissions. */
export const uiShellRolloutSchema = z.object({
  enabled: z.boolean(),
  agentIds: z.array(employeeIdSchema).max(1000),
  roles: z.array(z.enum(ROLES)).max(ROLES.length),
  /**
   * «Новый вид» (облик `royal`) — только поверх включённой чистой оболочки и
   * только перечисленным сотрудникам. Поле необязательное: прежние сохранённые
   * настройки и прежние клиенты, которые его не присылают, его не стирают
   * (PUT без поля сохраняет текущий список, см. routes/uiShell.ts).
   */
  royalLookAgentIds: z.array(employeeIdSchema).max(1000).optional(),
}).strict();

export type UiShellRollout = z.infer<typeof uiShellRolloutSchema>;
/** Opaque revision for optimistic concurrency; not a permission or feature flag. */
export const uiShellRolloutConfigSchema = uiShellRolloutSchema.extend({ version: z.string().min(1).max(100) });
export type UiShellRolloutConfig = z.infer<typeof uiShellRolloutConfigSchema>;
/** Internal persisted envelope. Existing plain configurations remain readable. */
export const storedUiShellRolloutSchema = z.object({ revision: z.uuid(), config: uiShellRolloutSchema }).strict();

/** Облики поверх чистой оболочки. Сейчас один — «Новый вид». */
export const UI_LOOKS = ["royal"] as const;
export type UiLook = (typeof UI_LOOKS)[number];

/** Ответ GET /ui-shell. `look` присутствует только у тех, кому он включён. */
export const uiShellEffectiveSchema = z.object({ enabled: z.boolean(), look: z.enum(UI_LOOKS).optional() }).strict();
export type UiShellEffective = z.infer<typeof uiShellEffectiveSchema>;

export function parseUiShellRollout(value: unknown): UiShellRollout {
  const envelope = storedUiShellRolloutSchema.safeParse(value);
  const parsed = uiShellRolloutSchema.safeParse(envelope.success ? envelope.data.config : value);
  return parsed.success ? parsed.data : { enabled: false, agentIds: [], roles: [] };
}

export function isUiShellEnabled(value: unknown, agent: { id: string; role: Role }): boolean {
  const config = parseUiShellRollout(value);
  return config.enabled && (config.agentIds.includes(agent.id) || config.roles.includes(agent.role));
}

/**
 * Облик для сотрудника: «Новый вид» — только тому, у кого включена чистая
 * оболочка И кто лично в списке `royalLookAgentIds`. По ролям не включается
 * намеренно: пока перенесены не все экраны, вид получают поимённо. Закрыто по
 * умолчанию: пустой, повреждённый или выключенный рубильник даёт `undefined`.
 */
export function uiLookFor(value: unknown, agent: { id: string; role: Role }): UiLook | undefined {
  if (!isUiShellEnabled(value, agent)) return undefined;
  return (parseUiShellRollout(value).royalLookAgentIds ?? []).includes(agent.id) ? "royal" : undefined;
}

/**
 * ОДНА ТОЧКА РЕШЕНИЯ (владелец 21.11.2026: «Удали это и включи просто новый
 * интерфейс для всех и всё»). Новый интерфейс и «Новый вид» включены ВСЕМ
 * сотрудникам и всем ролям, на компьютере и на телефоне, агентам тоже. Списков
 * и настроек больше нет: сервер отвечает этим на GET /ui-shell (для вкладок,
 * открытых до выката), а клиент берёт это же значение без запроса
 * (apps/web/src/hooks/useCleanShell.ts). Поле `uiShellRollout` в базе больше
 * не читается и не пишется. Личный аварийный выход — только адрес `?look=legacy`.
 */
export const UI_SHELL_FOR_EVERYONE = { enabled: true, look: "royal" } as const satisfies UiShellEffective;
