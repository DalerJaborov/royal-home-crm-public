/**
 * ВКЛАДКА «СТАТИСТИКА» В КАРТОЧКЕ ОБЪЕКТА (24.09.2026) — lib/propertyStats.ts.
 *
 *  GET /properties/:id/stats            — светофор, путь покупателя, соседи,
 *                                         сайт по дням, «загорелся»; своя база;
 *  GET /properties/:id/stats/platforms  — числа роликов с площадок, по сети.
 *
 * Права — те же, что у самой карточки (GET /:id в list.ts): открыта всем
 * вошедшим, удалённый объект — только тем, кому открыта Корзина. Наружу идут
 * только числа, ни одного имени или телефона клиента.
 */
import { Router } from "express";
import { can, requireAuth, scopeDealsToOwnAgent, scopeToOwnAgent } from "../../auth/middleware.js";
import { prisma } from "../../db.js";
import { cardWhereFromParam } from "../../lib/cardIdParam.js";
import { loadHealthBatch, loadNeedsHelp, loadPropertyPlatforms, loadPropertyStats } from "../../lib/propertyStats.js";
import { loadPropertyVoice } from "../../lib/propertyVoice/loadPropertyVoice.js";
import { loadPriceAdvice } from "../../lib/loadPriceAdvice.js";
import { loadPriceWaitlist } from "../../lib/priceWaitlist.js";
import { clientNamePhoneSafe } from "../../lib/clientPhone.js";
import { PROPERTIES_HEALTH_MAX_IDS, type PriceWaitlistResponse, type PropertiesHealthResponse } from "@royal-home/shared";
import { z } from "zod";
import { logSystemError } from "../../lib/systemError.js";
import type { Request } from "express";

export const statsRouter = Router();

/** id объекта, если карточку можно показать этому человеку; иначе null. */
async function visiblePropertyId(req: Request): Promise<string | null> {
  const where = cardWhereFromParam(String(req.params.id));
  if (!where) return null;
  const p = await prisma.property.findUnique({ where, select: { id: true, deletedAt: true } });
  if (!p) return null;
  if (p.deletedAt && !can(req, "archive.view")) return null;
  return p.id;
}

statsRouter.get("/:id/stats", requireAuth, async (req, res) => {
  const id = await visiblePropertyId(req);
  if (!id) return res.status(404).json({ error: "Объект не найден" });
  try {
    const stats = await loadPropertyStats(id);
    if (!stats) return res.status(404).json({ error: "Объект не найден" });
    res.json(stats);
  } catch (err) {
    void logSystemError("api", `Статистика объекта не посчитана: ${err instanceof Error ? err.message : String(err)}`, {
      dedupKey: "property-stats",
    });
    res.status(500).json({ error: "Не удалось посчитать статистику объекта" });
  }
});

statsRouter.get("/:id/stats/platforms", requireAuth, async (req, res) => {
  const id = await visiblePropertyId(req);
  if (!id) return res.status(404).json({ error: "Объект не найден" });
  try {
    res.json(await loadPropertyPlatforms(id));
  } catch (err) {
    void logSystemError("api", `Числа площадок для объекта не получены: ${err instanceof Error ? err.message : String(err)}`, {
      dedupKey: "property-stats-platforms",
    });
    res.status(502).json({ error: "Площадки сейчас не отвечают — попробуйте позже" });
  }
});

