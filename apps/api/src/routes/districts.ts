import { Router } from "express";
import { districtCreateSchema } from "@royal-home/shared";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { findDistrictIdByName } from "../lib/districtLookup.js";

export const districtsRouter = Router();

districtsRouter.get("/", requireAuth, async (_req, res) => {
  const districts = await prisma.district.findMany({ orderBy: { name: "asc" } });
  res.json(districts);
});

districtsRouter.post("/", requireAuth, requirePermission("districts.manage"), async (req, res) => {
  const parsed = districtCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  /**
   * РАЙОНЫ НЕ ДОЛЖНЫ ДВОИТЬСЯ ИЗ-ЗА РЕГИСТРА (аудит №4, 27.08).
   *
   * Фикс 26.08 закрыл только импорт CSV. Голый create здесь означал: менеджер
   * вводит «сино» при существующем «Сино» — и появляется ВТОРОЙ район, между
   * которыми делятся объекты и клиенты, а подбор по району видит половину базы.
   * Точный дубль при этом падал в 500 (P2002) вместо внятного ответа.
   */
  const existingId = await findDistrictIdByName(parsed.data.name);
  const existing = existingId
    ? await prisma.district.findFirst({ where: { id: existingId, city: parsed.data.city } })
    : null;
  if (existing) {
    return res.status(409).json({ error: `Район «${existing.name}» уже есть в справочнике`, district: existing });
  }
  try {
    const district = await prisma.district.create({ data: parsed.data });
    res.status(201).json(district);
  } catch (err) {
    // Гонка двух одновременных созданий — тот же ответ, что и при предпоиске.
    if ((err as { code?: string }).code === "P2002") {
      return res.status(409).json({ error: "Такой район уже есть в справочнике" });
    }
    throw err;
  }
});
