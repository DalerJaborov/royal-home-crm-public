import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { can, requireAuth, requirePermission } from "../auth/middleware.js";
import { canViewInvestigations } from "@royal-home/shared";
import { GIVEN_UP_MAX, listStuckWork, retryStuckWorkItem } from "../lib/stuckWork.js";

/** Сколько сдавшихся показать: экран растит это число кнопкой «Показать ещё». */
const listQuerySchema = z.object({
  givenUpLimit: z.coerce.number().int().min(1).max(GIVEN_UP_MAX).optional(),
});

export const stuckWorkRouter = Router();

/**
 * «Что не доехало» — экран директора/админа (владелец 21.09.2026): задания
 * фоновой очереди (`BackgroundJob`, jobs/runner.ts), которые либо исчерпали
 * попытки (GIVEN_UP), либо явно висят (просроченный PENDING/зависший RUNNING),
 * плюс отдельно контейнеры Instagram, которые Meta не смогла обработать
 * (REJECTED/EXPIRED, `lib/instagramPendingContainers.ts`) — другой механизм,
 * поэтому отдельным списком, без смешения с очередью заданий.
 *
 * Право то же, что у «Здоровья системы» (auditLog.view) — экран того же
 * назначения: то, что CRM не смогла сделать сама и что нужно решать человеку.
 */
stuckWorkRouter.get("/", requireAuth, requirePermission("auditLog.view"), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Неверные параметры" });
  const [queue, instagramContainers] = await Promise.all([
    listStuckWork({ givenUpLimit: parsed.data.givenUpLimit, includePrivate: canViewInvestigations(req.agent?.role) && can(req, "clients.securityReview") }),
    prisma.pendingInstagramContainer.findMany({
      where: { status: { in: ["REJECTED", "EXPIRED"] } },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        status: true,
        kind: true,
        error: true,
        createdAt: true,
        property: { select: { shortId: true, title: true } },
      },
    }),
  ]);

  res.json({
    givenUp: queue.givenUp,
    hanging: queue.hanging,
    counts: queue.counts,
    instagramContainers: instagramContainers.map((c) => ({
      id: c.id,
      status: c.status,
      kind: c.kind,
      error: c.error,
      createdAt: c.createdAt,
      propertyShortId: c.property.shortId,
      propertyTitle: c.property.title,
    })),
  });
});

/**
 * «Повторить» — только для реально застрявшей записи очереди (см.
 * retryStuckWorkItem): сбрасывает попытки и runAt, снимает лизинг. Контейнеры
 * Instagram кнопки не имеют — протухший/отклонённый Meta creation_id повторно
 * опрашивать бессмысленно, публикация начнётся заново своим обычным путём.
 */
stuckWorkRouter.post("/:id/retry", requireAuth, requirePermission("auditLog.view"), async (req, res) => {
  const outcome = await retryStuckWorkItem(req.params.id, canViewInvestigations(req.agent?.role) && can(req, "clients.securityReview"));
  if (outcome === "not-found") return res.status(404).json({ error: "Задание не найдено" });
  if (outcome === "not-stuck") return res.status(409).json({ error: "Задание не застряло — сейчас его нечем повторять" });
  res.status(204).end();
});