/**
 * GET /properties/:id/voice — «ПОРТРЕТ ОБЪЕКТА / ГОЛОС РЫНКА» (03.10.2026,
 * lib/propertyVoice/): что говорят про объект в чатах, комментариях, звонках, на
 * показах; воронка интереса, торг, реклама. Форма ответа — PropertyVoiceResponse
 * (packages/shared/src/propertyVoice.ts).
 *
 * Права: те же, что у карточки (visiblePropertyId). Раздел `showingFeedback`
 * (звонки-опросы покупателей после показа) — ТОЛЬКО с правом директора
 * `dashboard.analytics`, как весь /oversight: по замыслу агент его не видит, и без
 * права данные не читаются из базы вообще. Тексты клиентов приходят с закрытыми
 * телефонами.
 *
 * ДЕНЬГИ И СДЕЛКИ — ПО ПРАВАМ ЭКРАНОВ-ИСТОЧНИКОВ (аудит «голоса рынка» 03.10.2026): карточку
 * видит и агент, и монтажёр, а суммы рекламы и цены чужих сделок им закрыты в своих роутах.
 *  • реклама — `finance.view` или роль MARKETING (как GET /ads/property/:id, «ДЕНЬГИ — ПО ПРАВУ»);
 *  • сделки — без `deals.viewAll` только свои (scopeDealsToOwnAgent, как на экране «Сделки»);
 *    цена продажи — с `finance.view` или у своей сделки (seesDealMoney в routes/deals.ts).
 */
statsRouter.get("/:id/voice", requireAuth, async (req, res) => {
  const id = await visiblePropertyId(req);
  if (!id) return res.status(404).json({ error: "Объект не найден" });
  try {
    const agent = req.agent!;
    const voice = await loadPropertyVoice(id, {
      canSeeShowingFeedback: can(req, "dashboard.analytics"),
      canSeeAdMoney: agent.role === "MARKETING" || can(req, "finance.view"),
      dealsOwnAgentId: scopeDealsToOwnAgent(req) ?? null,
      canSeeAllDealMoney: can(req, "finance.view"),
      viewerId: agent.id,
    });
    if (!voice) return res.status(404).json({ error: "Объект не найден" });
    res.json(voice);
  } catch (err) {
    void logSystemError("api", `«Голос рынка» по объекту не собран: ${err instanceof Error ? err.message : String(err)}`, {
      dedupKey: "property-voice",
    });
    res.status(500).json({ error: "Не удалось собрать «голос рынка» по объекту" });
  }
});

/** Имя клиента без номера, если у человека нет права `clients.viewPhone` (у заведённых до 20.08.2026 номер лежит в имени). */
function maskWaitlistClients(req: Request, waitlist: PriceWaitlistResponse): PriceWaitlistResponse {
  const canSeePhone = can(req, "clients.viewPhone");
  return {
    ...waitlist,
    visibleClients: waitlist.visibleClients.map((c) => ({ ...c, fullName: clientNamePhoneSafe(c.fullName, canSeePhone) })),
  };
}

/**
 * GET /properties/:id/price-waitlist — «ЛИСТ ОЖИДАНИЯ ПО ЦЕНЕ» (03.10.2026, lib/priceWaitlist.ts):
 * «если цена будет не выше X, подходят N клиентов». Форма — PriceWaitlistResponse (packages/shared/src/priceAdvisor.ts).
 *
 * Права: те же, что у карточки (visiblePropertyId). Ступени и счётчики — ТОЛЬКО числа по всей базе ждущих
 * покупателей (имён и телефонов в них нет). Конкретные клиенты (`visibleClients`) — только те, кого этот человек
 * и так видит: без `clients.viewAll` — закреплённые за ним (scopeToOwnAgent, как список клиентов), с ним — все;
 * имя без права `clients.viewPhone` приходит с закрытым номером (у заведённых до 20.08.2026 он лежит в имени).
 */
statsRouter.get("/:id/price-waitlist", requireAuth, async (req, res) => {
  const id = await visiblePropertyId(req);
  if (!id) return res.status(404).json({ error: "Объект не найден" });
  try {
    const waitlist = await loadPriceWaitlist(id, { visibleToAgentId: scopeToOwnAgent(req) });
    if (!waitlist) return res.status(404).json({ error: "Объект не найден" });
    res.json(maskWaitlistClients(req, waitlist));
  } catch (err) {
    void logSystemError("api", `Лист ожидания по цене не собран: ${err instanceof Error ? err.message : String(err)}`, {
      dedupKey: "property-price-waitlist",
    });
    res.status(500).json({ error: "Не удалось собрать лист ожидания по цене" });
  }
});

