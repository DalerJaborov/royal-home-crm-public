import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { prisma } from "../db.js";
import { PHONE_TAIL_LEN, phoneTail } from "../lib/clientPhones.js";
import { CRM_PHONE_HIDDEN_ERROR, isHiddenCrmPhone } from "../lib/crmContactPhones.js";
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
 * КРОМЕ одного случая: номер уже записан у нас (контакт владельца любого объекта или любой номер
 * карточки клиента), а сотрудник номера не видит (lib/crmContactPhones.ts, с 18.11.2026 — все,
 * кроме директора). Тогда 403: объявление не должно становиться обходным путём к закрытому телефону. Номер хранится и отдаётся единым видом +992XXXXXXXXX —
 * именно такой вид ищет сверка в lib/market/ownMatch.ts.
 */
const bodySchema = z.object({
  sourceUrl: z.string().url().max(600),
  /** Какой кнопкой взяли номер (17.11.2026): «Показать номер» или «Написать в WhatsApp». */
  action: z.enum(["PHONE", "WHATSAPP"]).optional(),
  /** Для какого покупателя (карточка клиента) — чтобы в отметке было видно, по чьему запросу звонили. */
  clientId: z.guid().optional(),
});

/**
 * Отметка «номер продавца получен» (17.11.2026): другие агенты видят её в блоке «С площадок» и не звонят
 * тому же хозяину второй раз. Пишется только когда номер действительно отдан. Сбой записи не мешает
 * агенту получить номер: отметка вторична, ошибка — в журнал.
 */
async function recordListingContact(listingId: string, agentId: string, action: "PHONE" | "WHATSAPP", clientId: string | undefined): Promise<void> {
  try {
    const client = clientId ? await prisma.client.findUnique({ where: { id: clientId }, select: { id: true } }) : null;
    await prisma.marketListingContact.create({ data: { listingId, agentId, action, clientId: client?.id ?? null } });
  } catch (err) {
    void logSystemError("api", `Отметка «номер продавца получен» не записана: ${err instanceof Error ? err.name : "ошибка"}`);
  }
}

/** Не чаще одного запроса на сотрудника в 3 секунды: защита от залипшей кнопки. */
const lastClickByAgent = new Map<string, number>();
const MIN_GAP_MS = 3000;

/** Единый вид номера: +992 и девять цифр. Меньше девяти цифр — это не номер. */
export function normalizeListingPhone(raw: string): string | null {
  const tail = phoneTail(raw);
  return tail.length === PHONE_TAIL_LEN ? `+992${tail}` : null;
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
    if (await isHiddenCrmPhone(req, stored)) return res.status(403).json({ error: CRM_PHONE_HIDDEN_ERROR, code: "CRM_PHONE_HIDDEN" });
    await recordListingContact(listing.id, agentId, parsed.data.action ?? "WHATSAPP", parsed.data.clientId);
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
    if (await isHiddenCrmPhone(req, phone)) return res.status(403).json({ error: CRM_PHONE_HIDDEN_ERROR, code: "CRM_PHONE_HIDDEN" });
    await recordListingContact(listing.id, agentId, parsed.data.action ?? "WHATSAPP", parsed.data.clientId);
    return res.json({ phone, cached: false });
  } catch (err) {
    if (err instanceof SomonSourceUnavailable && err.reason === "not_ready") {
      return res.status(429).json({ error: "Сайт сейчас занят, нажмите ещё раз через несколько секунд", retryAfterSec: 12 });
    }
    void logSystemError("api", `Номер объявления Somon не получен: ${err instanceof SomonSourceUnavailable ? `${err.reason} ${err.status ?? ""}` : "ошибка"}`);
    return res.status(502).json({ error: "Не удалось получить номер — откройте объявление на сайте" });
  }
});
