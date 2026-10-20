import { Router } from "express";
import {
  landmarkCreateSchema,
  landmarkUpdateSchema,
  landmarkAliasCreateSchema,
  landmarkQuerySchema,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { normalizeGeoText } from "../lib/geoNormalize.js";
import { landmarkCategorySpellings } from "../lib/landmarkCategory.js";
import { logAudit } from "../lib/audit.js";

/**
 * СПРАВОЧНИК ОРИЕНТИРОВ — ВЕДУТ АГЕНТЫ (12.09.2026, docs/geo-match-plan-12-09.md,
 * блок J, решение владельца). Купленный слой (857 записей, prisma/scripts/import-geo.ts)
 * не знает народных названий («ЦУМ», «Садбарг», «Овир» — ноль совпадений), и никогда
 * не будет: он собран из институциональных объектов. Верхний, живой слой ведут агенты
 * прямо из Настроек — этот роут им и служит.
 *
 * ПРАВА. Заводить и править (POST /, PATCH /:id) может любой авторизованный агент —
 * барьер здесь означал бы, что синоним просто не заведут (в этом смысл блока J).
 * Скрыть/удалить (`landmarks.manage`) — только руководитель: справочник общий на
 * всю компанию, и рядовой агент не должен единолично убирать чужую запись из него.
 *
 * ОБРАЗЕЦ УСТРОЙСТВА — routes/districts.ts (права, дедуп по имени, гонка P2002),
 * но landmark ищется ещё и по синонимам (GeoAlias), которых у District нет.
 */
export const landmarksRouter = Router();

landmarksRouter.use(requireAuth);

function serializeLandmark(
  lm: {
    id: string;
    sourceId: string | null;
    name: string;
    category: string;
    address: string | null;
    districtId: string | null;
    lat: unknown;
    lng: unknown;
    enabled: boolean;
    source: string;
    radiusM: number | null;
    createdById: string | null;
    updatedById: string | null;
    updatedAt: Date;
    weight: number;
    mentions: number;
    isCityCenter: boolean;
  },
  aliases: { id: string; text: string }[]
) {
  return {
    id: lm.id,
    name: lm.name,
    category: lm.category,
    address: lm.address,
    districtId: lm.districtId,
    lat: String(lm.lat),
    lng: String(lm.lng),
    enabled: lm.enabled,
    source: lm.source,
    radiusM: lm.radiusM,
    createdById: lm.createdById,
    updatedById: lm.updatedById,
    updatedAt: lm.updatedAt,
    weight: lm.weight,
    mentions: lm.mentions,
    isCityCenter: lm.isCityCenter,
    aliases,
  };
}

/**
 * GET / — поиск по названию И по синонимам, фильтр по категории и по
 * enabled, с пределом выборки и страницами (пагинация обязательна — справочник
 * растёт за счёт агентов, а не только за счёт разовой поставки).
 */
landmarksRouter.get("/", async (req, res) => {
  const parsed = landmarkQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные параметры", details: parsed.error.flatten() });
  }
  const { q, category, showHidden, page, pageSize } = parsed.data;

  const where: Record<string, unknown> = {};
  if (!showHidden) where.enabled = true;
  // insensitive: категория — свободная строка источника (без enum, как у
  // Street.kind), а форма фильтра не обязана повторить регистр один в один.
  // Все написания той же категории («ТЦ» и «Торговый центр») — landmarkCategory.ts.
  if (category) {
    where.AND = [{ OR: landmarkCategorySpellings(category).map((c) => ({ category: { equals: c, mode: "insensitive" } })) }];
  }

  if (q) {
    const normalized = normalizeGeoText(q);
    // Поиск по синонимам — GeoAlias.normalized, та же нормализация, что у
    // geoResolve.ts (единая функция, см. lib/geoNormalize.ts).
    const aliasHits = normalized
      ? await prisma.geoAlias.findMany({
          where: { targetType: "landmark", normalized: { contains: normalized } },
          select: { targetId: true },
        })
      : [];
    const aliasIds = [...new Set(aliasHits.map((a) => a.targetId))];
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      ...(aliasIds.length > 0 ? [{ id: { in: aliasIds } }] : []),
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.landmark.findMany({
      where,
      // id — добивка порядка: одноимённые ориентиры («Школа» в разных районах)
      // иначе перескакивали бы между страницами «Показать ещё».
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.landmark.count({ where }),
  ]);

  const aliasRows =
    rows.length > 0
      ? await prisma.geoAlias.findMany({
          where: { targetType: "landmark", targetId: { in: rows.map((r) => r.id) } },
          select: { id: true, text: true, targetId: true },
          orderBy: { text: "asc" },
        })
      : [];
  const aliasesByLandmark = new Map<string, { id: string; text: string }[]>();
  for (const a of aliasRows) {
    const arr = aliasesByLandmark.get(a.targetId) ?? [];
    arr.push({ id: a.id, text: a.text });
    aliasesByLandmark.set(a.targetId, arr);
  }

  res.json({
    items: rows.map((r) => serializeLandmark(r, aliasesByLandmark.get(r.id) ?? [])),
    total,
    page,
    pageSize,
  });
});

/** POST / — завести ориентир. Любой агент; source="agent" всегда (импорт этот
 *  роут не вызывает). sourceId остаётся пустым — записи агента не имеют "id"
 *  источника, ровно как District.sourceId у старых районов. */
landmarksRouter.post("/", async (req, res) => {
  const parsed = landmarkCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const agentId = req.agent!.id;
  const lm = await prisma.landmark.create({
    data: {
      name: parsed.data.name,
      category: parsed.data.category,
      address: parsed.data.address ?? null,
      districtId: parsed.data.districtId ?? null,
      lat: parsed.data.lat,
      lng: parsed.data.lng,
      radiusM: parsed.data.radiusM ?? null,
      weight: parsed.data.weight ?? 0,
      isCityCenter: parsed.data.isCityCenter ?? false,
      source: "agent",
      createdById: agentId,
      updatedById: agentId,
    },
  });
  logAudit(req, "LANDMARK_CREATE", "Landmark", lm.id, { name: lm.name, category: lm.category });
  res.status(201).json(serializeLandmark(lm, []));
});

/** PATCH /:id — правка названия/категории/радиуса/точки. Любой агент, для
 *  записей любого source (в том числе из купленного слоя — агент вправе
 *  поправить неточную координату импортированного ориентира). */
landmarksRouter.patch("/:id", async (req, res) => {
  const parsed = landmarkUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const existing = await prisma.landmark.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Ориентир не найден" });

  const { name, category, address, districtId, lat, lng, radiusM, weight, isCityCenter } = parsed.data;
  const lm = await prisma.landmark.update({
    where: { id: existing.id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(address !== undefined ? { address } : {}),
      ...(districtId !== undefined ? { districtId } : {}),
      ...(lat !== undefined ? { lat } : {}),
      ...(lng !== undefined ? { lng } : {}),
      ...(radiusM !== undefined ? { radiusM } : {}),
      ...(weight !== undefined ? { weight } : {}),
      ...(isCityCenter !== undefined ? { isCityCenter } : {}),
      updatedById: req.agent!.id,
    },
  });
  logAudit(req, "LANDMARK_UPDATE", "Landmark", lm.id, { name: lm.name });
  res.json(serializeLandmark(lm, []));
});

/** POST /:id/hide — скрыть (enabled=false). Только руководитель. */
landmarksRouter.post("/:id/hide", requirePermission("landmarks.manage"), async (req, res) => {
  const existing = await prisma.landmark.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Ориентир не найден" });
  const lm = await prisma.landmark.update({
    where: { id: existing.id },
    data: { enabled: false, updatedById: req.agent!.id },
  });
  logAudit(req, "LANDMARK_HIDE", "Landmark", lm.id, { name: lm.name });
  res.json(serializeLandmark(lm, []));
});

/** POST /:id/show — вернуть из скрытых. Только руководитель. */
landmarksRouter.post("/:id/show", requirePermission("landmarks.manage"), async (req, res) => {
  const existing = await prisma.landmark.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Ориентир не найден" });
  const lm = await prisma.landmark.update({
    where: { id: existing.id },
    data: { enabled: true, updatedById: req.agent!.id },
  });
  logAudit(req, "LANDMARK_SHOW", "Landmark", lm.id, { name: lm.name });
  res.json(serializeLandmark(lm, []));
});

/**
 * DELETE /:id — только для source="agent". Запись из поставки нельзя удалить
 * НИКОГДА (блок J: следующий импорт её воскресит, скрытие — единственный путь).
 * Только руководитель. Синонимы (GeoAlias, targetType="landmark") удаляются той
 * же транзакцией — без FK на цель они не гаснут сами, и оставленные строки
 * стали бы ровно тем самым «осиротевшим спутником», о котором предупреждает
 * CLAUDE.md (класс дефектов, найденный 07.09.2026).
 */
landmarksRouter.delete("/:id", requirePermission("landmarks.manage"), async (req, res) => {
  const existing = await prisma.landmark.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Ориентир не найден" });
  if (existing.source !== "agent") {
    return res.status(400).json({
      error: "Запись из поставки удалить нельзя — скройте её вместо удаления",
    });
  }
  await prisma.$transaction([
    prisma.geoAlias.deleteMany({ where: { targetType: "landmark", targetId: existing.id } }),
    prisma.landmark.delete({ where: { id: existing.id } }),
  ]);
  logAudit(req, "LANDMARK_DELETE", "Landmark", existing.id, { name: existing.name });
  res.status(204).end();
});

/** POST /:id/aliases — добавить синоним. Любой агент — это главное действие
 *  экрана (блок J: синонимы делают справочник рабочим). */
landmarksRouter.post("/:id/aliases", async (req, res) => {
  const parsed = landmarkAliasCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const landmark = await prisma.landmark.findUnique({ where: { id: req.params.id } });
  if (!landmark) return res.status(404).json({ error: "Ориентир не найден" });

  const normalized = normalizeGeoText(parsed.data.text);
  if (!normalized) {
    return res.status(400).json({ error: "Синоним не должен быть пустым после нормализации" });
  }
  try {
    const alias = await prisma.geoAlias.create({
      data: {
        text: parsed.data.text,
        normalized,
        targetType: "landmark",
        targetId: landmark.id,
        source: "agent",
      },
    });
    await prisma.landmark.update({ where: { id: landmark.id }, data: { updatedById: req.agent!.id } });
    logAudit(req, "LANDMARK_ALIAS_ADD", "Landmark", landmark.id, { name: landmark.name, alias: parsed.data.text });
    res.status(201).json({ id: alias.id, text: alias.text });
  } catch (err) {
    // Гонка/повтор — тот же синоним для того же ориентира уже есть
    // (@@unique([normalized, targetType, targetId]) в GeoAlias).
    if ((err as { code?: string }).code === "P2002") {
      return res.status(409).json({ error: "Такой синоним для этого ориентира уже есть" });
    }
    throw err;
  }
});

/** DELETE /:id/aliases/:aliasId — убрать синоним. Любой агент. */
landmarksRouter.delete("/:id/aliases/:aliasId", async (req, res) => {
  const alias = await prisma.geoAlias.findUnique({ where: { id: req.params.aliasId } });
  if (!alias || alias.targetType !== "landmark" || alias.targetId !== req.params.id) {
    return res.status(404).json({ error: "Синоним не найден" });
  }
  await prisma.geoAlias.delete({ where: { id: alias.id } });
  await prisma.landmark
    .update({ where: { id: req.params.id }, data: { updatedById: req.agent!.id } })
    .catch(() => null); // ориентир мог быть удалён параллельно — не роняем удаление синонима из-за этого
  logAudit(req, "LANDMARK_ALIAS_REMOVE", "Landmark", req.params.id, { alias: alias.text });
  res.status(204).end();
});
