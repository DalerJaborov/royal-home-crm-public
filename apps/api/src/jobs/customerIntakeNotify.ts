import { z } from "zod";
import { prisma } from "../db.js";
import { customerIntakeProgressSchema } from "../lib/customerIntakeContext.js";
import { findAgentsWithPermission } from "../lib/recipients.js";
import { logSystemError } from "../lib/systemError.js";
import { sendLeadPush } from "../lib/pushLeadActions.js";
import { sendPushToAgents } from "../push.js";
import type { JobHandler } from "./registry.js";

const schema = z.object({ version: z.literal(1), actionId: z.string().uuid() }).strict();
export const customerIntakeNotifyJob: JobHandler<z.infer<typeof schema>> = {
  type: "customer-intake-notify", schema,
  backoff: attempt => Math.min(2 ** attempt, 16) * 30_000,
  async run(payload) {
    const [action] = await prisma.$queryRaw<{ resourceId: string; policyResult: unknown }[]>`SELECT "resourceId","policyResult" FROM "CustomerAction"
      WHERE "id"=${payload.actionId} AND "kind"='new_lead' AND "status"='COMMITTED' AND "resourceType"='Client' AND "receiptVersion"=1`;
    if (!action) throw new Error("Customer intake notification lacks committed resource");
    const progress = customerIntakeProgressSchema.parse(action.policyResult); const outcome = progress.intakeOutcome;
    if (!outcome) throw new Error("Customer intake policy is incomplete");
    const client = await prisma.client.findUnique({ where: { id: action.resourceId } });
    if (!client || client.deletedAt || client.customerIntakeActionId) return;
    if (outcome.mode === "assigned") {
      if (!outcome.agentId || client.assignedAgentId !== outcome.agentId) return;
      await sendLeadPush(outcome.agentId, client.id, { title: "🔔 Новый лид", body: `${client.fullName} — примите заявку, иначе её передадут другому агенту`,
        url: `/clients/${client.shortId}`, tag: `lead-${client.id}` });
    } else if (outcome.mode === "other") {
      const recipients = await findAgentsWithPermission("otherInquiries.view");
      if (!recipients.length) throw new Error("Customer OTHER intake has no recipients");
      await sendPushToAgents(recipients, { title: "🔔 Новое обращение", body: `${client.fullName} — «Прочие обращения», не для агентов`,
        url: `/clients/${client.shortId}`, tag: `lead-${client.id}` });
    } else if (outcome.mode === "unassigned" && !client.assignedAgentId) {
      const recipients = await findAgentsWithPermission("clients.assign");
      if (!recipients.length) throw new Error("Customer unassigned intake has no supervisors");
      await sendPushToAgents(recipients, { title: "⏳ Лид ждёт назначения", body: `${client.fullName} — назначьте агента вручную`,
        url: `/clients/${client.shortId}`, tag: `lead-unassigned-${client.id}` });
    }
    // Stable existing tags bound duplicates; no customer-facing delivery receipt
    // or claim of exactly-once device notifications is produced here.
  },
  async onGiveUp(payload) {
    await logSystemError("background-jobs", "Уведомление о сохранённой новой заявке не подтверждено; карточка осталась в CRM", {
      dedupKey: `customer-intake-notify:${payload.actionId}`,
    });
  },
};
