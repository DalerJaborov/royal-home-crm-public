import { z } from "zod";
import { prisma, type TxClient } from "../../../db.js";
import { AssistantActionError, type AssistantActionActor, type AssistantActionExecutor } from "../../../lib/assistantActions.js";
import { canonicalJson } from "../../../lib/canonicalJson.js";
import { clientNamePhoneSafe, phoneSafeText } from "../../../lib/clientPhone.js";
import { foreignTaskWriteDeniedFor } from "../../../lib/showingAccess.js";
import { afterInteractionTaskCompleted, completeInteractionTask } from "../../../lib/taskCompletion.js";
import { plainField } from "./safeField.js";
import { asPluginExecutor, loadToolActor, showingTimeText, taskWriteSubjectOf } from "./showingToolSupport.js";
import { privateWriteAllowed } from "./privateWriteAllowed.js";
import type { AssistantWriteToolPlugin } from "./types.js";

const argsSchema = z.object({ interactionId: z.string().trim().uuid() }).strict();
type Args = z.infer<typeof argsSchema>;

async function loadTask(
  args: Args, actionActor: AssistantActionActor, { tx, allowClosed = false }: { tx?: TxClient; allowClosed?: boolean } = {},
) {
  if (tx) {
    // A role change, task edit or reassignment cannot slip between the permission check and closure.
    await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${actionActor.agentId} FOR SHARE`;
    await tx.$queryRaw`
      SELECT i."id" FROM "Interaction" AS i JOIN "Client" AS c ON c."id" = i."clientId"
      WHERE i."id" = ${args.interactionId} FOR UPDATE OF i FOR SHARE OF c
    `;
  }
  const db = tx ?? prisma;
  const { actor } = await loadToolActor(actionActor, db);
  const ownAgentId = actor.canViewAllClients ? undefined : actor.id;
  const task = await db.interaction.findUnique({
    where: { id: args.interactionId },
    include: {
      client: { select: {
        shortId: true, fullName: true, deletedAt: true, assignedAgentId: true, acceptedAt: true, assignmentCompletedAt: true,
      } },
      agent: { select: { fullName: true } },
      subjectAgent: { select: { fullName: true } },
    },
  });
  if (!task || task.client.deletedAt || !task.nextAction || task.type === "SHOWING" || task.type === "MEETING") {
    throw new AssistantActionError(404, "TASK_NOT_FOUND", "Не нашла эту задачу. Уточните, какую закрыть.");
  }
  if (ownAgentId && (task.subjectAgentId ?? task.agentId) !== ownAgentId) {
    throw new AssistantActionError(403, "FORBIDDEN", "Недостаточно прав на эту задачу.");
  }
  if (ownAgentId && (task.client.assignedAgentId !== ownAgentId || !task.client.acceptedAt)) {
    throw new AssistantActionError(403, "FORBIDDEN", "Недостаточно прав на эту задачу.");
  }
  const denied = await foreignTaskWriteDeniedFor(taskWriteSubjectOf(actor), task, ownAgentId, db);
  if (denied) throw new AssistantActionError(403, "FORBIDDEN", denied);
  if (!allowClosed && (task.completedAt || task.declinedAt)) {
    throw new AssistantActionError(409, "TASK_ALREADY_CLOSED", "Эта задача уже закрыта.");
  }
  return { actor, task };
}

function taskVersion(task: Awaited<ReturnType<typeof loadTask>>["task"]) {
  return {
    type: task.type,
    clientId: task.clientId,
    agentId: task.agentId,
    subjectAgentId: task.subjectAgentId,
    nextAction: task.nextAction,
    nextActionDate: task.nextActionDate,
    investigationOnly: task.investigationOnly,
    declinedAt: null,
    client: {
      deletedAt: null,
      assignedAgentId: task.client.assignedAgentId,
      assignmentCompletedAt: task.client.assignmentCompletedAt,
      acceptedAt: task.client.acceptedAt,
    },
  };
}

const stale = () => new AssistantActionError(409, "STALE", "Задача изменилась. Проверьте её ещё раз.");

const executor: AssistantActionExecutor<Args> = {
  tool: "complete_task",
  channels: ["crm", "telegram"],
  privateTelegram: true,
  transactional: true,
  parseArgs(raw) {
    const parsed = argsSchema.safeParse(raw);
    if (!parsed.success) throw new AssistantActionError(400, "BAD_ARGS", "Какую задачу закрыть?");
    return parsed.data;
  },
  async authorize(args, actionActor) {
    await loadTask(args, actionActor, { allowClosed: true });
  },
  async snapshot(args, actionActor, tx) {
    const { task } = await loadTask(args, actionActor, { tx });
    return taskVersion(task);
  },
  async buildPreview(args, snapshot, actionActor) {
    const { actor, task } = await loadTask(args, actionActor);
    if (canonicalJson(taskVersion(task)) !== canonicalJson(snapshot)) throw stale();
    const assignee = (task.subjectAgentId ?? task.agentId) !== actor.id
      ? (task.subjectAgent ?? task.agent)?.fullName : null;
    return {
      title: "Завершить задачу",
      was: {
        Задача: plainField(phoneSafeText(task.nextAction, actor.canViewPhone)),
        Клиент: plainField(clientNamePhoneSafe(task.client.fullName, actor.canViewPhone)),
        ...(assignee ? { Сотрудник: plainField(assignee) } : {}),
        ...(task.nextActionDate ? { Срок: showingTimeText(task.nextActionDate) } : {}),
      },
      becomes: { Статус: "Выполнено" },
    };
  },
  async execute(args, actionActor, { snapshotBefore, tx }) {
    if (!tx) throw new Error("complete_task requires the confirmation transaction");
    const { task } = await loadTask(args, actionActor, { tx });
    const expected = taskVersion(task);
    // Compare again after the broker's check, then use that version in the conditional write.
    if (canonicalJson(expected) !== canonicalJson(snapshotBefore)) {
      throw stale();
    }
    const { changed, row } = await completeInteractionTask(task, expected, tx);
    if (!changed) throw stale();
    return {
      result: { interactionId: row.id, completedAt: row.completedAt?.toISOString(), href: `/clients/${task.client.shortId}` },
      audit: { entityType: "Interaction", entityId: row.id },
      afterCommit: () => afterInteractionTaskCompleted(task),
    };
  },
};

export const completeTaskTool: AssistantWriteToolPlugin = {
  name: "complete_task",
  level: "C",
  allowed: privateWriteAllowed,
  statusPhrase: "Готовлю закрытие задачи…",
  description:
    "Отметить конкретную задачу выполненной по прямой просьбе сотрудника. Используй только interactionId из ответа " +
    "find_open_tasks или list_my_tasks для ровно той задачи, которую попросили закрыть. Если совпадений несколько " +
    "или нужная задача не ясна, задай один короткий вопрос с отличиями (срок, клиент, сотрудник или название). " +
    "Не выбирай первую, последнюю или случайную задачу. Для встреч, показов и отмены не используй. Ждёт подтверждения сотрудника.",
  parameters: {
    type: "object",
    properties: { interactionId: { type: "string", description: "Точный id задачи, выбранной сотрудником" } },
    required: ["interactionId"],
  },
  executor: asPluginExecutor(executor),
};
