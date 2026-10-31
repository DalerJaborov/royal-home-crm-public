import { prisma } from "../db.js";
import { assignmentWriteDenied } from "./assignmentCompletion.js";
import { clientWriteDenied } from "./clientWriteAccess.js";

/**
 * ПРАВА НА ДЕЙСТВИЕ С ПОКАЗОМ/ЗАДАЧЕЙ — ОДНО ПРАВИЛО НА REST И НА ИИ-ПОМОЩНИКА
 * (31.10.2026, волна П3, docs/design/internal-assistant-architecture-2026-10-31.md §2.2).
 *
 * Правило жило внутри `routes/interactions.ts` как функция от Express-запроса
 * (`foreignTaskWriteDenied`, `authorizeShowingAction`) — помощнику, у которого
 * запроса нет, пришлось бы писать свою копию, и копии рано или поздно разойдутся.
 * Теперь правило — чистая функция от «кто действует», REST отдаёт ей поля из
 * `req.agent`, помощник — из `AssistantActor`. Поведение REST не менялось.
 */
export interface TaskWriteSubject {
  id: string;
  role: string;
  /** clients.assign — писать в чужую карточку (см. lib/clientWriteAccess.ts). */
  canAssignClients: boolean;
  /** Роль допущена к служебным расследованиям И выдано clients.securityReview (auth/investigations.ts). */
  canReadInvestigations: boolean;
}

export interface TaskWriteTarget {
  clientId: string | null;
  agentId: string | null;
  subjectAgentId: string | null;
  investigationOnly?: boolean;
  taskCancelledAt?: Date | null;
}

/**
 * «Видеть — но не менять» (clients.viewAll без clients.assign, служба безопасности) и для
 * задач и показов по чужой карточке — то же правило, что у правки самой карточки
 * (foreignWriteDenied). Своя задача сотрудника — его. Аудит 23.09.2026, №29.
 * Возвращает текст отказа или null.
 */
export async function foreignTaskWriteDeniedFor(
  subject: TaskWriteSubject,
  interaction: TaskWriteTarget,
  ownAgentId: string | undefined,
): Promise<string | null> {
  if (interaction.investigationOnly && !subject.canReadInvestigations) return "Недостаточно прав";
  if (interaction.taskCancelledAt) return "Задача отменена";
  const current = interaction.clientId
    ? await prisma.client.findUnique({ where: { id: interaction.clientId }, select: { assignmentCompletedAt: true } })
    : null;
  const completed = current && assignmentWriteDenied(current, subject.role);
  if (completed) return completed;
  if (ownAgentId) return null;
  if ((interaction.subjectAgentId ?? interaction.agentId) === subject.id) return null;
  if (!interaction.clientId) return null;
  const client = await prisma.client.findUnique({
    where: { id: interaction.clientId },
    select: { assignedAgentId: true, assignmentCompletedAt: true },
  });
  return client ? clientWriteDenied(subject, client, ownAgentId) : null;
}

export type ShowingAccessResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Можно ли этому сотруднику отменить/перенести показ: свой показ правит сам, чужой —
 * только руководство. Тело `authorizeShowingAction` (routes/interactions.ts) без
 * сборки «кем подписать» — это остаётся за вызывающим.
 */
export async function showingActionAccess(
  subject: TaskWriteSubject,
  interactionId: string,
  ownAgentId: string | undefined,
): Promise<ShowingAccessResult> {
  const interaction = await prisma.interaction.findUnique({
    where: { id: interactionId },
    select: { agentId: true, subjectAgentId: true, clientId: true, investigationOnly: true },
  });
  if (!interaction) return { ok: false, status: 404, error: "Запись не найдена" };
  // Показ, назначенный ботом или системой, хранит агента в subjectAgentId, а
  // agentId пуст (П-10) — проверка только по agentId не пускала своего же
  // агента (аудит 23.09.2026, №29).
  if (ownAgentId && (interaction.subjectAgentId ?? interaction.agentId) !== ownAgentId) {
    return { ok: false, status: 403, error: "Недостаточно прав" };
  }
  const denied = await foreignTaskWriteDeniedFor(subject, interaction, ownAgentId);
  if (denied) return { ok: false, status: 403, error: denied };
  return { ok: true };
}
