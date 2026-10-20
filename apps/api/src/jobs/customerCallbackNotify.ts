import { z } from "zod";
import { customerActionIntentsSchema, isReadOnlyRole, parsePermissionOverrides, resolvePermissions, type Role } from "@royal-home/shared";
import { prisma } from "../db.js";
import { findAgentsWithPermission } from "../lib/recipients.js";
import { logSystemError } from "../lib/systemError.js";
import { sendPushToAgents } from "../push.js";
import { ownBotConversationWhere } from "../lib/ownBotConversationScope.js";
import { loadCustomerStateSnapshot } from "../lib/customerState.js";
import { managedCustomerCallbackWitnessMatches } from "../lib/customerCallbackLifecycle.js";
import type { JobHandler } from "./registry.js";

const schema = z.object({ version: z.literal(1), actionId: z.string().uuid() }).strict();
type NotificationRow = { resourceId: string; inquiryId: string; generation: bigint; actionIntents: unknown;
  kind: "callback" | "handover"; conversationId: string | null; requestKind: string | null; lifecycleStatus: string | null; lifecycleRevision: string | null;
  handoverFence: unknown; phone: string | null; topic: string; doneAt: Date | null; supersededAt: Date | null };

async function humanRecipients(conversationId: string | null): Promise<string[]> {
  if (!conversationId) return [];
  const native = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: {
    id: true, client: { select: { assignedAgentId: true, deletedAt: true } },
  } });
  if (!native) return [];
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { callbackOperatorAgentId: true } });
  const candidates = [...new Set([native.client?.deletedAt ? null : native.client?.assignedAgentId,
    settings?.callbackOperatorAgentId].filter((id): id is string => !!id))];
  // Existing HUMAN policy: assigned agent, else duty. No management FYI and
  // no access created merely by assigning this task to a recipient.
  for (const id of candidates) {
    const agent = await prisma.agent.findUnique({ where: { id }, select: { isActive: true, role: true, permissions: true } });
    if (!agent?.isActive || isReadOnlyRole(agent.role as Role)) continue;
    const permissions = resolvePermissions(agent.role as Role, parsePermissionOverrides(agent.permissions));
    if (permissions.has("messages.view")) return [id];
    if (permissions.has("messages.viewOwn") && await prisma.botConversation.findFirst({
      where: { id: native.id, ...ownBotConversationWhere(id) }, select: { id: true },
    })) return [id];
  }
  return [];
}

/** Retry of postcommit notification never creates a CallbackRequest or dials.
 * Device/provider acceptance is telemetry, not agent acknowledgement/delivery. */
export const customerCallbackNotifyJob: JobHandler<z.infer<typeof schema>> = {
  type: "customer-callback-notify", schema,
  backoff: attempt => Math.min(2 ** attempt, 16) * 30_000,
  async run(payload) {
    const rows = await prisma.$queryRaw<NotificationRow[]>`SELECT a."resourceId",a."inquiryId",a."generation",a."supersededAt",
      i."actionIntents",a."kind",r."phone",r."topic",r."doneAt",r."conversationId",r."requestKind",r."lifecycleStatus",r."lifecycleRevision"::text,r."handoverFence"
      FROM "CustomerAction" a JOIN "CustomerInquiry" i ON i."id"=a."inquiryId"
      JOIN "CallbackRequest" r ON r."id"=a."resourceId" AND r."customerActionId"=a."id"
      WHERE a."id"=${payload.actionId} AND a."status"='COMMITTED'
        AND ((a."kind"='callback' AND a."receiptVersion"=1) OR (a."kind"='handover' AND a."receiptVersion"=2))`;
    if (rows.length !== 1) throw new Error("Callback notification lacks committed resource");
    const row = rows[0]; const parsed = customerActionIntentsSchema.safeParse(row.actionIntents);
    if (!parsed.success) throw new Error("Callback notification has invalid canonical intent");
    const intent = row.kind === "handover" ? parsed.data.handover : parsed.data.callback;
    if (row.doneAt || row.supersededAt || !intent || intent.status !== "committed" || intent.generation !== row.generation.toString() ||
        (row.lifecycleStatus !== null && row.lifecycleStatus !== "QUEUED")) return;
    if (row.kind === "handover" && row.requestKind !== "HUMAN") throw new Error("Human request has invalid resource kind");
    const current = await loadCustomerStateSnapshot({ inquiryId: row.inquiryId });
    if (!current || current.fence.nativeId !== row.conversationId || current.closedAt ||
        !managedCustomerCallbackWitnessMatches(row.handoverFence, current)) return;
    const recipients = row.kind === "handover" ? await humanRecipients(row.conversationId) : await findAgentsWithPermission("messages.view");
    // Persist routing observation without claiming human/provider acceptance.
    await prisma.$executeRaw`UPDATE "CustomerAction" SET "policyResult"=COALESCE("policyResult",'{}'::jsonb) || jsonb_build_object('notification',
      jsonb_build_object('routingCheckedAt',now(),'recipientAgentIds',${JSON.stringify(recipients)}::jsonb,'agentAcknowledged',false))
      WHERE "id"=${payload.actionId} AND "status"='COMMITTED'`;
    if (recipients.length === 0) throw new Error("Callback notification has no eligible recipients");
    const fresh = await loadCustomerStateSnapshot({ inquiryId: row.inquiryId });
    const resources = await prisma.$queryRaw<Array<{ lifecycleStatus: string | null; lifecycleRevision: string | null; doneAt: Date | null }>>`SELECT "lifecycleStatus","lifecycleRevision"::text,"doneAt" FROM "CallbackRequest"
      WHERE "id"=${row.resourceId} AND "customerActionId"=${payload.actionId}`;
    const resource = resources[0];
    if (!fresh || fresh.closedAt || !managedCustomerCallbackWitnessMatches(row.handoverFence, fresh) || !resource ||
        resource.doneAt || resource.lifecycleStatus !== row.lifecycleStatus || resource.lifecycleRevision !== row.lifecycleRevision) return;
    const acceptedDevices = await sendPushToAgents(recipients, {
      title: row.kind === "handover" ? "🙋 Клиент просит живого человека" : "📞 Клиент просит звонок",
      body: `${row.topic}${row.phone ? ` Телефон: ${row.phone}` : " Телефона пока нет — спросите в переписке."}`,
      url: "/messages", tag: `customer-callback-${payload.actionId}`,
    });
    // No customer acknowledgement derives from this best-effort existing push API.
    await prisma.$executeRaw`UPDATE "CustomerAction" SET "policyResult"=COALESCE("policyResult",'{}'::jsonb) || jsonb_build_object('notification',
      jsonb_build_object('attemptedAt',now(),'recipientAgentIds',${JSON.stringify(recipients)}::jsonb,
        'providerAcceptedDevices',${acceptedDevices},'agentAcknowledged',false))
      WHERE "id"=${payload.actionId} AND "status"='COMMITTED'`;
  },
  async onGiveUp(payload) {
    await logSystemError("background-jobs", "Уведомление о записанной просьбе клиента не подтверждено; задача осталась в CRM", {
      dedupKey: `customer-callback-notify:${payload.actionId}`,
    });
  },
};
