import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { prisma } from "../db.js";
import { fetchSomonPhone } from "../lib/somonLeads/phone.js";
import { SomonSourceUnavailable } from "../lib/somonLeads/sourceClient.js";
import { logSystemError } from "../lib/systemError.js";

export const marketContactRouter = Router();

/**
 * POST /api/v1/market/listing-contact — телефон продавца объявления для кнопки WhatsApp.
 *
 * Somon в списке номер не отдаёт: берём его по клику ОДНИМ запросом той же кнопкой, что и сайт
 * («показать номер»), через общий бюджет запросов к Somon (lib/somonLeads/sourceClient.ts —
 * тот же темп, что у парсера лидов и обхода рынка, блокировку не ловим). Найденный номер
 * кладём в каталог — повторный клик ходит уже в нашу базу. Объявление ищется по ссылке
 * ИЗ НАШЕГО каталога, адрес запроса к сайту строится из сохранённого id, а не из ввода.
 * Номер из публичного объявления, не клиентский: не маскируем (решение владельца 02.11.2026).
 */
const bodySchema = z.object({ sourceUrl: z.string().url().max(600) });

/** Не чаще одного запроса на сотрудника в 3 секунды: защита от залипшей кнопки. */
const lastClickByAgent = new Map<string, number>();
const MIN_GAP_MS = 3000;

marketContactRouter.post("/listing-contact", requireAuth, async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверная ссылка" });

  const agentId = req.agent!.id;
  const now = Date.now();
  if (now - (lastClickByAgent.get(agentId) ?? 0) < MIN_GAP_MS) {
    return res.status(429).json({ error: "Подождите пару секунд", retryAfterSec: 3 });
  }
  lastClickByAgent.set(agentId, now);

  const listing = await prisma.marketListing.findFirst({
    where: { sourceUrl: parsed.data.sourceUrl },
    select: { id: true, source: true, sourceId: true, sellerPhone: true },
  });
  if (!listing) return res.status(404).json({ error: "Объявление не найдено в каталоге" });
  if (listing.sellerPhone) return res.json({ phone: listing.sellerPhone, cached: true });

  if (listing.source !== "somon.tj") {
    // Paydo номер в списке не показывает — открывается на сайте.
    return res.json({ phone: null, reason: "open_on_site" });
  }

  try {
    const phone = await fetchSomonPhone(listing.sourceId);
    if (!phone) return res.json({ phone: null, reason: "no_phone" });
    await prisma.marketListing.update({ where: { id: listing.id }, data: { sellerPhone: phone } });
    return res.json({ phone, cached: false });
  } catch (err) {
    if (err instanceof SomonSourceUnavailable && err.reason === "not_ready") {
      return res.status(429).json({ error: "Сайт сейчас занят, нажмите ещё раз через несколько секунд", retryAfterSec: 12 });
    }
    void logSystemError("api", `Номер объявления Somon не получен: ${err instanceof SomonSourceUnavailable ? `${err.reason} ${err.status ?? ""}` : "ошибка"}`);
    return res.status(502).json({ error: "Не удалось получить номер — откройте объявление на сайте" });
  }
});
