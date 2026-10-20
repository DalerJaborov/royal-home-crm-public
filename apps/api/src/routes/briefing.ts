import path from "node:path";
import { Router } from "express";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { buildBriefingResponse, existingBriefingAudioPath, loadBriefing } from "../lib/morningBriefing.js";

/**
 * Утренний брифинг директору — те же числа, что уходят push-сводкой в 08:00,
 * но связным текстом и голосом лица ИИ прямо на главной.
 *
 * Право `dashboard.analytics` — то же, что у остальных сводных данных пульта
 * (routes/dashboard.ts): агент получит 403, директор и админ проходят.
 * Монтируется под /api/v1/dashboard рядом с dashboardRouter.
 */
export const briefingRouter = Router();

/** GET /api/v1/dashboard/briefing — текст брифинга, числа и ссылка на озвучку. */
briefingRouter.get("/briefing", requireAuth, requirePermission("dashboard.analytics"), async (_req, res) => {
  try {
    res.json(await buildBriefingResponse());
  } catch {
    // Брифинг не должен ронять главную: экран покажет «данных нет» тихой строкой.
    res.status(503).json({ error: "Брифинг сейчас недоступен" });
  }
});

/**
 * GET /api/v1/dashboard/briefing/audio — WAV сегодняшнего брифинга.
 * Файл ищется по хешу актуального текста, поэтому вчерашняя озвучка не отдаётся.
 */
briefingRouter.get(
  "/briefing/audio",
  requireAuth,
  requirePermission("dashboard.analytics"),
  async (_req, res) => {
    const briefing = await loadBriefing().catch(() => null);
    const filePath = briefing ? existingBriefingAudioPath(briefing.text) : null;
    if (!filePath) return res.status(404).json({ error: "Озвучка не найдена" });

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.sendFile(
      path.basename(filePath),
      { root: path.dirname(filePath), cacheControl: false, dotfiles: "deny" },
      (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: "Озвучка не найдена" });
      }
    );
  }
);
