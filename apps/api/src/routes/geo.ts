/**
 * ГЕО-СПРАВОЧНИК: HTTP (12.09.2026, docs/geo-match-plan-12-09.md, блок H и N).
 *
 * `GET /lookup` — координата → место, тот же ответ, что и `lib/geoLookup.ts`;
 * это тот роут, который позже позовёт мастер объекта (план, блок H).
 * `GET /suggest` — подсказка адреса при вводе текстом, поверх `geoResolve` и
 * поиска по домам (`lib/geoSuggest.ts`).
 * `GET /resolve` — поиск сверху на карте объектов (блок N): текст → лучшее
 * место + до четырёх альтернатив, напрямую поверх `lib/geoResolve.ts` (блок B,
 * ветка `feat/geo-autofill-12-09`) — своего разбора текста здесь нет и не
 * будет, ровно по правилу файла-источника: одна функция на бота, подбор и
 * карту, а не три расходящихся написания одного места.
 *
 * `GET /landmarks` — координата → один-два ориентира рядом готовым текстом для
 * поля «Ориентир» в мастере объекта (владелец 25.09.2026), поверх
 * `lib/landmarkPick.ts` — того же отбора, что у строки места на карте.
 *
 * Все точки — под `requireAuth`: справочник внутренний, наружу (боту/сайту)
 * не отдаётся напрямую.
 */
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { lookupGeoPoint } from "../lib/geoLookup.js";
import { suggestGeoAddress, SUGGEST_DEFAULT_LIMIT, SUGGEST_MAX_LIMIT } from "../lib/geoSuggest.js";
import { resolveGeoText } from "../lib/geoResolve.js";
import { suggestLandmarks } from "../lib/landmarkPick.js";
import { isInsideDushanbe } from "../lib/geo.js";
import { logSystemError } from "../lib/systemError.js";

export const geoRouter = Router();

const resolveQuerySchema = z.object({ q: z.string().trim().min(1).max(200) });

geoRouter.get("/resolve", requireAuth, async (req, res) => {
  const parsed = resolveQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные параметры запроса", details: parsed.error.flatten() });
  }
  const result = await resolveGeoText(parsed.data.q);
  res.json({ result });
});

const lookupQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

geoRouter.get("/lookup", requireAuth, async (req, res) => {
  const parsed = lookupQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Нужны координаты lat и lng", details: parsed.error.flatten() });
  }
  const { lat, lng } = parsed.data;
  if (!isInsideDushanbe(lat, lng)) {
    // Не ошибка — просто честно говорим, что справочник за пределами
    // Душанбе не покрывает точку, вместо того чтобы отдать первый попавшийся
    // «ближайший» район за много километров.
    return res.json({
      building: null,
      street: null,
      houseNumber: null,
      microdistrict: null,
      livingArea: null,
      district: null,
      floors: null,
      entrances: null,
      confidence: "district_only" as const,
      outsideCoverage: true,
    });
  }
  try {
    const result = await lookupGeoPoint(lat, lng);
    return res.json({ ...result, outsideCoverage: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logSystemError("api", `geo.lookup(${lat},${lng}): ${message}`, {
      stack: err instanceof Error ? err.stack : undefined,
    });
    return res.status(500).json({ error: "Не удалось определить адрес по точке" });
  }
});

const suggestQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(SUGGEST_MAX_LIMIT).default(SUGGEST_DEFAULT_LIMIT),
});

geoRouter.get("/suggest", requireAuth, async (req, res) => {
  const parsed = suggestQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Нужен параметр q", details: parsed.error.flatten() });
  }
  try {
    const items = await suggestGeoAddress(parsed.data.q, parsed.data.limit);
    return res.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logSystemError("api", `geo.suggest(${parsed.data.q}): ${message}`, {
      stack: err instanceof Error ? err.stack : undefined,
    });
    return res.status(500).json({ error: "Не удалось найти подсказки адреса" });
  }
});

geoRouter.get("/landmarks", requireAuth, async (req, res) => {
  const parsed = lookupQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Нужны координаты lat и lng", details: parsed.error.flatten() });
  }
  const { lat, lng } = parsed.data;
  // За пределами Душанбе справочника ориентиров нет — пустой ответ, а не
  // «ближайший» ориентир за десятки километров.
  if (!isInsideDushanbe(lat, lng)) return res.json({ text: "", landmarks: [] });
  try {
    return res.json(await suggestLandmarks(lat, lng));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logSystemError("api", `geo.landmarks(${lat},${lng}): ${message}`, {
      stack: err instanceof Error ? err.stack : undefined,
    });
    return res.status(500).json({ error: "Не удалось подобрать ориентир" });
  }
});
