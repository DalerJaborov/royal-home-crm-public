import { Router, type NextFunction, type Request, type Response } from "express";
import {
  socialVideoAddDestinationsSchema,
  socialVideoAiCaptionSchema,
  socialVideoAiCoverSchema,
  SOCIAL_VIDEO_DEFAULT_COVER_PROVIDER,
  type SocialVideoAiProvidersResponse,
  socialVideoCreateFieldsSchema,
  socialVideoListQuerySchema,
  socialVideoPublishSchema,
  socialVideoMarkRemovedSchema,
  socialVideoRemoveSchema,
  socialVideoRetrySchema,
  socialVideoUpdateSchema,
  SOCIAL_VIDEO_COVER_MIME_TYPES,
  type SocialVideoAiCaptionResponse,
} from "@royal-home/shared";
import { requireAuth } from "../auth/middleware.js";
import { requireMarketingRole } from "./marketing.js";
import { socialVideoUpload, socialVideoCoverUpload } from "../upload.js";
import { logAudit } from "../lib/audit.js";
import { loadChannelInfos, loadChannelLive } from "../lib/socialVideoChannels.js";
import { generateSocialVideoCaptions, listCoverProviders, SocialVideoAiError } from "../lib/socialVideoAi.js";
import { getSocialVideoTrends } from "../lib/socialVideoTrends.js";
import {
  SocialVideoError,
  addSocialVideoDestinations,
  clearCover,
  copySocialVideo,
  createSocialVideoFromUpload,
  deleteSocialVideo,
  getSocialVideo,
  listSocialVideos,
  publishSocialVideo,
  retrySocialVideo,
  setAiCover,
  setUploadedCover,
  unscheduleSocialVideo,
  updateSocialVideo,
} from "../lib/socialVideoPosts.js";
import { markSocialVideoRemovedByHand, removeSocialVideoFromSocials } from "../lib/socialVideoRemoval.js";
import fs from "node:fs";

/**
 * СВОБОДНЫЕ РОЛИКИ В СОЦСЕТИ — API (12.10.2026). Промо-ролик без объекта: загрузить,
 * написать подпись (сам или с ИИ), выбрать обложку, выбрать каналы, опубликовать сразу
 * или по расписанию, увидеть по каждому каналу, что произошло, и повторить упавшее.
 *
 * ДОСТУП — тот же, что у кабинета маркетинга: MARKETING, DIRECTOR, ADMIN
 * (requireMarketingRole, общий помощник с routes/marketing.ts и routes/tiktok.ts, не вторая
 * копия проверки роли). Всё, что можно проверить заранее, проверяет сервер, а не только
 * экран: пригодность ролика каналу (shared/socialVideo.ts::evaluateVideoForChannel),
 * подключённость канала, суточная квота Instagram, время расписания.
 */
export const socialVideosRouter = Router();
socialVideosRouter.use(requireAuth, requireMarketingRole);

type AsyncHandler = (req: Request, res: Response) => Promise<void>;

/** Известные ошибки сервиса и ИИ — человеческим текстом; остальное уходит в общий обработчик. */
function guarded(fn: AsyncHandler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof SocialVideoError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      if (err instanceof SocialVideoAiError) {
        res.status(502).json({ error: err.message });
        return;
      }
      next(err);
    }
  };
}

const idOf = (req: Request): string => String(req.params.id);

/**
 * ПОТОЛОК ЗАПРОСОВ К ИИ НА СОТРУДНИКА В ЧАС. Подпись стоит копейки, обложка около 0,24 доллара;
 * без предела неосторожный или чужой аккаунт маркетолога сливал бы бюджет провайдера
 * (защита «одна обложка на ролик» держит только повтор по одному ролику).
 */
const AI_HOUR_MS = 60 * 60_000;
const AI_LIMITS = { caption: 40, cover: 12 } as const;
const aiUsage = new Map<string, number[]>();

function aiLimited(agentId: string, kind: keyof typeof AI_LIMITS): boolean {
  const key = `${kind}:${agentId}`;
  const now = Date.now();
  const recent = (aiUsage.get(key) ?? []).filter((at) => now - at < AI_HOUR_MS);
  if (recent.length >= AI_LIMITS[kind]) {
    aiUsage.set(key, recent);
    return true;
  }
  recent.push(now);
  aiUsage.set(key, recent);
  return false;
}

// ── справочники каналов ─────────────────────────────────────────────────────

socialVideosRouter.get(
  "/channels",
  guarded(async (_req, res) => {
    res.json({ channels: await loadChannelInfos() });
  })
);

