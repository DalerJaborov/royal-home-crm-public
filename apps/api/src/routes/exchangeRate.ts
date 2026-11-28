import { Router } from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { requireElevation } from "../lib/stepUp.js";
import { prisma } from "../db.js";
import { logAudit } from "../lib/audit.js";
import {
  JUMP_LIMIT_PCT,
  STALE_HOURS,
  changePct,
  findStaleRateCaptions,
  onUsdRateApplied,
  refreshStaleRateCaptions,
  resyncUsdPropertiesOnSite,
  usdPropertiesOnSite,
} from "../lib/exchangeRateWatch.js";

/**
 * Курс доллара: состояние стража и кнопки руководителя (владелец 28.11.2026).
 * Только директор/админ (settings.manage). Кнопки, которые трогают живые посты и сайт, — только по нажатию.
 */
export const exchangeRateRouter = Router();

exchangeRateRouter.use(requireAuth, requirePermission("settings.manage"));

exchangeRateRouter.get("/status", async (_req, res) => {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      usdToTjsRate: true,
      usdToTjsRateUpdatedAt: true,
      usdToTjsRateSource: true,
      usdRatePendingValue: true,
      usdRatePendingAt: true,
      usdRateAlertPct: true,
      usdRateSiteResyncEnabled: true,
      usdRateAlertsEnabled: true,
    },
  });
  const rate = s?.usdToTjsRate != null ? Number(s.usdToTjsRate) : null;
  const ageHours = s?.usdToTjsRateUpdatedAt ? (Date.now() - s.usdToTjsRateUpdatedAt.getTime()) / 3_600_000 : null;
  const pending = s?.usdRatePendingValue != null ? Number(s.usdRatePendingValue) : null;
  const [staleCaptions, siteCount] = await Promise.all([findStaleRateCaptions(), usdPropertiesOnSite()]);
  res.json({
    rate,
    updatedAt: s?.usdToTjsRateUpdatedAt ?? null,
    source: s?.usdToTjsRateSource ?? null,
    ageHours: ageHours === null ? null : Math.floor(ageHours),
    stale: rate === null || ageHours === null || ageHours > STALE_HOURS,
    staleAfterHours: STALE_HOURS,
    jumpLimitPct: JUMP_LIMIT_PCT,
    pending: pending === null ? null : { rate: pending, at: s?.usdRatePendingAt ?? null, changePct: changePct(rate, pending) },
    alertPct: s?.usdRateAlertPct ?? 1,
    siteResyncEnabled: s?.usdRateSiteResyncEnabled ?? true,
    alertsEnabled: s?.usdRateAlertsEnabled ?? true,
    siteUsdCount: siteCount.length,
    staleCaptions: staleCaptions.map((c) => ({ code: c.code, channels: c.channels })),
  });
});

const configSchema = z.object({ alertPct: z.number().min(0.1).max(20) });

exchangeRateRouter.patch("/config", requireElevation, async (req, res) => {
  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Порог — число от 0,1 до 20 процентов" });
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { usdRateAlertPct: parsed.data.alertPct },
    create: { id: "singleton", usdRateAlertPct: parsed.data.alertPct },
  });
  logAudit(req, "SETTINGS_UPDATE", "Settings", "singleton", { usdRateAlertPct: parsed.data.alertPct });
  res.json({ alertPct: parsed.data.alertPct });
});

/** Применить курс, который ждал подтверждения после скачка. */
exchangeRateRouter.post("/confirm-pending", requireElevation, async (req, res) => {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { usdToTjsRate: true, usdRatePendingValue: true } });
  if (s?.usdRatePendingValue == null) return res.status(409).json({ error: "Нового курса на подтверждение нет" });
  const next = Number(s.usdRatePendingValue);
  const previous = s.usdToTjsRate != null ? Number(s.usdToTjsRate) : null;
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { usdToTjsRate: next, usdToTjsRateUpdatedAt: new Date(), usdToTjsRateSource: "alif-auto", usdRatePendingValue: null, usdRatePendingAt: null, usdRateDismissedValue: null },
  });
  logAudit(req, "SETTINGS_UPDATE", "Settings", "singleton", { usdToTjsRate: next, source: "alif-auto", confirmedJump: true });
  await onUsdRateApplied(previous, next, "alif-auto");
  res.json({ rate: next });
});

/** Оставить прежний курс, не принимать скачок. */
exchangeRateRouter.post("/dismiss-pending", async (req, res) => {
  const cur = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { usdRatePendingValue: true } });
  // Запоминаем отклонённое значение (то же не будит повторно) и считаем действующий курс подтверждённым сегодня.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { usdRateDismissedValue: cur?.usdRatePendingValue ?? null, usdRatePendingValue: null, usdRatePendingAt: null, usdToTjsRateUpdatedAt: new Date() },
  });
  logAudit(req, "SETTINGS_UPDATE", "Settings", "singleton", { usdRatePendingDismissed: true });
  res.json({ ok: true });
});

/** Переслать на сайт все объекты в долларах (цена пересчитывается по текущему курсу). */
exchangeRateRouter.post("/resync-site", requireElevation, async (req, res) => {
  const count = await resyncUsdPropertiesOnSite("кнопка «Пересчитать цены на сайте» (курс доллара)");
  logAudit(req, "SETTINGS_UPDATE", "Settings", "singleton", { usdSiteResync: count });
  res.json({ count });
});

/** «Обновить подписи» — переписать строку цены в подписях вышедших постов. Только по нажатию, не больше 40 объектов за раз. */
exchangeRateRouter.post("/refresh-captions", requireElevation, async (req, res) => {
  const summary = await refreshStaleRateCaptions();
  logAudit(req, "SETTINGS_UPDATE", "Settings", "singleton", { usdCaptionsRefreshed: summary.queued, manual: summary.manual.length });
  res.json(summary);
});
