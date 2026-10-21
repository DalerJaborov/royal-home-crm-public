import { Router } from "express";
import { recruitmentPositionKeySchema, recruitmentPositionUpdateSchema } from "@royal-home/shared";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { requireElevation } from "../lib/stepUp.js";
import { readRecruitmentPositions } from "../lib/recruitmentPositions.js";
import { recruitmentPositionTemplates } from "../lib/recruitmentPositionTemplates.js";
import { recruitmentRecoveryRequestSchema } from "@royal-home/shared";
import { enqueueRecruitmentRecovery } from "../lib/recruitmentRecovery.js";

export const recruitmentPositionsRouter = Router();
recruitmentPositionsRouter.use(requireAuth, requirePermission("vacancies.view"));
recruitmentPositionsRouter.get("/", async (_req, res) => {
  try { res.json({ items: await readRecruitmentPositions() }); }
  catch { res.status(503).json({ error: "Не удалось загрузить открытые позиции" }); }
});
recruitmentPositionsRouter.get("/templates", (_req, res) => {
  res.json({ items: recruitmentPositionTemplates() });
});
recruitmentPositionsRouter.post("/recovery", requirePermission("settings.manage"), requirePermission("messages.view"), requireElevation, async (req, res) => {
  const parsed = recruitmentRecoveryRequestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Проверьте список откликов и кампанию исправления" }); return; }
  try { res.json(await enqueueRecruitmentRecovery(req.agent!.id, parsed.data)); }
  catch { res.status(503).json({ error: "Не удалось подготовить исправленные ответы. Проверьте статус кампании перед повтором." }); }
});
recruitmentPositionsRouter.get("/recovery/:campaign", requirePermission("settings.manage"), async (req, res) => {
  if (!/^[a-z0-9-]{8,64}$/.test(req.params.campaign)) { res.status(400).json({ error: "Неверная кампания" }); return; }
  try {
    const items = await prisma.$queryRaw`SELECT r."id",r."originalConversationId" AS "conversationId",r."status",r."reason",r."createdAt",r."finishedAt",j."runAt" AS "scheduledAt",
      (r."providerMid" IS NOT NULL) AS "providerReceiptPresent",(r."projectionAt" IS NOT NULL) AS "visibleInConversation"
      FROM "RecruitmentRecovery" r LEFT JOIN "BackgroundJob" j ON j."dedupeKey"='recruitment-recovery:' || r."id"
      WHERE r."campaign"=${req.params.campaign} ORDER BY r."createdAt" LIMIT 50`;
    res.json({ items });
  } catch { res.status(503).json({ error: "Не удалось обновить статус исправленных ответов" }); }
});
recruitmentPositionsRouter.put("/:key", requirePermission("settings.manage"), requireElevation, async (req, res) => {
  const key = recruitmentPositionKeySchema.safeParse(req.params.key), parsed = recruitmentPositionUpdateSchema.safeParse(req.body);
  if (!key.success || !parsed.success) { res.status(400).json({ error: "Проверьте поля вакансии" }); return; }
  try {
    const result = await prisma.$transaction(async tx => {
      // Small staff-maintained catalog: serialize create/update, including its
      // size bound and globally unique publication mapping. No model writes.
      await tx.$executeRaw`LOCK TABLE "RecruitmentPosition" IN SHARE ROW EXCLUSIVE MODE`;
      const existing = await tx.recruitmentPosition.findUnique({ where: { key: key.data }, select: { revision: true } });
      if ((existing?.revision ?? 0) !== parsed.data.expectedRevision) return "conflict" as const;
      if (!existing && await tx.recruitmentPosition.count() >= 24) return "limit" as const;
      const { expectedRevision, postCodes, keywords, ...data } = parsed.data;
      await tx.recruitmentPosition.upsert({ where: { key: key.data },
        create: { key: key.data, ...data }, update: { ...data, revision: { increment: 1 }, updatedAt: new Date() } });
      await tx.recruitmentPublication.deleteMany({ where: { positionKey: key.data } });
      if (postCodes.length) await tx.recruitmentPublication.createMany({ data: postCodes.map(code => ({ code, positionKey: key.data })) });
      await tx.recruitmentKeyword.deleteMany({ where: { positionKey: key.data } });
      if (keywords.length) await tx.recruitmentKeyword.createMany({ data: keywords.map(word => ({ word, positionKey: key.data })) });
      const author = await tx.agent.findUniqueOrThrow({ where: { id: req.agent!.id }, select: { fullName: true } });
      await tx.auditLog.create({ data: { action: "RECRUITMENT_POSITION_UPDATE", entityType: "RecruitmentPosition", entityId: key.data,
        agentId: req.agent!.id, agentName: author.fullName, meta: { isOpen: data.isOpen, previousRevision: expectedRevision } } });
      return "saved" as const;
    });
    if (result === "conflict") { res.status(409).json({ error: "Вакансию уже изменили. Обновите список и повторите правку." }); return; }
    if (result === "limit") { res.status(409).json({ error: "Достигнут лимит: 24 позиции. Закройте или отредактируйте существующую." }); return; }
    res.json({ items: await readRecruitmentPositions() });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      res.status(409).json({ error: "Публикация или ключевое слово уже связаны с другой вакансией" }); return;
    }
    res.status(503).json({ error: "Не удалось сохранить вакансию" });
  }
});