socialVideosRouter.get(
  "/channels/live",
  guarded(async (req, res) => {
    res.json({ channels: await loadChannelLive({ refresh: req.query.refresh === "1" }) });
  })
);

// ── ИИ: подписи (без привязки к ролику — работает и до загрузки файла) ──────

socialVideosRouter.post(
  "/ai-caption",
  guarded(async (req, res) => {
    const parsed = socialVideoAiCaptionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Неверный запрос" });
      return;
    }
    if (aiLimited(req.agent!.id, "caption")) {
      res.status(429).json({ error: "Слишком много запросов к ИИ за час — подождите немного или напишите подпись сами" });
      return;
    }
    const variants = await generateSocialVideoCaptions(parsed.data);
    const body: SocialVideoAiCaptionResponse = { variants };
    res.json(body);
  })
);

// ── ИИ-обложки: кто доступен и что сейчас в тренде ──────────────────────────

socialVideosRouter.get(
  "/ai-providers",
  guarded(async (_req, res) => {
    const body: SocialVideoAiProvidersResponse = { providers: await listCoverProviders(), defaultProvider: SOCIAL_VIDEO_DEFAULT_COVER_PROVIDER };
    res.json(body);
  })
);

socialVideosRouter.get(
  "/trends",
  guarded(async (req, res) => {
    res.json(await getSocialVideoTrends({ refresh: req.query.refresh === "1" }));
  })
);

// ── список и карточка ───────────────────────────────────────────────────────

socialVideosRouter.get(
  "/",
  guarded(async (req, res) => {
    const parsed = socialVideoListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Неверные параметры списка" });
      return;
    }
    res.json(await listSocialVideos(parsed.data));
  })
);

socialVideosRouter.get(
  "/:id",
  guarded(async (req, res) => {
    res.json(await getSocialVideo(idOf(req)));
  })
);

// ── создание и правка ───────────────────────────────────────────────────────

socialVideosRouter.post("/", socialVideoUpload.single("video"), async (req, res, next) => {
  const tmpPath = req.file?.path;
  try {
    if (!req.file) {
      res.status(400).json({ error: "Приложите файл ролика (поле video)" });
      return;
    }
    const fields = socialVideoCreateFieldsSchema.safeParse(req.body);
    if (!fields.success) {
      res.status(400).json({ error: fields.error.issues[0]?.message ?? "Неверные поля формы" });
      return;
    }
    const item = await createSocialVideoFromUpload({
      tmpPath: req.file.path,
      originalName: req.file.originalname,
      title: fields.data.title,
      caption: fields.data.caption,
      brief: fields.data.brief ?? null,
      channels: fields.data.channels,
      destinations: fields.data.destinations,
      createdById: req.agent!.id,
    });
    logAudit(req, "SOCIAL_VIDEO_CREATED", "SocialVideoPost", item.id, { sizeBytes: item.sizeBytes, durationSec: item.durationSec });
    res.status(201).json(item);
  } catch (err) {
    if (err instanceof SocialVideoError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  } finally {
    // Сервис убирает временный файл сам; это страховка на ранние выходы выше (нет полей, нет файла).
    if (tmpPath) await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
  }
});

socialVideosRouter.patch(
  "/:id",
  guarded(async (req, res) => {
    const parsed = socialVideoUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Неверный запрос" });
      return;
    }
    res.json(await updateSocialVideo(idOf(req), parsed.data));
  })
);

// ── обложка ─────────────────────────────────────────────────────────────────

/** Пока ИИ рисует (до полутора минут), второе нажатие на ту же кнопку не должно списать деньги дважды. */
const aiCoverInFlight = new Set<string>();

