import { z } from "zod";
import { customerActionIntentsSchema, parsePermissionOverrides, resolvePermissions, type Role } from "@royal-home/shared";
import { prisma } from "../db.js";
import { showingTimeLabel } from "../lib/showingBooking.js";
import { logSystemError } from "../lib/systemError.js";
import { sendPushToAgent } from "../push.js";
import type { JobHandler } from "./registry.js";

const schema = z.object({ version: z.literal(1), actionId: z.string().uuid() }).strict();
type Row = { kind: "book_showing" | "reschedule_showing" | "cancel_showing"; generation: bigint;
  inquiryId: string; resourceId: string; resourceRevision: bigint; currentRevision: bigint;
  actionIntents: unknown; nextAction: string | null; at: Date; declinedAt: Date | null; completedAt: Date | null;
  clientId: string; clientShortId: number; clientAssignedAgentId: string | null; clientAcceptedAt: Date | null;
  effectiveAgentId: string | null };

/** A durable retry observes the existing resource. It never books, changes a
 * showing, creates timeline records, dials or sends anything to a customer. */
export const customerShowingNotifyJob: JobHandler<z.infer<typeof schema>> = {
  type: "customer-showing-notify", schema,
  backoff: attempt => Math.min(2 ** attempt, 16) * 30_000,
  async run(payload) {
    async function currentResource(): Promise<Row | null> {
      const rows = await prisma.$queryRaw<Row[]>`SELECT a."kind",a."generation",a."inquiryId",a."resourceId",a."resourceRevision",
        s."managedShowingRevision" AS "currentRevision",i."actionIntents",s."nextAction",s."nextActionDate" AS at,s."declinedAt",s."completedAt",
        c."id" AS "clientId",c."shortId" AS "clientShortId",c."assignedAgentId" AS "clientAssignedAgentId",c."acceptedAt" AS "clientAcceptedAt",
        COALESCE(s."subjectAgentId",s."agentId") AS "effectiveAgentId"
        FROM "CustomerAction" a JOIN "CustomerInquiry" i ON i."id"=a."inquiryId"
        JOIN "BotConversation" b ON b."id"=i."conversationId" AND b."endpointScopeId"=i."endpointScopeId" AND b."subscriberId"=i."peerId"
        JOIN "Interaction" s ON s."id"=a."resourceId" AND s."type"='SHOWING'
        JOIN "CustomerAction" origin ON origin."id"=s."customerBookingActionId" AND origin."inquiryId"=a."inquiryId"
          AND origin."kind"='book_showing' AND origin."status"='COMMITTED' AND origin."resourceId"=s."id" AND origin."bindingRevision"=i."bindingRevision"
        JOIN "Client" c ON c."id"=s."clientId" AND c."id"=b."clientId" AND c."deletedAt" IS NULL
        WHERE a."id"=${payload.actionId} AND a."kind" IN ('book_showing','reschedule_showing','cancel_showing')
          AND a."status"='COMMITTED' AND a."resourceType"='Interaction' AND a."receiptVersion"=2
          AND a."supersededAt" IS NULL AND i."closedAt" IS NULL AND a."bindingRevision"=i."bindingRevision"
          AND a."resourceRevision"=s."managedShowingRevision" AND s."nextActionDate" IS NOT NULL AND s."taskCancelledAt" IS NULL`;
      const row = rows.length === 1 ? rows[0] : null;
      if (!row) return null;
      const parsed = customerActionIntentsSchema.safeParse(row.actionIntents);
      if (!parsed.success) throw new Error("Showing notification has invalid canonical intent");
      const slot = parsed.data[row.kind];
      if (!slot || slot.status !== "committed" || slot.generation !== row.generation.toString() || row.completedAt) return null;
      if (row.kind === "cancel_showing" ? row.nextAction !== null || !row.declinedAt : !row.nextAction || !!row.declinedAt) return null;
      return row;
    }
    const first = await currentResource();
    // A stale/changed resource is not a failed mutation and must not be replayed.
    if (!first) return;
    if (!first.effectiveAgentId) throw new Error("Showing notification has no effective agent");
    const agent = await prisma.agent.findUnique({ where: { id: first.effectiveAgentId }, select: { id: true, isActive: true, role: true, permissions: true } });
    if (!agent?.isActive) throw new Error("Showing notification has no active recipient");
    const permissions = resolvePermissions(agent.role as Role, parsePermissionOverrides(agent.permissions));
    // Existing staff client scope: own accepted card or clients.viewAll. A task
    // assignment itself does not grant access to a foreign/unaccepted Client.
    if (!permissions.has("clients.viewAll") && (first.clientAssignedAgentId !== agent.id || !first.clientAcceptedAt)) {
      throw new Error("Showing notification recipient cannot access the client");
    }
    // Recheck after recipient/permission awaits; do not send an old time or to
    // an old assignee after a concurrent staff edit/reassignment.
    const current = await currentResource();
    if (!current || current.effectiveAgentId !== agent.id || current.clientAssignedAgentId !== first.clientAssignedAgentId ||
        current.clientAcceptedAt?.getTime() !== first.clientAcceptedAt?.getTime()) return;
    const acceptedDevices = await sendPushToAgent(agent.id, {
      title: current.kind === "book_showing" ? "✅ Бот назначил показ" : current.kind === "reschedule_showing" ? "🔄 Клиент перенёс показ" : "❌ Клиент отменил показ",
      // No freeform client name/title/notes/phone in a device notification.
      // The existing staff card rechecks ACL and phone masking when opened.
      body: current.kind === "cancel_showing" ? "Показ отменён. Откройте карточку и согласуйте следующий шаг."
        : `Показ ${showingTimeLabel(current.at)}. Проверьте договорённость в карточке клиента.`,
      url: `/clients/${current.clientShortId}`, tag: `showing-${current.resourceId}`,
    });
    // Telemetry only. Accepted push devices are not agent acknowledgement,
    // customer delivery, attendance or a second business receipt.
    await prisma.$executeRaw`UPDATE "CustomerAction" SET "policyResult"=COALESCE("policyResult",'{}'::jsonb) || jsonb_build_object('notification',
      jsonb_build_object('attemptedAt',now(),'recipientAgentId',${agent.id},'providerAcceptedDevices',${acceptedDevices},'agentAcknowledged',false))
      WHERE "id"=${payload.actionId} AND "status"='COMMITTED'`;
  },
  async onGiveUp(payload) {
    await logSystemError("background-jobs", "Уведомление сотруднику о сохранённом показе не подтверждено; показ остаётся в CRM", {
      dedupKey: `customer-showing-notify:${payload.actionId}`,
    });
  },
};
