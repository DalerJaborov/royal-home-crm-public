import { customerActionIntentsSchema, customerOwnerReplyTargetSchema } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { lockCustomerStateSnapshot } from "./customerState.js";
import { CustomerScopeDenied, resolveCustomerEndpoint } from "./customerConversationScope.js";
import { ownerQuestionQueueScope, ownerQuestionVisibleNativeIds } from "./ownerQuestionAccess.js";
import { ownerQuestionTargetMatches, ownerQuestionTransport } from "./ownerQuestionMutation.js";

export type ManagedOwnerAnswerContext = { expectedRevision: string };
export type ManagedOwnerAnswerResult =
  | { ok: true; delivered: false; deliveryStatus: "HELD"; managedRevision: string;
      holdReason: "auto_return_unavailable" | "original_target_changed" }
  | { ok: false; status: number; error: string };
type QuestionRow = { id: string; conversationId: string; customerActionId: string | null; replyTarget: unknown;
  managedRevision: bigint | null; answeredAt: Date | null };

async function canAnswer(tx: TxClient, agentId: string, nativeId: string, sameOriginalBinding: boolean): Promise<boolean> {
  const scope = await ownerQuestionQueueScope(tx, agentId);
  return scope === "all" || (scope === "own" && sameOriginalBinding &&
    (await ownerQuestionVisibleNativeIds(tx, agentId, [nativeId])).has(nativeId));
}

/** A fresh staff operation, not an extension of the customer's old principal.
 * Answer CAS precedes every possible future network operation. Auto-return is
 * deliberately unavailable until P12; stale targets stay immutable/HELD. */
export async function answerManagedOwnerQuestion(questionId: string, answer: string, agentId: string,
  context?: ManagedOwnerAnswerContext): Promise<ManagedOwnerAnswerResult> {
  const text = answer.trim();
  if (!text || text.length > 2000 || !context || !/^[1-9]\d*$/.test(context.expectedRevision)) {
    return { ok: false, status: 400, error: "Нужны текст ответа и актуальная версия вопроса" };
  }
  return prisma.$transaction(async (tx): Promise<ManagedOwnerAnswerResult> => {
    const original = await tx.ownerQuestion.findUnique({ where: { id: questionId }, select: {
      id: true, conversationId: true, customerActionId: true, replyTarget: true,
    } });
    if (!original?.customerActionId) return { ok: false, status: 404, error: "Вопрос не найден" };
    const target = customerOwnerReplyTargetSchema.safeParse(original.replyTarget);
    // Canonical lock helper enforces native -> scope -> policy -> inquiry.
    // Missing/tombstoned native never produces a substitute target or grant.
    const snapshot = target.success ? await lockCustomerStateSnapshot(tx, { inquiryId: target.data.inquiryId }) : null;
    const rows = await tx.$queryRaw<QuestionRow[]>`SELECT "id","conversationId","customerActionId","replyTarget","managedRevision","answeredAt"
      FROM "OwnerQuestion" WHERE "id"=${questionId} FOR UPDATE`;
    const row = rows[0];
    if (!row || !row.customerActionId) return { ok: false, status: 404, error: "Вопрос не найден" };
    if (!await canAnswer(tx, agentId, row.conversationId,
      target.success && target.data.nativeId === row.conversationId && ownerQuestionTargetMatches(target.data, snapshot))) {
      return { ok: false, status: 403, error: "Нет доступа к исходному диалогу" };
    }
    if (row.answeredAt || row.managedRevision?.toString() !== context.expectedRevision) {
      return { ok: false, status: 409, error: "Вопрос уже изменён или на него ответили" };
    }
    if (row.customerActionId !== original.customerActionId || JSON.stringify(row.replyTarget) !== JSON.stringify(original.replyTarget)) {
      return { ok: false, status: 409, error: "Привязка вопроса изменилась" };
    }
    // Evaluate only the saved target, even though auto-return stays closed.
    // Never findClientDeliveryTarget/profile fanout/current-session fallback.
    let currentTarget = target.success && target.data.nativeId === row.conversationId && ownerQuestionTargetMatches(target.data, snapshot);
    if (currentTarget && target.success) {
      try { await resolveCustomerEndpoint({ channel: target.data.channel, subscriberId: target.data.peer,
        transport: ownerQuestionTransport(target.data) }, tx); }
      catch (error) { if (error instanceof CustomerScopeDenied) currentTarget = false; else throw error; }
      const action = await tx.customerAction.findUnique({ where: { id: row.customerActionId }, select: {
        status: true, kind: true, inquiryId: true, generation: true, resourceId: true, supersededAt: true,
        receiptVersion: true, publicRef: true, resourceRevision: true,
      } });
      const inquiry = await tx.customerInquiry.findUnique({ where: { id: target.data.inquiryId }, select: { actionIntents: true } });
      const intents = customerActionIntentsSchema.safeParse(inquiry?.actionIntents);
      const slot = intents.success ? intents.data.owner_question : null;
      currentTarget = currentTarget && action?.status === "COMMITTED" && action.kind === "owner_question" &&
        action.receiptVersion === 2 && !!action.publicRef && !!action.resourceRevision && action.resourceRevision > 0n &&
        action.inquiryId === target.data.inquiryId && action.resourceId === row.id && !action.supersededAt &&
        action.generation.toString() === target.data.generation && slot?.generation === target.data.generation && slot.status === "committed";
    }
    // Neither a currently valid target nor staff text unlocks P12 delivery.
    const holdReason = currentTarget ? "auto_return_unavailable" : "original_target_changed";
    const changed = await tx.ownerQuestion.updateMany({ where: { id: row.id, customerActionId: row.customerActionId,
      managedRevision: BigInt(context.expectedRevision), answeredAt: null }, data: {
      answer: text, answeredAt: new Date(), answeredById: agentId, deliveredAt: null,
      deliveryStatus: "HELD", managedRevision: { increment: 1 },
    } });
    if (changed.count !== 1) return { ok: false, status: 409, error: "Вопрос уже изменён или на него ответили" };
    return { ok: true, delivered: false, deliveryStatus: "HELD", holdReason,
      managedRevision: (BigInt(context.expectedRevision) + 1n).toString() };
  });
}
