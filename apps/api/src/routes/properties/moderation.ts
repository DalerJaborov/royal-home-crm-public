/** Модерация материалов: POST /:id/regenerate-caption,
 * POST /:id/review/approve|reject, POST /bulk-sync (Г3, §1.3).
 *
 * Маршруты второй модерации автомонтажа (/:id/auto-montage/*) удалены
 * 04.09.2026 вместе со всем автомонтажом: готовый ролик теперь приходит от
 * монтажёра (lib/videoHandoff.ts) и публикуется сразу, без второго круга. */
import { Router } from "express";
import { z } from "zod";
import { bulkSiteSyncSchema, sendBackToMontajerSchema, voiceNoteUrlSchema } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { requireAuth, requirePermission } from "../../auth/middleware.js";
import { isPipelineStatus } from "../../lib/propertyPipeline.js";
import { approveReviewMaterial, rejectReview } from "../../lib/propertyReview.js";
import { approveClip, rejectClip } from "../../lib/clipReview.js";
import { syncPropertiesToSite } from "../../lib/siteSync.js";
import { logAudit } from "../../lib/audit.js";
import { reelsCaptionValuesFromProperty, withPostFooter } from "../../lib/reelsCaptionTemplate.js";
import { loadMoneyContext } from "../../lib/money.js";
import { generateReelsCaptionWithAi } from "../../ai/reelsCaptionAi.js";
import { canManageProperty } from "./shared.js";
import { presentProperty } from "../../lib/ownerContact.js";

import { publishPropertyUpdated } from "../../lib/livePublish.js";

export const moderationRouter = Router();

/**
 * «Перегенерировать» подпись под Reels — начало и конец живым текстом от Gemini
 * (владелец, 16.09.2026), заново на каждый клик, по АКТУАЛЬНЫМ данным карточки
 * на момент нажатия (не по тем, что были при создании) — решает и старую
 * проблему, из-за которой цена/площадь могли поменяться после создания, а
 * сохранённая подпись молча устаревала. Откажет ИИ — прежний бесплатный
 * шаблон, см. ai/reelsCaptionAi.ts.
 */
moderationRouter.post(
  "/:id/regenerate-caption",
  requireAuth,
  requirePermission("properties.aiListing"),
  async (req, res) => {
    const property = await prisma.property.findUnique({
      where: { id: req.params.id },
      include: { district: true },
    });
    if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден" });

    const [settings, responsible, money] = await Promise.all([
      prisma.settings.findUnique({ where: { id: "singleton" }, select: { reelsCaptionTemplates: true } }),
      prisma.agent.findUnique({
        where: { id: property.intakeAgentId ?? property.assignedAgentId ?? property.createdById ?? "" },
        select: { phone: true, fullName: true },
      }),
      loadMoneyContext(),
    ]);

    const reelsCaption = await generateReelsCaptionWithAi(
      reelsCaptionValuesFromProperty({
        type: property.type,
        rooms: property.rooms,
        areaSqm: property.areaSqm,
        floor: property.floor,
        totalFloors: property.totalFloors,
        price: property.price,
        currency: property.currency,
        condition: property.condition,
        stage: property.stage ?? null,
        marketType: property.marketType ?? null,
        districtName: property.district?.name ?? "Душанбе",
        phone: responsible?.phone ?? null,
        agentName: responsible?.fullName ?? null,
        address: property.address,
        documents: property.documents,
        windowCount: property.windowCount,
        details: property.details,
        landAreaSotka: property.landAreaSotka,
        amenities: property.amenities,
        // Цена в сомони рядом с долларами (владелец, 17.09.2026).
        money,
      }),
      settings?.reelsCaptionTemplates
    );

    const updated = await prisma.property.update({
      where: { id: property.id },
      data: { reelsCaption: withPostFooter(reelsCaption, property.shortId) },
    });
    res.json({ reelsCaption: updated.reelsCaption });
  }
);

const reviewMaterialSchema = z.enum(["photos", "video"]);

/**
 * «Одобрить фото» / «Одобрить видео» — кнопки конвейера вместо выпадающего списка
 * статусов (спецификация, Этап 6: «Фотографии соответствуют → «Фотографии
 * одобрены»»). Раздельно по материалу: один может быть готов раньше другого.
 * Когда одобрены ОБА — объект уходит в EDITING (монтаж), не раньше.
 */
