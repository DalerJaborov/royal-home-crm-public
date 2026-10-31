import { z } from "zod";
import { showingReasonSchema } from "@royal-home/shared";
import { prisma } from "../../../db.js";
import { type AssistantActionExecutor } from "../../../lib/assistantActions.js";
import { clientNamePhoneSafe } from "../../../lib/clientPhone.js";
import { ShowingMutationError } from "../../../lib/showingMutation.js";
import { cancelShowingById } from "../../../lib/showingBooking.js";
import {
  asPluginExecutor,
  loadShowingForAction,
  loadToolActor,
  plainField,
  showingByIdError,
  showingSnapshot,
  showingTimeText,
  staleShowingError,
} from "./showingToolSupport.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * cancel_showing — снять назначенный показ с календаря (уровень C, П3 группа show).
 *
 * Исполняет `cancelShowingById` (lib/showingBooking.ts) — тот же сервис, что
 * PATCH /interactions/:id/showing/cancel: запись остаётся в хронологии, снимается
 * `nextAction`, ставится `declinedAt`, закрывается «Итог показа», агенту уходит push, а
 * при ручной отмене заводится задача «Согласовать новую дату показа». Причина
 * ОБЯЗАТЕЛЬНА (решение владельца 16.08.2026) — как в REST. Права — `showingActionAccess`.
 * Запись условная: `expectedAt` сверяется под блокировкой строки (409 STALE).
 * Отката нет: агент уже получил push, а клиент может быть предупреждён.
 */
const argsSchema = z.object({
  interactionId: z.string().trim().min(1).max(64),
  reason: showingReasonSchema,
});
type Args = z.infer<typeof argsSchema>;

export const cancelShowingExecutor: AssistantActionExecutor<Args> = {
  tool: "cancel_showing",
  channels: ["crm", "telegram"],
  parseArgs: (raw) => argsSchema.parse(raw),

  async snapshot(args, actionActor) {
    const { showing } = await loadShowingForAction(actionActor, args.interactionId);
    return showingSnapshot(showing);
  },

  async buildPreview(args, snapshot, actionActor) {
    const { actor, showing } = await loadShowingForAction(actionActor, args.interactionId);
    const agent = snapshot.agentId
      ? await prisma.agent.findUnique({ where: { id: String(snapshot.agentId) }, select: { fullName: true } })
      : null;
    const notify = snapshot.agentId && snapshot.agentId !== actor.id;
    return {
      title: "Отменить показ",
      was: {
        Клиент: plainField(clientNamePhoneSafe(showing.client.fullName, actor.canViewPhone)),
        Объект: plainField(showing.property?.title) || "не указан",
        Время: showingTimeText(String(snapshot.at)),
      },
      becomes: { Показ: "отменён", Причина: plainField(args.reason, 200) },
      risk:
        "Показ снимется с календаря, останется в хронологии клиента; будет создана задача «Согласовать новую дату показа» на завтра." +
        (notify ? ` Агент ${plainField(agent?.fullName) || "показа"} получит уведомление.` : ""),
    };
  },

  async execute(args, actionActor, ctx) {
    const { actor, agentName } = await loadToolActor(actionActor);
    let result;
    try {
      result = await cancelShowingById({
        interactionId: args.interactionId,
        actor: { kind: "agent", agentId: actor.id, agentName, via: "assistant" },
        reason: args.reason,
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

export const cancelShowingTool: AssistantWriteToolPlugin = {
  name: "cancel_showing",
  level: "C",
  statusPhrase: "Готовлю отмену показа…",
  description:
    "Снять назначенный показ с календаря. Звать, когда сотрудник просит отменить показ; interactionId — id записи-показа. " +
    "Причина ОБЯЗАТЕЛЬНА: если сотрудник её не назвал, сначала спроси, не придумывай. Ничего не записывает сама: покажет карточку и ждёт подтверждения человека. " +
    "НЕ звать для переноса (reschedule_showing) и для обычных задач.",
  parameters: {
    type: "object",
    properties: {
      interactionId: { type: "string", description: "id записи-показа" },
      reason: { type: "string", description: "Почему отменяем (клиент отказался, объект продан…) — от 3 символов" },
    },
    required: ["interactionId", "reason"],
  },
  executor: asPluginExecutor(cancelShowingExecutor),
};
