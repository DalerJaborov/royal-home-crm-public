import { Router } from "express";
import rateLimit from "express-rate-limit";
import { getInstagramMedia } from "../messengers/instagramFeed.js";
import { prisma } from "../db.js";
import { secretsMatch } from "../lib/secretCompare.js";
import path from "node:path";
import { z } from "zod";
import type { Request } from "express";
import { loadCatalogProperties, renderHomeListingCsv } from "../lib/metaCatalogFeed.js";
import { loadProductVideoRows, renderProductVideoCsv } from "../lib/metaProductVideoFeed.js";
import { isPropertyVideoPublic } from "../lib/propertyPublicVideo.js";
import { logSystemError } from "../lib/systemError.js";
import { videoHandoffDir } from "../upload.js";

/**
 * Публичные данные для сайта royalhome.tj и рекламных систем — без входа в CRM.
 *
 * Лента Instagram — совсем без ключа: посты и так открыты всему миру, а маркер,
 * которым они добыты, наружу не уходит. Фид каталога Meta ниже — с ключом в
 * запросе (?key=...): сам файл не секрет (Meta и так покажет эти объекты в
 * рекламе), но адрес не должен подбираться перебором — иначе кто угодно мог бы
 * скачать список всех объектов в продаже одним запросом.
 */
export const publicFeedRouter = Router();

/** Запросы идут с одного адреса (сервер сайта) и кэшируются на 20 минут — лимит
 *  тут предохранитель от зациклившейся интеграции, а не защита от посетителей. */
const feedLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Слишком много запросов, попробуйте позже" },
});

publicFeedRouter.get("/instagram/media", feedLimiter, async (_req, res) => {
  const items = await getInstagramMedia();
  // Пустой список и «не смогли получить» — разные вещи: сайт по items: null
  // показывает свои плашки из админки, а не пустую ленту.
  res.set("Cache-Control", "public, max-age=600");
  res.json({ items });
});

/**
 * КАТАЛОГ META ДЛЯ РЕКЛАМЫ (Advantage+ catalog ads, home_listings, 28.09.2026) —
 * CSV, который Commerce Manager забирает по расписанию (раз в час/день).
 *
 * Тумблер выключен ИЛИ ключ не совпал → 404, не 401: 401 подтвердил бы
 * постороннему, что по этому адресу вообще что-то есть и дело только в ключе.
 * Ключ сравнивается через secretsMatch (защита от подбора по времени ответа —
 * тот же приём, что и у вебхуков сайта, см. routes/webhooks.ts).
 */
/** Ключ и тумблер каталога Meta — общие для обоих CSV. */
async function metaCatalogKeyOk(req: Request): Promise<boolean> {
  const key = typeof req.query.key === "string" ? req.query.key : "";
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaCatalogFeedEnabled: true, metaCatalogFeedKey: true },
  });
  const configuredKey = settings?.metaCatalogFeedKey ?? "";
  return !!settings?.metaCatalogFeedEnabled && !!configuredKey && !!key && secretsMatch(key, configuredKey);
}

publicFeedRouter.get("/meta-catalog/home-listings.csv", feedLimiter, async (req, res) => {
  if (!(await metaCatalogKeyOk(req))) return res.status(404).end();
  const rows = await loadCatalogProperties();
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Cache-Control", "public, max-age=600");
  res.send(renderHomeListingCsv(rows));
});

/** Тестовый товарный фид Meta с видео (video[0].url) — тот же ключ и тумблер. */
publicFeedRouter.get("/meta-catalog/products-video.csv", feedLimiter, async (req, res) => {
  if (!(await metaCatalogKeyOk(req))) return res.status(404).end();
  const rows = await loadProductVideoRows();
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Cache-Control", "public, max-age=600");
  res.send(renderProductVideoCsv(rows));
});

/**
 * ГОТОВЫЙ РОЛИК ОБЪЕКТА ПО ПОСТОЯННОЙ ССЫЛКЕ (23.10.2026) — для сайта (видео вторым
 * слайдом) и для Meta (video[0].url в товарном фиде). Без входа. Файл — строго из
 * videoHandoffDir по basename из БД, ничего из запроса в путь не попадает.
 * Непубличный объект, чужой формат адреса и пропавший файл — один и тот же 404 без
 * подробностей. Лимит выше, чем у фидов: плеер шлёт много Range-запросов.
 */
const videoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Слишком много запросов, попробуйте позже" },
});

const propertyVideoParam = z.object({ file: z.string().regex(/^\d{1,9}\.mp4$/) });

publicFeedRouter.get("/property-video/:file", videoLimiter, async (req, res) => {
  const parsed = propertyVideoParam.safeParse(req.params);
  if (!parsed.success) return res.status(404).end();
  const shortId = Number.parseInt(parsed.data.file, 10);

  const property = await prisma.property.findUnique({
    where: { shortId },
    select: {
      shortId: true,
      status: true,
      deletedAt: true,
      publishedOnSite: true,
      offSite: true,
      videoHandoffFinalPath: true,
      publishedChannels: true,
      publishedPostIds: true,
    },
  });
  if (!property || !isPropertyVideoPublic(property)) return res.status(404).end();

  const fileName = path.basename(property.videoHandoffFinalPath!);
  res.setHeader("Content-Type", "video/mp4");
  // root + basename: приём остальных файловых роутов (Express 5 не любит точки в пути);
  // sendFile сам ставит Accept-Ranges и отвечает на Range — плееру это нужно.
  res.sendFile(fileName, { root: videoHandoffDir, maxAge: "1d" }, (err) => {
    if (err && !res.headersSent) {
      void logSystemError("storage", `Публичный ролик объекта №${shortId} не отдан: ${err.message}`);
      res.removeHeader("Content-Type");
      res.status(404).end();
    }
  });
});
