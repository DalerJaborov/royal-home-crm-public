import { z } from "zod";
import { showingReasonSchema } from "@royal-home/shared";
import { prisma } from "../../../db.js";
import { AssistantActionError, type AssistantActionExecutor } from "../../../lib/assistantActions.js";
import { clientNamePhoneSafe } from "../../../lib/clientPhone.js";
import { ShowingMutationError } from "../../../lib/showingMutation.js";
import { rescheduleShowingById } from "../../../lib/showingBooking.js";
import {
  asPluginExecutor,
  loadShowingForAction,
  loadToolActor,
  requireShowingInstant,
  showingByIdError,
  showingSnapshot,
  showingTimeText,
  staleShowingError,
  TIME_PARAM_DESCRIPTION,
} from "./showingToolSupport.js";
import { plainField } from "./safeField.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * reschedule_showing — перенести назначенный показ на другое время (уровень C, П3 группа show).
 *
 * Исполняет `rescheduleShowingById` (lib/showingBooking.ts) — тот же сервис, что
 * PATCH /interactions/:id/showing/reschedule: напоминания и подтверждение сбрасываются,
 * агенту уходит push, в записи остаётся «с … на …». Права — `showingActionAccess` (одна
 * функция с REST): свой показ правит сам, чужой — руководство. Запись условная:
 * `expectedAt` в сервисе сверяется с временем показа ПОД БЛОКИРОВКОЙ строки — если за
 * время между превью и «Подтвердить» показ уже подвинули, ничего не пишется (409 STALE).
 *
 * Причина в REST обязательна (решение владельца 16.08.2026). Здесь она необязательна в
 * схеме для модели: не названа — пишется «по просьбе сотрудника через ИИ-помощника»,
 * чтобы в хронологии остался след, кто и как это сделал.
 */
const DEFAULT_REASON = "по просьбе сотрудника через ИИ-помощника";

const argsSchema = z.object({
  interactionId: z.string().trim().min(1).max(64),
  newAt: z.string().trim().min(1).max(40),
  reason: showingReasonSchema.optional(),
});
type Args = z.infer<typeof argsSchema>;

export const rescheduleShowingExecutor: AssistantActionExecutor<Args> = {
  tool: "reschedule_showing",
  channels: ["crm", "telegram"],
  parseArgs(raw) {
    const parsed = argsSchema.parse(raw);
    return { ...parsed, newAt: requireShowingInstant(parsed.newAt) };
  },

  async snapshot(args, actionActor) {
    const { showing } = await loadShowingForAction(actionActor, args.interactionId);
    // Как сервис: в прошлое переносить нельзя (встреча была бы просрочена в момент создания).
    if (new Date(args.newAt) <= new Date()) throw showingByIdError("past");
    if (new Date(args.newAt).getTime() === showing.nextActionDate.getTime()) {
      throw new AssistantActionError(409, "NO_CHANGE", "Показ уже стоит на это время");
    }
    return showingSnapshot(showing);
  },

  async buildPreview(args, snapshot, actionActor) {
    const { actor, showing } = await loadShowingForAction(actionActor, args.interactionId);
    const agent = snapshot.agentId
      ? await prisma.agent.findUnique({ where: { id: String(snapshot.agentId) }, select: { fullName: true } })
      : null;
    const notify = snapshot.agentId && snapshot.agentId !== actor.id;
    return {
      title: "Перенести показ",
      was: {
        Клиент: plainField(clientNamePhoneSafe(showing.client.fullName, actor.canViewPhone)),
        Объект: plainField(showing.property?.title) || "не указан",
        Время: showingTimeText(String(snapshot.at)),
      },
      becomes: {
        Время: showingTimeText(args.newAt),
        Причина: plainField(args.reason ?? DEFAULT_REASON, 200),
      },
      risk: notify
        ? `Агент ${plainField(agent?.fullName) || "показа"} получит уведомление о переносе; подтверждение клиента сбросится.`
        : "Подтверждение клиента и напоминания сбросятся.",
    };
  },

  async execute(args, actionActor, ctx) {
    const { actor, agentName } = await loadToolActor(actionActor);
    let result;
    try {
      result = await rescheduleShowingById({
        interactionId: args.interactionId,
        at: new Date(args.newAt),
        actor: { kind: "agent", agentId: actor.id, agentName, via: "assistant" },
        reason: args.reason ?? DEFAULT_REASON,
        expectedAt: new Date(String(ctx.snapshotBefore.at)),
      });
    } catch (err) {
      if (err instanceof ShowingMutationError) throw staleShowingError();
      throw err;
    }
    if (!result.ok) throw showingByIdError(result.reason);
    return {
      result: {
        interactionId: result.interactionId,
        at: result.at.toISOString(),
        href: ctx.snapshotBefore.clientId ? `/clients/${String(ctx.snapshotBefore.clientId)}` : null,
      },
      audit: { entityType: "Interaction", entityId: result.interactionId },
    };
  },
};

export const rescheduleShowingTool: AssistantWriteToolPlugin = {
  name: "reschedule_showing",
  level: "C",
  statusPhrase: "Готовлю перенос показа…",
  description:
    "Перенести УЖЕ назначенный показ на другое время (объект не меняется). Звать, когда сотрудник просит подвинуть/перенести показ; interactionId — id записи-показа из списка дел или календаря. " +
    "Ничего не записывает сама: покажет «было → станет» и ждёт подтверждения человека. " +
    "НЕ звать для обычной задачи (reschedule_task), для новой записи на показ (book_showing) и для отмены (cancel_showing). Переносить можно только на будущее время.",
  parameters: {
    type: "object",
    properties: {
      interactionId: { type: "string", description: "id записи-показа" },
      newAt: { type: "string", description: TIME_PARAM_DESCRIPTION },
      reason: { type: "string", description: "Почему переносим (клиент попросил, агент занят…). Если сотрудник не назвал — не придумывай, оставь пустым." },
    },
    required: ["interactionId", "newAt"],
  },
  executor: asPluginExecutor(rescheduleShowingExecutor),
};
