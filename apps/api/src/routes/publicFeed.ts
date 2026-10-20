import { Router } from "express";
import rateLimit from "express-rate-limit";
import { getInstagramMedia } from "../messengers/instagramFeed.js";
import { prisma } from "../db.js";
import { secretsMatch } from "../lib/secretCompare.js";
import { loadCatalogProperties, renderHomeListingCsv } from "../lib/metaCatalogFeed.js";

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
publicFeedRouter.get("/meta-catalog/home-listings.csv", feedLimiter, async (req, res) => {
  const key = typeof req.query.key === "string" ? req.query.key : "";
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaCatalogFeedEnabled: true, metaCatalogFeedKey: true },
  });
  const configuredKey = settings?.metaCatalogFeedKey ?? "";
  if (!settings?.metaCatalogFeedEnabled || !configuredKey || !key || !secretsMatch(key, configuredKey)) {
    return res.status(404).end();
  }
  const rows = await loadCatalogProperties();
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Cache-Control", "public, max-age=600");
  res.send(renderHomeListingCsv(rows));
});
