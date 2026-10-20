/**
 * «РАЗДАТЬ ПО ГРУППАМ FACEBOOK» — маршруты карточки объекта (28.09.2026,
 * docs/agent-briefs/facebook-groups-share-28-09.md). Логика — lib/facebookGroupShare.ts,
 * здесь только HTTP: права, парсинг тела, коды ответа.
 *
 * GET читает любой, кто видит карточку объекта (список групп и то, что уже
 * выложено, — не действие, а факт про объект, как у MontageBlock). Отметить
 * «Выложено»/«Отменить» может кабинет маркетинга ИЛИ хозяин объекта
 * (propertyOwnerAgentId) — тот же принцип, что у «Убрать из соцсетей» плюс
 * собственный агент, который и понёс объект в группы руками.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAuth } from "../../auth/middleware.js";
import { hasMarketingRole } from "../marketing.js";
import { propertyOwnerAgentId } from "../../lib/propertyOwner.js";
import { logAudit } from "../../lib/audit.js";
import { shareStatus, markGroupShareDone, undoGroupShare } from "../../lib/facebookGroupShare.js";

export const groupShareRouter = Router();

const indexParamSchema = z.object({ index: z.coerce.number().int().min(0) });

/** Хозяин объекта ИЛИ кабинет маркетинга — та же формула, что и у остальных
 *  действий над постами объекта (canManageProperty в shared.ts), но с явной
 *  проверкой propertyOwnerAgentId вместо трёх полей россыпью, потому что здесь
 *  нужен единый резолвер (задание прямо называет lib/propertyOwner.ts). */
async function canMarkGroupShare(agentId: string, agentRole: string | undefined, propertyId: string): Promise<boolean> {
  if (hasMarketingRole(agentRole)) return true;
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { intakeAgentId: true, assignedAgentId: true, createdById: true },
  });
  if (!property) return false;
  return propertyOwnerAgentId(property) === agentId;
}

groupShareRouter.get("/:id/group-share", requireAuth, async (req, res) => {
  const result = await shareStatus(req.params.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ groups: result.groups, done: result.done, total: result.total });
});

groupShareRouter.post("/:id/group-share/:index/done", requireAuth, async (req, res) => {
  const parsedIndex = indexParamSchema.safeParse(req.params);
  if (!parsedIndex.success) return res.status(400).json({ error: "Некорректный номер группы" });

  const allowed = await canMarkGroupShare(req.agent!.id, req.agent!.role, req.params.id);
  if (!allowed) return res.status(403).json({ error: "Недостаточно прав" });

  const result = await markGroupShareDone(req.params.id, parsedIndex.data.index, req.agent!.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });

  logAudit(req, "PROPERTY_GROUP_SHARE_DONE", "Property", req.params.id, { groupIndex: parsedIndex.data.index });
  res.json({ ok: true });
});

groupShareRouter.delete("/:id/group-share/:index/done", requireAuth, async (req, res) => {
  const parsedIndex = indexParamSchema.safeParse(req.params);
  if (!parsedIndex.success) return res.status(400).json({ error: "Некорректный номер группы" });

  const allowed = await canMarkGroupShare(req.agent!.id, req.agent!.role, req.params.id);
  if (!allowed) return res.status(403).json({ error: "Недостаточно прав" });

  const result = await undoGroupShare(req.params.id, parsedIndex.data.index);
  if (!result.ok) return res.status(result.status).json({ error: result.error });

  logAudit(req, "PROPERTY_GROUP_SHARE_UNDONE", "Property", req.params.id, { groupIndex: parsedIndex.data.index });
  res.json({ ok: true });
});