/**
 * GET /properties/:id/price-advice — «СОВЕТ ПО ЦЕНЕ» и температура объекта (03.10.2026, lib/priceAdvice.ts,
 * lib/propertyHeat.ts). Отдельный путь, а не поле `/voice`: «голос рынка» тяжёлый и уже отдаёт форму с
 * правами директора (опросы после показа), а совету нужно одинаковое для всех содержание без них и без денег
 * рекламы — аддитивно и без риска изменить договор `/voice`. Права — как у карточки. Форма — PriceAdviceResponse.
 *
 * ЛЕСТНИЦА ВНУТРИ ОТВЕТА (`waitlist`): лист ожидания (до 500 клиентов) считается ОДИН раз — для совета и для
 * экрана; карточка больше не зовёт `/price-waitlist` параллельно. Права те же, что у того роута: клиенты
 * `visibleClients` — по `scopeToOwnAgent` (агент — только свои), имя — с маской номера. Сам `/price-waitlist` остаётся.
 */
statsRouter.get("/:id/price-advice", requireAuth, async (req, res) => {
  const id = await visiblePropertyId(req);
  if (!id) return res.status(404).json({ error: "Объект не найден" });
  try {
    const result = await loadPriceAdvice(id, {
      dealsOwnAgentId: scopeDealsToOwnAgent(req) ?? null,
      viewerId: req.agent!.id,
      visibleToAgentId: scopeToOwnAgent(req),
    });
    if (!result) return res.status(404).json({ error: "Объект не найден" });
    res.json({ ...result, waitlist: result.waitlist ? maskWaitlistClients(req, result.waitlist) : null });
  } catch (err) {
    void logSystemError("api", `Совет по цене не собран: ${err instanceof Error ? err.message : String(err)}`, {
      dedupKey: "property-price-advice",
    });
    res.status(500).json({ error: "Не удалось собрать совет по цене" });
  }
});

/**
 * СВЕТОФОР СПИСКОМ (24.09.2026) — одним словом-путём, поэтому свой роутер,
 * подключаемый ДО listRouter: иначе «health» ушло бы в GET /:id как номер.
 *
 *  GET /properties/health?ids=a,b,c  — точка у каждого объекта страницы каталога;
 *  GET /properties/needs-help        — «Объекты, которым нужна помощь» в «Обзоре».
 */
export const propertiesHealthRouter = Router();

const healthQuerySchema = z.object({
  ids: z
    .string()
    .transform((v) => [...new Set(v.split(",").map((x) => x.trim()).filter(Boolean))])
    .pipe(z.array(z.string().uuid()).min(1).max(PROPERTIES_HEALTH_MAX_IDS)),
});

propertiesHealthRouter.get("/health", requireAuth, async (req, res) => {
  const parsed = healthQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Нужен список объектов (ids), не больше 100" });
  try {
    const batch = await loadHealthBatch(parsed.data.ids);
    const body: PropertiesHealthResponse = {};
    for (const [id, h] of batch) body[id] = { color: h.color, headline: h.headline, tip: h.tip };
    res.json(body);
  } catch (err) {
    void logSystemError("api", `Светофор списка не посчитан: ${err instanceof Error ? err.message : String(err)}`, {
      dedupKey: "properties-health",
    });
    res.status(500).json({ error: "Не удалось посчитать светофор" });
  }
});

propertiesHealthRouter.get("/needs-help", requireAuth, async (_req, res) => {
  try {
    res.json(await loadNeedsHelp());
  } catch (err) {
    void logSystemError("api", `«Объекты, которым нужна помощь» не посчитаны: ${err instanceof Error ? err.message : String(err)}`, {
      dedupKey: "properties-needs-help",
    });
    res.status(500).json({ error: "Не удалось собрать объекты, которым нужна помощь" });
  }
});