moderationRouter.post("/:id/review/approve", requireAuth, requirePermission("properties.moderate"), async (req, res) => {
  const parsed = z.object({ material: reviewMaterialSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  // Тело решения — lib/propertyReview.ts: тем же путём идёт модерация из Telegram.
  const result = await approveReviewMaterial(req.params.id, parsed.data.material, { agentId: req.agent!.id, source: "crm" });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(presentProperty(result.property, req));
});

const reviewRejectSchema = z.object({
  material: reviewMaterialSchema,
  reason: z.string().min(1).max(500),
  reasonVoiceUrl: voiceNoteUrlSchema.nullable().optional(),
  reasonVoiceTranscript: z.string().max(4000).nullable().optional(),
});

/**
 * «Запросить новые фото» / «Запросить новое видео» — возврат агенту на доработку
 * (спецификация: статус «Ожидание новых фотографий»/«Ожидание нового видео»).
 * Причина обязательна: агент должен понимать, что именно переснять.
 * Тело — lib/propertyReview.ts (общее с Telegram).
 */
moderationRouter.post("/:id/review/reject", requireAuth, requirePermission("properties.moderate"), async (req, res) => {
  const parsed = reviewRejectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  const result = await rejectReview(req.params.id, parsed.data, { agentId: req.agent!.id, source: "crm" });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(presentProperty(result.property, req));
});

/**
 * ПРОВЕРКА ГОТОВОГО РОЛИКА (25.09.2026, lib/clipReview.ts) — те же решения, что
 * кнопки в Telegram: «Одобрить и запланировать» ставит ролик в расписание,
 * «Вернуть монтажёру» — существующий возврат с причиной (sendBackToMontajer).
 * Право — как у модерации объектов.
 */
moderationRouter.post("/:id/clip-review/approve", requireAuth, requirePermission("properties.moderate"), async (req, res) => {
  const result = await approveClip(req.params.id, req.agent!.id, "crm");
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({
    ok: true,
    scheduledPublishAt: result.scheduledPublishAt?.toISOString() ?? null,
    notPublishingReason: result.notPublishingReason ?? null,
  });
});

moderationRouter.post("/:id/clip-review/reject", requireAuth, requirePermission("properties.moderate"), async (req, res) => {
  // Та же схема, что у «Вернуть монтажёру», с тем же правилом «для этой причины
  // нужен комментарий»; замена исходника и снятие из сетей — в полном окне возврата.
  const parsed = sendBackToMontajerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Неверные данные" });
  const result = await rejectClip(req.params.id, {
    reason: parsed.data.reason,
    comment: parsed.data.comment ?? null,
    byId: req.agent!.id,
    source: "crm",
  });
  if (!result.ok) return res.status(409).json({ error: result.error });
  res.json(result);
});

/** Publishes/unpublishes one or many properties on the site in one call —
 * backs both the single-object buttons and the list's bulk action.
 * ADMIN/DIRECTOR only: публикация на публичный сайт — не решение рядового агента. */
moderationRouter.post("/bulk-sync", requireAuth, requirePermission("properties.publish"), async (req, res) => {
  const parsed = bulkSiteSyncSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const { ids, action } = parsed.data;

  const properties = await prisma.property.findMany({
    // deletedAt — объект из Корзины публиковать нельзя: на сайте появился бы листинг,
    // которого в CRM уже нет ни в одном списке и который никто не найдёт, чтобы снять.
    // id из Корзины вполне рабочие (GET /trash их отдаёт админу).
    where: { id: { in: ids }, deletedAt: null },
    include: { district: true, photos: { orderBy: { order: "asc" } } },
  });
  if (properties.length === 0) {
    return res.status(404).json({ error: "Объекты не найдены" });
  }

  /**
   * ПООБЪЕКТНАЯ ПРОВЕРКА ПРАВ (аудит №4, 27.08).
   *
   * Роут был защищён только правом properties.publish — а это обычное
   * выдаваемое право, не директорское. Сотрудник, которому его делегировали
   * (ровно ради чего гибкая система прав и сделана), мог одним запросом снять
   * с сайта пачку ЧУЖИХ живых объявлений или опубликовать не свои: пообъектного
   * барьера, как у PATCH/фото/видео (canManageProperty), здесь не было.
   */
  const foreign = properties.filter((p) => !canManageProperty(req, p));
  if (foreign.length > 0) {
    return res.status(403).json({
      error: `Нет прав на объекты: ${foreign.map((p) => `№${p.shortId}`).join(", ")}`,
    });
  }

  // Несайтовые объекты (offSite) на сайт не идут никогда — инвариант из
  // docs/plan-18-08-private-listings-and-video.md §1, та же проверка, что и в
  // siteSync.ts (второй слой, на случай если этот роут когда-нибудь обойдут другим
  // вызывающим кодом). Снятие с публикации тут бессмысленно — offSite объект и так
  // никогда не был опубликован — но явная ошибка понятнее тихого отказа.
  if (action === "publish") {
    const offSiteOnes = properties.filter((p) => p.offSite);
    if (offSiteOnes.length > 0) {
      return res.status(409).json({
        error:
          `Несайтовый объект нельзя опубликовать на сайте: ${offSiteOnes.map((p) => `№${p.shortId}`).join(", ")}. ` +
          "Такие объекты доступны клиенту только по приватной ссылке.",
      });
    }
  }

  // Недоготовленный объект на публичный сайт не выпускаем: сайт видят посторонние,
  // и объявление без фотографий и видео-обзора — это не «черновик у нас в CRM», а
  // испорченное впечатление о компании. Снятие с публикации (unpublish) при этом
  // разрешено всегда: убрать лишнее нельзя запрещать никогда.
  if (action === "publish") {
    const notReady = properties.filter((p) => isPipelineStatus(p.status));
    if (notReady.length > 0) {
      return res.status(409).json({
        error:
          `Ещё готовятся, публиковать рано: ${notReady.map((p) => `№${p.shortId}`).join(", ")}. ` +
          "Объект выходит на сайт после последнего этапа — видео-обзора в Instagram и ссылки на него в карточке.",
      });
    }
  }

  // СНЯТЫЙ С ПРОДАЖИ ИЛИ ЗАРЕЗЕРВИРОВАННЫЙ ОБЪЕКТ НА САЙТ НЕ ВЫХОДИТ (ночная
  // проверка 24.09.2026, №129). isPipelineStatus выше ловит только конвейер
  // подготовки (до AVAILABLE) — WITHDRAWN и RESERVED в него не входят, и
  // кнопка/массовая публикация раньше пускали их на сайт как продаваемые:
  // собственник уже забрал квартиру (WITHDRAWN) или она уже под задатком
  // (RESERVED), а объявление всё равно появлялось. SOLD сюда не входит —
  // проданный объект публикуется с плашкой «Продано» намеренно (см. sold в
  // siteSync.ts), это отдельный, разрешённый случай.
  if (action === "publish") {
    const notSellable = properties.filter((p) => p.status === "WITHDRAWN" || p.status === "RESERVED");
    if (notSellable.length > 0) {
      return res.status(409).json({
        error:
          `Не в продаже, публиковать нельзя: ${notSellable.map((p) => `№${p.shortId}`).join(", ")}. ` +
          "Объект снят с продажи или зарезервирован.",
      });
    }
  }

  const result = await syncPropertiesToSite(properties, action);
  if (!result.ok) {
    // Не 502/503/504 — Cloudflare подменяет тело таких ответов своей типовой
    // страницей об ошибке, и понятное сообщение (валюта в USD, нет фото и т.п.)
    // до фронтенда никогда не доходило, вместо него рендерился сырой HTML Cloudflare.
    return res.status(400).json({ error: result.error });
  }

  const okIds = result.results.filter((r) => r.ok).map((r) => r.externalId);
  if (okIds.length > 0) {
    await prisma.property.updateMany({
      where: { id: { in: okIds } },
      data: { publishedOnSite: action === "publish" },
    });
    // Одиночный объект (обычная кнопка «Опубликовать на сайт» на карточке) — кладём
    // его shortId/title, чтобы в Архиве запись была кликабельной с названием объекта,
    // а не просто «1 шт.» без единой зацепки. Массовая публикация — оставляем список id.
    const okProperty = okIds.length === 1 ? properties.find((p) => p.id === okIds[0]) : undefined;
    // ids кладём ВСЕГДА, а shortId/title — дополнительно для одиночной публикации.
    // Раньше при публикации одного объекта (обычная кнопка на карточке — основной
    // сценарий) массива ids в meta не было вовсе, а KPI читает публикации именно по
    // нему (kpi.ts, метрики «фото» и «видео»). Из-за этого 20 баллов из 100 не
    // начислялись никому и никогда, кроме случаев массовой публикации 2+ объектов.
    logAudit(
      req,
      action === "publish" ? "PUBLISH" : "UNPUBLISH",
      "Property",
      okProperty?.id ?? null,
      { ids: okIds, ...(okProperty ? { shortId: okProperty.shortId, title: okProperty.title } : {}) }
    );
  }

  // externalId — это id объекта в CRM (см. siteSync.ts), а `id` в ответе сайта —
  // номер объявления у него, к нашим ключам отношения не имеющий.
  for (const id of okIds) publishPropertyUpdated({ propertyId: id, actorId: req.agent!.id });
  res.json({ results: result.results });
});
