import { z } from "zod";
import { prisma } from "../../../db.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { clientNamePhoneSafe, phoneSafeText } from "../../../lib/clientPhone.js";
import { dushanbeDateString, dushanbeDayRange, dushanbeInputToDate, dushanbeTimeString } from "../../../lib/dushanbeTime.js";
import { visibleInteractionWhere } from "../../../lib/investigationPrivacy.js";
import { TASK_WHERE } from "../../../lib/tasks.js";
import { assistantInvestigationRole } from "../actor.js";
import { privateWriteAllowed } from "./privateWriteAllowed.js";
import { safeField } from "./safeField.js";
import type { AssistantReadToolPlugin } from "./types.js";

const LIMIT = 6;
const argsSchema = z.object({
  clientId: z.string().trim().uuid().optional(),
  q: z.string().trim().min(2).max(100).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
}).strict();

export const findOpenTasksTool: AssistantReadToolPlugin = {
  name: "find_open_tasks",
  level: "A",
  allowed: privateWriteAllowed,
  statusPhrase: "Ищу открытую задачу…",
  description:
    "Найти незавершённую задачу для точного выбора перед complete_task. Передай id клиента из поиска, " +
    "слова из названия или дату по Душанбе. Вернёт кандидатов с interactionId, сроком, клиентом и сотрудником. " +
    "Если несколько похожих или hasMore, спроси, какую именно закрыть; не выбирай по порядку.",
  parameters: {
    type: "object",
    properties: {
      clientId: { type: "string", description: "Точный id клиента из поиска" },
      q: { type: "string", description: "Одно или несколько отличительных слов задачи" },
      date: { type: "string", description: "Срок задачи в формате ГГГГ-ММ-ДД по Душанбе" },
    },
  },
  async run(raw, { actor }) {
    const parsed = argsSchema.safeParse(raw);
    if (!parsed.success) return { error: "Уточните, какую задачу найти." };
    const { clientId, q, date } = parsed.data;
    if (!clientId && !q && !date) return { error: "Какая задача? Назовите клиента или напомните, что нужно было сделать." };
    const dateAt = date ? dushanbeInputToDate(date, "12:00") : null;
    if (dateAt && (Number.isNaN(dateAt.getTime()) || dushanbeDateString(dateAt) !== date)) {
      return { error: "Уточните дату задачи." };
    }
    const range = dateAt ? dushanbeDayRange(dateAt) : null;
    const ownScope = actor.canViewAllClients ? undefined : actor.id;
    const own: Prisma.InteractionWhereInput = { OR: [
      { subjectAgentId: actor.id },
      { subjectAgentId: null, agentId: actor.id },
    ] };
    // Company-wide lookups need a named client and permission to work on their tasks.
    const assignmentScope = clientId && !ownScope && actor.canAssignClients ? {} : own;
    const rows = await prisma.interaction.findMany({
      where: {
        ...TASK_WHERE,
        ...visibleInteractionWhere(assistantInvestigationRole(actor)),
        ...assignmentScope,
        type: { notIn: ["SHOWING", "MEETING"] },
        completedAt: null,
        declinedAt: null,
        ...(clientId ? { clientId } : {}),
        ...(ownScope ? { client: { deletedAt: null, assignedAgentId: ownScope, acceptedAt: { not: null } } } : {}),
        ...(range ? { nextActionDate: { gte: range.start, lt: range.end } } : {}),
        ...(q ? { AND: q.split(/\s+/u).map(word => ({ nextAction: { contains: word, mode: "insensitive" } })) } : {}),
      },
      orderBy: [{ nextActionDate: "asc" }, { id: "asc" }],
      take: LIMIT + 1,
      select: {
        id: true, nextAction: true, nextActionDate: true,
        client: { select: { fullName: true } },
        agent: { select: { fullName: true } },
        subjectAgent: { select: { fullName: true } },
      },
    });
    const items = rows.slice(0, LIMIT).map(row => ({
      interactionId: row.id,
      text: safeField(phoneSafeText(row.nextAction, actor.canViewPhone)),
      client: safeField(clientNamePhoneSafe(row.client.fullName, actor.canViewPhone)),
      assignee: safeField((row.subjectAgent ?? row.agent)?.fullName),
      date: row.nextActionDate ? dushanbeDateString(row.nextActionDate) : null,
      time: row.nextActionDate ? dushanbeTimeString(row.nextActionDate) : null,
    }));
    return { items, hasMore: rows.length > LIMIT };
  },
};
