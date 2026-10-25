import { Router } from "express";
import { z } from "zod";
import { isSellerControlRopRole, type SalesControlHome } from "@royal-home/shared";
import { requireAuth, can } from "../auth/middleware.js";
import { prisma } from "../db.js";
import { phoneSafeText } from "../lib/clientPhone.js";
import { assignmentSourceEpochIsCurrent } from "../lib/investigationAssignmentEpoch.js";
import { controlRecipientAvailable } from "../lib/sellerControlAvailability.js";
import { withInvestigationPrivacy } from "../lib/investigationOperations.js";
import { buyerCandidateLiveEnabled } from "../lib/buyerCandidateControl.js";

export const dashboardSalesControlRouter = Router();
dashboardSalesControlRouter.get("/sales-control", requireAuth, async (req, res) => {
  if (!isSellerControlRopRole(req.agent?.role)) return res.status(403).json({ error: "Недостаточно прав" });
  if (!z.object({}).strict().safeParse(req.query).success) return res.status(400).json({ error: "Некорректный запрос" });
  return withInvestigationPrivacy(true, async () => {
    const actorId = req.agent!.id;
    const now = new Date();
    const actor = await prisma.agent.findUnique({ where: { id: actorId }, select: { isActive: true, frozenAt: true, absenceUntil: true } });
    const result: SalesControlHome = { tasks: [], limited: false,
      actionsEnabled: process.env.SELLER_CONTROL_INTERNAL_LIVE === "explicitly-approved" && controlRecipientAvailable(actor, now) };
    // Filter ordinary task state before limiting. Completed retained episodes
    // must not displace pending work; continue past stale assignment epochs too.
    let offset = 0;
    while (result.tasks.length <= 100) {
      const rows = await prisma.$queryRaw<Array<{
        clientId: string; clientShortId: number; clientName: string; agentId: string;
        assignmentAt: Date; createdAt: Date; status: string; buyerCandidateId: string | null;
        taskId: string; dueAt: Date | null;
      }>>`
        SELECT e."clientId", c."shortId" AS "clientShortId", c."fullName" AS "clientName",
          e."agentId", e."assignmentAt", e."createdAt", e.status, e."buyerCandidateId",
          t.id AS "taskId", t."nextActionDate" AS "dueAt"
        FROM "SellerControlEpisode" e
        JOIN "Interaction" t ON t.id = e."ropTaskId" AND t."clientId" = e."clientId"
        JOIN "Client" c ON c.id = e."clientId"
        WHERE e."ropAgentId" = ${actorId} AND e."executionMode" = 'LIVE'
          AND e.status IN ('ROP_RECEIPT', 'ROP_ACTION', 'DIRECTOR')
          AND t."subjectAgentId" = ${actorId} AND t."investigationOnly" = false
          AND t."taskCancelledAt" IS NULL AND t."completedAt" IS NULL AND t."declinedAt" IS NULL
          AND t."nextAction" IS NOT NULL
          AND c."deletedAt" IS NULL AND c."assignmentCompletedAt" IS NULL
          AND c."assignedAgentId" = e."agentId" AND c."assignedAt" = e."assignmentAt"
        ORDER BY t."nextActionDate" ASC NULLS LAST, e.id ASC
        LIMIT 101 OFFSET ${offset}`;
      for (const row of rows) {
        if (!await assignmentSourceEpochIsCurrent(prisma, { clientId: row.clientId, subjectAgentId: row.agentId,
          assignmentAt: row.assignmentAt, sourceAt: row.createdAt, now })) continue;
        const buyerEnabled = !row.buyerCandidateId || buyerCandidateLiveEnabled();
        result.tasks.push({ id: row.taskId, clientId: row.clientId, clientShortId: row.clientShortId,
          clientName: phoneSafeText(row.clientName, can(req, "clients.viewPhone")),
          title: "Проверьте работу с клиентом и зафиксируйте результат",
          dueAt: row.dueAt?.toISOString() ?? null,
          responseAction: result.actionsEnabled && buyerEnabled ? row.status === "ROP_RECEIPT" ? "RECEIPT" : row.status === "ROP_ACTION" ? "ACTION" : null : null });
        if (result.tasks.length > 100) break;
      }
      if (rows.length < 101) break;
      offset += rows.length;
    }
    result.limited = result.tasks.length > 100;
    result.tasks = result.tasks.slice(0, 100);
    result.tasks.sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999") || a.id.localeCompare(b.id));
    return res.json(result);
  });
});
