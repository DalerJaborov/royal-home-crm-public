import { Router } from "express";
import { z } from "zod";
import type { Request } from "express";
import { Prisma } from "../generated/prisma/client.js";
import { can, requireAuth } from "../auth/middleware.js";
import { prisma } from "../db.js";
import { PHONE_TAIL_LEN, phoneTail } from "../lib/clientPhones.js";
import { extractPhoneTails } from "../lib/market/ownMatch.js";
import { stripOwnerContact } from "../lib/ownerContact.js";
import { fetchSomonPhoneInteractive } from "../lib/somonLeads/phone.js";
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
 * Номер из публичного объявления, не клиентский: не маскируем (решение владельца 02.11.2026) —
 * КРОМЕ одного случая: номер совпал с контактом владельца нашего объекта, а у сотрудника нет
 * доступа к этому контакту (lib/ownerContact.ts). Тогда 403: объявление не должно становиться
 * обходным путём к закрытому телефону. Номер хранится и отдаётся единым видом +992XXXXXXXXX —
 * именно такой вид ищет сверка в lib/market/ownMatch.ts.
 */
const bodySchema = z.object({ sourceUrl: z.string().url().max(600) });

/** Не чаще одного запроса на сотрудника в 3 секунды: защита от залипшей кнопки. */
const lastClickByAgent = new Map<string, number>();
const MIN_GAP_MS = 3000;

/** Единый вид номера: +992 и девять цифр. Меньше девяти цифр — это не номер. */
export function normalizeListingPhone(raw: string): string | null {
  const tail = phoneTail(raw);
  return tail.length === PHONE_TAIL_LEN ? `+992${tail}` : null;
}

/**
 * Закрыт ли этому сотруднику хотя бы один наш объект, чей контакт владельца содержит этот номер.
 * Кандидатов ищем одним запросом по цифрам контакта, затем сверяем хвосты в коде (склейка цифр
 * двух номеров рядом не должна давать ложных срабатываний).
 */
async function phoneBelongsToHiddenOwner(req: Request, normalized: string): Promise<boolean> {
  const tail = phoneTail(normalized);
  const rows = await prisma.$queryRaw<
    Array<{ ownerContact: string | null; assignedAgentId: string | null; intakeAgentId: string | null; createdById: string | null }>
  >(Prisma.sql`
    SELECT "ownerContact", "assignedAgentId", "intakeAgentId", "createdById"
    FROM "Property"
    WHERE "deletedAt" IS NULL
      AND "ownerContact" IS NOT NULL
      AND regexp_replace("ownerContact", '[^0-9]', '', 'g') LIKE ${`%${tail}%`}
    LIMIT 50
  `);
  const supervisor = can(req, "properties.viewOwners");
  return rows.some(
    (r) => extractPhoneTails(r.ownerContact).includes(tail) && stripOwnerContact(r, req.agent!.id, supervisor).ownerContactHidden,
  );
}

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
  const stored = listing.sellerPhone ? normalizeListingPhone(listing.sellerPhone) : null;
  if (stored) {
    if (await phoneBelongsToHiddenOwner(req, stored)) return res.status(403).json({ error: "Номер совпадает с контактом владельца объекта, доступ закрыт" });
    return res.json({ phone: stored, cached: true });
  }

  if (listing.source !== "somon.tj") {
    // Paydo номер в списке не показывает — открывается на сайте.
    return res.json({ phone: null, reason: "open_on_site" });
  }

  try {
    const phone = normalizeListingPhone((await fetchSomonPhoneInteractive(listing.sourceId)) ?? "");
    if (!phone) return res.json({ phone: null, reason: "no_phone" });
    // Сохраняем всегда: так сверка с владельцами нашла бы этот номер при следующем прогоне.
    await prisma.marketListing.update({ where: { id: listing.id }, data: { sellerPhone: phone } });
    if (await phoneBelongsToHiddenOwner(req, phone)) return res.status(403).json({ error: "Номер совпадает с контактом владельца объекта, доступ закрыт" });
    return res.json({ phone, cached: false });
  } catch (err) {
    if (err instanceof SomonSourceUnavailable && err.reason === "not_ready") {
      return res.status(429).json({ error: "Сайт сейчас занят, нажмите ещё раз через несколько секунд", retryAfterSec: 12 });
    }
    void logSystemError("api", `Номер объявления Somon не получен: ${err instanceof SomonSourceUnavailable ? `${err.reason} ${err.status ?? ""}` : "ошибка"}`);
    return res.status(502).json({ error: "Не удалось получить номер — откройте объявление на сайте" });
  }
});
