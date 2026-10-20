/**
 * GET /properties/summary — сводная плашка над каталогом (эталон tpl-properties):
 * заменяет честную заглушку «CRM не считает показы, а просрочку этапа не
 * суммирует» (см. историю в Properties.tsx/MobilePropertiesList.tsx).
 *
 * Два числа, которых не было ни в одном ответе:
 *  - showings30d — сколько показов (Interaction.type=SHOWING с propertyId)
 *    записано агентами за последние 30 дней по всему каталогу, а не по
 *    странице текущего фильтра;
 *  - overduePipelineCount — сколько объектов ПРЯМО СЕЙЧАС просрочили срок
 *    своего этапа конвейера (per-объект флаг p.pipeline.overdue уже виден
 *    тихой строкой в списке — здесь тот же расчёт суммируется по каталогу).
 *
 * overduePipelineCount считает ТОЙ ЖЕ функцией stageState, что красит строку
 * в списке (list.ts) и карточку объекта — иначе общий счётчик и отметка у
 * конкретного объекта могли разойтись (ровно та ловушка, о которой
 * предупреждает комментарий в propertyStage.ts). Берём id/status/stageEnteredAt
 * только объектов, ещё идущих по конвейеру (PROPERTY_PIPELINE_STATUSES) — это
 * малая часть каталога, не весь Property, и не N+1 (один запрос, разбор в JS).
 * SCAN_CAP — на случай, если однажды конвейер разрастётся непропорционально:
 * молча обрезать нельзя (правило CLAUDE.md про пагинацию), поэтому упёршийся
 * потолок пишется в журнал, как и у сортировки по цене (list.ts).
 */
import { Router } from "express";
import { PROPERTY_PIPELINE_STATUSES } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { requireAuth } from "../../auth/middleware.js";
import { loadPipelineDeadlines, stageState } from "../../lib/propertyPipeline.js";
import { logSystemError } from "../../lib/systemError.js";

export const propertiesSummaryRouter = Router();

const SCAN_CAP = 5000;

export interface PropertiesSummary {
  /** Окно расчёта показов, дней. */
  windowDays: number;
  /** Показов (Interaction SHOWING) по каталогу за windowDays. */
  showings30d: number;
  /** Объектов с просроченным сроком текущего этапа конвейера, по всему каталогу. */
  overduePipelineCount: number;
}

propertiesSummaryRouter.get("/summary", requireAuth, async (_req, res) => {
  const now = new Date();
  const windowDays = 30;
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const [showings30d, deadlines, pipelineRows, pipelineTotal] = await Promise.all([
    prisma.interaction.count({
      where: { type: "SHOWING", propertyId: { not: null }, createdAt: { gte: cutoff } },
    }),
    loadPipelineDeadlines(),
    prisma.property.findMany({
      where: { deletedAt: null, status: { in: [...PROPERTY_PIPELINE_STATUSES] } },
      select: { status: true, stageEnteredAt: true },
      take: SCAN_CAP,
    }),
    prisma.property.count({
      where: { deletedAt: null, status: { in: [...PROPERTY_PIPELINE_STATUSES] } },
    }),
  ]);

  if (pipelineTotal > SCAN_CAP) {
    void logSystemError(
      "api",
      `Сводка объектов: в конвейере ${pipelineTotal} объектов, просрочка посчитана по первым ${SCAN_CAP}`
    );
  }

  const overduePipelineCount = pipelineRows.filter(
    (p) => stageState(p.status, p.stageEnteredAt, deadlines, now).overdue
  ).length;

  const summary: PropertiesSummary = { windowDays, showings30d, overduePipelineCount };
  res.json(summary);
});
