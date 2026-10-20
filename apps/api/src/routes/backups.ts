import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { secretsMatch } from "../lib/secretCompare.js";

export const backupsRouter = Router();

/**
 * ЖУРНАЛ БЭКАПОВ — экран `/backups` (перенос мобильного макета 14.09.2026,
 * шаг 5). `ops/backup.sh`/`ops/restore-drill.sh` работают полностью вне CRM
 * (bash на VPS, свой cron) и раньше не оставляли ни одной строки в базе —
 * только Telegram-алерт при отказе и файлы на диске. `POST /report` — их
 * best-effort отчёт по каждому шагу; отказ ЭТОГО запроса не должен ронять
 * сам бэкап (в скрипте вызов обёрнут `|| true`), поэтому здесь нет смысла
 * усложнять — это телеметрия, а не часть механизма бэкапа.
 */
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const reportSchema = z.object({
  // DEAL_DOCS — документы сделок (том deal_docs_data): приём готов заранее, шаг в
  // ops/backup.sh добавляет владелец на сервере (G3, 02.10.2026).
  kind: z.enum(["DB", "UPLOADS", "PRIVATE_UPLOADS", "PROPERTY_VIDEO", "DEAL_DOCS", "OFFSITE", "RESTORE_DRILL"]),
  success: z.boolean(),
  sizeLabel: z.string().max(40).optional(),
  detail: z.string().max(500).optional(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
});

backupsRouter.post("/report", reportLimiter, async (req, res) => {
  const apiKey = process.env.BACKUP_REPORT_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "Приём отчётов о бэкапах не настроен" });
  }
  if (!secretsMatch(req.get("X-Api-Key") ?? "", apiKey)) {
    return res.status(401).json({ error: "Неверный API-ключ" });
  }
  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные отчёта", details: parsed.error.flatten() });
  }
  const d = parsed.data;
  await prisma.backupRun.create({
    data: {
      kind: d.kind,
      success: d.success,
      sizeLabel: d.sizeLabel,
      detail: d.detail,
      startedAt: new Date(d.startedAt),
      finishedAt: new Date(d.finishedAt),
    },
  });
  res.status(204).end();
});

/**
 * Последний прогон каждого шага + короткая история — владелец/директор смотрит
 * «жив ли бэкап», не архив на годы. `take` ограничен на каждый `kind`
 * отдельно, поэтому активный шаг (DB, раз в сутки) не вытесняет из выборки
 * редкий (UPLOADS, раз в неделю).
 */
backupsRouter.get("/", requireAuth, requirePermission("auditLog.view"), async (_req, res) => {
  const rows = await prisma.backupRun.findMany({
    orderBy: { finishedAt: "desc" },
    take: 300,
  });
  if (rows.length === 0) {
    return res.json({ latestByKind: [], recent: [] });
  }
  const latestByKind = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (!latestByKind.has(r.kind)) latestByKind.set(r.kind, r);
  }
  res.json({
    latestByKind: [...latestByKind.values()],
    recent: rows.slice(0, 20),
  });
});
