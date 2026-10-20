import { z } from "zod";
import { customerActionIntentsSchema, customerOwnerReplyTargetSchema } from "@royal-home/shared";
import { prisma } from "../db.js";
import { ownerQuestionStaffRecipients } from "../lib/ownerQuestionAccess.js";
import { logSystemError } from "../lib/systemError.js";
import { sendPushToAgents } from "../push.js";
import type { JobHandler } from "./registry.js";

const schema = z.object({ version: z.literal(1), actionId: z.string().uuid() }).strict();
type Row = { questionId: string; conversationId: string; replyTarget: unknown; answeredAt: Date | null;
  inquiryId: string; generation: bigint; actionIntents: unknown; supersededAt: Date | null; closedAt: Date | null };

/** Notification retry observes the committed question. It never creates another
 * question, asks a model, contacts an owner/customer, or acknowledges delivery. */
export const customerOwnerQuestionNotifyJob: JobHandler<z.infer<typeof schema>> = {
  type: "customer_owner_question_notify", schema,
  backoff: attempt => Math.min(2 ** attempt, 16) * 30_000,
  async run(payload) {
    const rows = await prisma.$queryRaw<Row[]>`SELECT q."id" AS "questionId",q."conversationId",q."replyTarget",q."answeredAt",
      a."inquiryId",a."generation",a."supersededAt",i."actionIntents",i."closedAt"
      FROM "CustomerAction" a JOIN "CustomerInquiry" i ON i."id"=a."inquiryId"
      JOIN "OwnerQuestion" q ON q."customerActionId"=a."id" AND q."id"=a."resourceId"
      WHERE a."id"=${payload.actionId} AND a."kind"='owner_question' AND a."status"='COMMITTED'
        AND a."resourceType"='OwnerQuestion' AND a."receiptVersion"=2 AND a."publicRef" IS NOT NULL
        AND a."resourceRevision">0 AND a."resourceRevision"=q."managedRevision"`;
    if (rows.length !== 1) throw new Error("Owner question notification lacks committed resource");
    const row = rows[0];
    const target = customerOwnerReplyTargetSchema.safeParse(row.replyTarget);
    const intents = customerActionIntentsSchema.safeParse(row.actionIntents);
    if (!target.success || !intents.success || target.data.inquiryId !== row.inquiryId || target.data.nativeId !== row.conversationId ||
        target.data.generation !== row.generation.toString()) throw new Error("Owner question notification has invalid original target");
    const slot = intents.data.owner_question;
    if (row.answeredAt || row.closedAt || row.supersededAt || !slot || slot.status !== "committed" || slot.generation !== target.data.generation) return;
    const recipients = await ownerQuestionStaffRecipients(prisma, row.conversationId, target.data);
    if (recipients.length === 0) throw new Error("Owner question notification has no eligible recipients");
    // No phone/question/owner data in the shared push body. Existing staff UI
    // rereads the question with staff ACL; this push is not human acceptance.
    await sendPushToAgents(recipients, { title: "Нужно уточнить вопрос у собственника",
      body: "В CRM записан вопрос клиента по объекту. Откройте очередь вопросов и сохраните ответ.",
      url: `/messages?open=${row.conversationId}`, tag: `customer-owner-question-${payload.actionId}` });
  },
  async onGiveUp(payload) {
    await logSystemError("background-jobs", "Уведомление о вопросе собственнику не подтверждено; вопрос остаётся в очереди CRM", {
      dedupKey: `customer-owner-question-notify:${payload.actionId}`,
    });
  },
};
