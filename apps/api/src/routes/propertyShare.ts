import { Router } from "express";
import { PROPERTY_PIPELINE_STATUSES } from "@royal-home/shared";
import { prisma } from "../db.js";
import { recordInterest } from "../lib/propertyInterest.js";
import { siteHomeUrl, siteListingUrl } from "../lib/siteListingUrl.js";
import { crmPublicBase } from "../lib/crmPublicUrl.js";

/**
 * Публичная приватная ссылка на объект (docs/plan-18-08-private-listings-and-video.md
 * §4) — единственный способ показать offSite-объект клиенту: без входа в CRM, без
 * общего списка/AI-подбора. БЕЗ requireAuth намеренно: клиент, которому агент прислал
 * ссылку, никогда не был и не будет пользователем CRM. Безопасность держится только
 * на неугадываемости token (24 случайных байта, см. POST /properties/:id/share-links) —
 * тот же компромисс, что и у /uploads и /api/v1/media (см. их комментарии).
 *
 * Отдельным роутером, а не внутри propertiesRouter: тот целиком висит на requireAuth
 * в остальных маршрутах, и класть один публичный путь посреди приватных — верный
 * способ случайно унаследовать чужую проверку прав при следующей правке рядом.
 */
export const propertyShareRouter = Router();

/**
 * Первый просмотр — «открыл/не открыл» в списке ссылок карточки объекта. Повторные
 * просмотры метку не двигают: важен сам факт, что клиент увидел объект хоть раз.
 * Одна функция на оба входа (страница ссылки и переход из СМС), чтобы метка не
 * зависела от того, каким путём клиент пришёл.
 */
async function markOpened(link: { id: string; viewedAt: Date | null; propertyId: string; clientId: string | null }) {
  if (link.viewedAt) return;
  await prisma.propertyShareLink.update({ where: { id: link.id }, data: { viewedAt: new Date() } });
  // Открытая клиентом ссылка — сигнал сильнее отправленной: интерес проявил сам
  // человек, а не агент за него (lib/propertyInterest.ts).
  void recordInterest(link.propertyId, "SHARE_OPENED", link.clientId);
}

/**
 * ПЕРЕХОД ИЗ СМС (23.09.2026): GET /l/:token/go → 302.
 *
 * Опубликованный объект — на его страницу на сайте royalhome.tj (фото, ролик
 * Instagram под ними, карта), как просил владелец. Несайтовый — на страницу
 * приватной ссылки в самой CRM: на сайте его нет. Недействительная ссылка — на
 * главную сайта, а не на голый JSON с ошибкой: её открывает клиент с телефона.
 *
 * Редирект сервером, а не страницей CRM: клиент из СМС не должен грузить всё
 * приложение CRM ради того, чтобы его перекинули на сайт.
 */
propertyShareRouter.get("/:token/go", async (req, res) => {
  const link = await prisma.propertyShareLink.findUnique({
    where: { token: req.params.token },
    include: {
      property: { select: { id: true, deletedAt: true, publishedOnSite: true, siteListingId: true, offSite: true } },
    },
  });
  const alive =
    link && !link.revokedAt && !(link.expiresAt && link.expiresAt.getTime() < Date.now()) && link.property && !link.property.deletedAt;
  if (!link || !alive) return res.redirect(302, siteHomeUrl());

  await markOpened(link);
  const onSite = link.property.offSite ? null : siteListingUrl(link.property);
  if (onSite) return res.redirect(302, onSite);
  const base = crmPublicBase() ?? "";
  res.redirect(302, `${base}/l/${encodeURIComponent(link.token)}`);
});

const AGENT_CONTACT = { fullName: true, phone: true, isActive: true, frozenAt: true } as const;

type AgentContact = { fullName: string; phone: string; isActive: boolean; frozenAt: Date | null };

/**
 * КОМУ ЗВОНИТЬ С ПУБЛИЧНОЙ ССЫЛКИ (аудит 23.09.2026, №61). Ссылка живёт неделями,
 * а агент, который её прислал, за это время может уволиться или быть
 * замороженным — клиент звонил на номер человека, который в агентстве уже не
 * работает. Сначала автор ссылки, если он в строю; иначе нынешний ответственный
 * за объект; никого — кнопку звонка не показываем вовсе.
 */
