import { Router, type NextFunction, type Request, type Response } from "express";
import {
  REELS_AUTOBOOST_STATUSES,
  reelsAutoBoostSettingsPatchSchema,
  type ReelsAutoBoostOverview,
  type ReelsAutoBoostStatus,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { logAudit } from "../lib/audit.js";
import { describeError } from "../lib/describeError.js";
import { loadReelsAutoBoostSettings, runReelsAutoBoostGuarded } from "../lib/ads/reelsAutoBoost.js";

/**
 * Автопродвижение роликов: статус, настройки, «проверить сейчас».
 * Монтируется в routes/ads.ts под /reels-autoboost; права читать/писать приходят оттуда
 * (те же, что у остальной рекламы), чтобы правило «кто видит и меняет рекламу» жило в одном месте.
 */

const ROWS_LIMIT = 60;

type Guard = (req: Request, res: Response, next: NextFunction) => unknown;

async function buildOverview(): Promise<ReelsAutoBoostOverview> {
  const [settings, grouped, rows] = await Promise.all([
    loadReelsAutoBoostSettings(),
    prisma.reelAutoBoostAd.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.reelAutoBoostAd.findMany({
      orderBy: { updatedAt: "desc" },
      take: ROWS_LIMIT,
      include: { property: { select: { shortId: true, title: true } } },
    }),
  ]);
  const counts = Object.fromEntries(REELS_AUTOBOOST_STATUSES.map((s) => [s, 0])) as Record<ReelsAutoBoostStatus, number>;
  for (const g of grouped) counts[g.status as ReelsAutoBoostStatus] = g._count._all;
  return {
    settings,
    counts,
    rows: rows.map((r) => ({
      id: r.id,
      propertyId: r.propertyId,
      propertyShortId: r.property?.shortId ?? null,
      propertyTitle: r.property?.title ?? null,
      instagramMediaId: r.instagramMediaId,
      metaAdId: r.metaAdId,
      status: r.status as ReelsAutoBoostStatus,
      reason: r.reason,
      spendUsd: r.spendUsd === null ? null : Number(r.spendUsd),
      conversations: r.conversations,
      updatedAt: r.updatedAt.toISOString(),
      lastCheckedAt: r.lastCheckedAt?.toISOString() ?? null,
    })),
  };
}

export function createReelsAutoBoostRouter(guards: { read: Guard; write: Guard }): Router {
  const router = Router();

  router.get("/", guards.read, async (_req, res) => {
    try {
      res.json(await buildOverview());
    } catch (err) {
      res.status(500).json({ error: `Не удалось прочитать автопродвижение: ${describeError(err)}` });
    }
  });

  router.patch("/", guards.write, async (req, res) => {
    const parsed = reelsAutoBoostSettingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Неверные настройки" });
    }
    const patch = parsed.data;
    const current = await loadReelsAutoBoostSettings();
    const next = { ...current, ...patch };
    // Боевой режим без группы объявлений ничего не сделает, а владелец решит, что всё работает.
    if (next.enabled && !next.dryRun && !next.adSetId) {
      return res.status(400).json({
        error: "Для боевого режима укажите номер группы объявлений постоянной кампании (создаётся в Ads Manager)",
      });
    }
    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        ...(patch.enabled !== undefined && { reelsAutoBoostEnabled: patch.enabled }),
        ...(patch.dryRun !== undefined && { reelsAutoBoostDryRun: patch.dryRun }),
        ...(patch.adSetId !== undefined && { reelsAutoBoostAdSetId: patch.adSetId }),
        ...(patch.maxActive !== undefined && { reelsAutoBoostMaxActive: patch.maxActive }),
        ...(patch.maxAgeDays !== undefined && { reelsAutoBoostMaxAgeDays: patch.maxAgeDays }),
        ...(patch.stopLossSpendUsd !== undefined && { reelsAutoBoostStopLossSpendUsd: patch.stopLossSpendUsd }),
        ...(patch.ctaType !== undefined && { reelsAutoBoostCtaType: patch.ctaType }),
      },
    });
    logAudit(req, "SETTINGS_UPDATE", "Settings", "singleton", { reelsAutoBoost: patch });
    res.json(await buildOverview());
  });

  /** «Проверить сейчас» — один проход вне расписания (в пробном режиме безопасен). */
  router.post("/run", guards.write, async (_req, res) => {
    try {
      const result = await runReelsAutoBoostGuarded();
      if (!result) return res.status(409).json({ error: "Проход уже идёт, подождите минуту" });
      res.json({ result, overview: await buildOverview() });
    } catch (err) {
      res.status(500).json({ error: `Проход не удался: ${describeError(err)}` });
    }
  });

  return router;
}