socialVideosRouter.post("/:id/cover", socialVideoCoverUpload.single("cover"), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "Приложите картинку (поле cover)" });
      return;
    }
    if (!(SOCIAL_VIDEO_COVER_MIME_TYPES as readonly string[]).includes(req.file.mimetype)) {
      res.status(422).json({ error: "Обложка — JPEG, PNG или WebP" });
      return;
    }
    const item = await setUploadedCover(idOf(req), req.file.buffer);
    logAudit(req, "SOCIAL_VIDEO_COVER_UPLOADED", "SocialVideoPost", item.id);
    res.json(item);
  } catch (err) {
    if (err instanceof SocialVideoError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

socialVideosRouter.post(
  "/:id/cover/ai",
  guarded(async (req, res) => {
    const parsed = socialVideoAiCoverSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Неверный запрос" });
      return;
    }
    const id = idOf(req);
    if (aiCoverInFlight.has(id)) {
      res.status(409).json({ error: "Обложка уже рисуется — подождите минуту" });
      return;
    }
    if (aiLimited(req.agent!.id, "cover")) {
      res.status(429).json({ error: "Слишком много обложек от ИИ за час — подождите или загрузите свою" });
      return;
    }
    aiCoverInFlight.add(id);
    try {
      const item = await setAiCover(id, parsed.data);
      logAudit(req, "SOCIAL_VIDEO_COVER_AI", "SocialVideoPost", item.id, {
        provider: item.coverMeta?.provider ?? null,
        usedFrame: item.coverMeta?.usedFrame ?? null,
        usedTrends: item.coverMeta?.usedTrends ?? null,
      });
      res.json(item);
    } finally {
      aiCoverInFlight.delete(id);
    }
  })
);

socialVideosRouter.delete(
  "/:id/cover",
  guarded(async (req, res) => {
    res.json(await clearCover(idOf(req)));
  })
);

// ── публикация ──────────────────────────────────────────────────────────────

socialVideosRouter.post(
  "/:id/publish",
  guarded(async (req, res) => {
    const parsed = socialVideoPublishSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Неверный запрос" });
      return;
    }
    const item = await publishSocialVideo(idOf(req), parsed.data);
    logAudit(req, "SOCIAL_VIDEO_PUBLISH", "SocialVideoPost", item.id, {
      mode: parsed.data.mode,
      scheduledAt: item.scheduledAt,
      channels: item.channels,
      destinations: item.destinations.map((d) => (d.accountId ? `${d.channel}:${d.accountId}` : d.channel)),
    });
    res.status(202).json(item);
  })
);

socialVideosRouter.post(
  "/:id/retry",
  guarded(async (req, res) => {
    const parsed = socialVideoRetrySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Неверный запрос" });
      return;
    }
    const item = await retrySocialVideo(idOf(req), parsed.data.channels, parsed.data.keys);
    logAudit(req, "SOCIAL_VIDEO_RETRY", "SocialVideoPost", item.id, { channels: parsed.data.channels ?? null, keys: parsed.data.keys ?? null });
    res.status(202).json(item);
  })
);

socialVideosRouter.post(
  "/:id/remove-from-socials",
  guarded(async (req, res) => {
    const parsed = socialVideoRemoveSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Неверный запрос" });
      return;
    }
    const { item, outcome } = await removeSocialVideoFromSocials(idOf(req), parsed.data.keys);
    logAudit(req, "SOCIAL_VIDEO_REMOVE", "SocialVideoPost", item.id, {
      removed: outcome.removed.map((r) => r.key),
      failed: outcome.failed.map((f) => f.key),
      manual: outcome.manual.map((m) => m.key),
    });
    res.json({ item, outcome });
  })
);

socialVideosRouter.post(
  "/:id/mark-removed",
  guarded(async (req, res) => {
    const parsed = socialVideoMarkRemovedSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Неверный запрос" });
      return;
    }
    const item = await markSocialVideoRemovedByHand(idOf(req), parsed.data.keys);
    logAudit(req, "SOCIAL_VIDEO_MARK_REMOVED", "SocialVideoPost", item.id, { keys: parsed.data.keys });
    res.json(item);
  })
);

socialVideosRouter.post(
  "/:id/add-destinations",
  guarded(async (req, res) => {
    const parsed = socialVideoAddDestinationsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Неверный запрос" });
      return;
    }
    const item = await addSocialVideoDestinations(idOf(req), parsed.data.destinations);
    logAudit(req, "SOCIAL_VIDEO_ADD_DESTINATIONS", "SocialVideoPost", item.id, {
      destinations: parsed.data.destinations.map((d) => (d.accountId ? `${d.channel}:${d.accountId}` : d.channel)),
    });
    res.status(202).json(item);
  })
);

socialVideosRouter.post(
  "/:id/copy",
  guarded(async (req, res) => {
    const item = await copySocialVideo(idOf(req), req.agent!.id);
    logAudit(req, "SOCIAL_VIDEO_COPIED", "SocialVideoPost", item.id, { from: idOf(req) });
    res.status(201).json(item);
  })
);

socialVideosRouter.post(
  "/:id/unschedule",
  guarded(async (req, res) => {
    res.json(await unscheduleSocialVideo(idOf(req)));
  })
);

socialVideosRouter.delete(
  "/:id",
  guarded(async (req, res) => {
    await deleteSocialVideo(idOf(req));
    logAudit(req, "SOCIAL_VIDEO_DELETED", "SocialVideoPost", idOf(req));
    res.status(204).end();
  })
);