export function shareContactAgent(createdBy: AgentContact | null, assigned: AgentContact | null) {
  const pick = [createdBy, assigned].find((a) => a && a.isActive && !a.frozenAt);
  return pick ? { fullName: pick.fullName, phone: pick.phone } : null;
}

/**
 * Что сказать клиенту о продаже. Раньше было только «Продано»/«В продаже», и
 * снятый с продажи или уже забронированный объект по ссылке выглядел свободным.
 *
 * «СКОРО В ПРОДАЖЕ» (решение владельца 02.10.2026, «да, по советам», глубокая
 * проверка D16): объект ещё готовится — проверка, фото, видео, монтаж
 * (PROPERTY_PIPELINE_STATUSES) — и клиенту не обещаем «В продаже», но и не
 * пугаем «Снят с продажи». Раньше любой этап подготовки отдавал AVAILABLE.
 */
export function shareSaleStatus(status: string): "AVAILABLE" | "SOON" | "RESERVED" | "SOLD" | "UNAVAILABLE" {
  if (status === "SOLD") return "SOLD";
  if (status === "RESERVED") return "RESERVED";
  if (status === "WITHDRAWN") return "UNAVAILABLE";
  if ((PROPERTY_PIPELINE_STATUSES as readonly string[]).includes(status)) return "SOON";
  return "AVAILABLE";
}

propertyShareRouter.get("/:token", async (req, res) => {
  const link = await prisma.propertyShareLink.findUnique({
    where: { token: req.params.token },
    include: {
      property: {
        include: {
          district: { select: { name: true, city: true } },
          photos: { orderBy: { order: "asc" }, select: { url: true, thumbUrl: true } },
          assignedAgent: { select: AGENT_CONTACT },
        },
      },
      createdByAgent: { select: AGENT_CONTACT },
    },
  });

  if (!link || link.revokedAt) return res.status(404).json({ error: "Ссылка не найдена" });
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) {
    return res.status(404).json({ error: "Ссылка больше не действует" });
  }
  const property = link.property;
  if (!property || property.deletedAt) return res.status(404).json({ error: "Ссылка не найдена" });

  await markOpened(link);

  // РУЧНОЙ отбор полей — сознательно, а не spread(property): это единственный
  // публичный, неаутентифицированный маршрут во всей карточке объекта. Ни
  // ownerContact (контакт продавца), ни assignedAgentId/intakeAgentId/createdById,
  // ни служебные заметки/документы, ни данные другого клиента сюда попасть не
  // должны — spread унаследовал бы их молча при первом же новом поле Property.
  res.json({
    property: {
      title: property.title,
      type: property.type,
      rooms: property.rooms,
      areaSqm: property.areaSqm,
      // Точный этаж и адрес (улица, дом) сюда НЕ попадают — находка ночной
      // проверки 24.09.2026 (№9): публичная ссылка без входа в систему отдавала
      // то, чего не показывает даже сайт агентства (site: crmPublicBase()`toSitePayload`
      // в lib/siteSync.ts шлёт только `district, city`, без floor/totalFloors и
      // без адреса). Решение владельца — сравнять с сайтом: район/город остаются,
      // точный адрес и этаж убраны целиком (этажность дома тоже нигде не публична,
      // поэтому не оставляем и её).
      price: property.price,
      currency: property.currency,
      district: property.district?.name ?? null,
      city: property.district?.city ?? null,
      condition: property.condition,
      amenities: property.amenities,
      description: property.description,
      photos: property.photos,
      clipVideoUrl: property.clipVideoStatus === "READY" ? property.clipVideoUrl : null,
      // Разведка 07.09.2026 (класс «осиротевшие спутники»): ссылка на проданный
      // объект отдавала карточку с ценой без единой пометки — клиент, которому
      // прислали ссылку до продажи, узнавал о продаже только позвонив агенту.
      sold: property.status === "SOLD",
      saleStatus: shareSaleStatus(property.status),
    },
    agent: shareContactAgent(link.createdByAgent, property.assignedAgent),
  });
});
