import { prisma } from "../../db.js";
import { formatSomonCard, normalizeSomonPhone } from "./card.js";
import { parseSomonDetail } from "./detail.js";
import { reserveSomonDelivery } from "./deliveryStore.js";
import { sendReservedSomon } from "./sendReserved.js";
import { fetchSomonPhone } from "./phone.js";
import { recordSomonPhoneSighting } from "./phoneSighting.js";
import { countSomonSellerAdverts, SOMON_SELLER_UNKNOWN } from "./sellerCount.js";
import { somonCategoryCountAllowsOwner } from "./sellerAssessment.js";
import { fetchSomon, SomonSourceUnavailable } from "./sourceClient.js";
import { logSystemError } from "../systemError.js";
import { Prisma } from "../../generated/prisma/client.js";
import { checkSellerProperties } from "./sellerPropertyCheck.js";

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const sellerKeyRekeyInProgress = async () => (await prisma.somonMonitor.findUnique({ where: { id: "singleton" }, select: { sellerKeyRekeyPage: true } }))?.sellerKeyRekeyPage != null;

/** Process one pending ID. The only recipient is an explicitly selected, linked
 * agent. Sellers are never contacted by this worker. */
export async function processSomonPending(advertId: string, pause: (ms: number) => Promise<void> = wait): Promise<"sent" | "skipped" | "waiting" | "unknown"> {
  const item = await prisma.somonSeenAdvert.findUnique({ where: { advertId } });
  if (!item || item.baseline || item.status !== "PENDING" || !item.slug) return "skipped";
  if (Date.now() - item.seenAt.getTime() > 3 * 24 * 60 * 60 * 1000) {
    await prisma.somonSeenAdvert.updateMany({ where: { advertId, status: "PENDING" }, data: { status: "EXPIRED", slug: null, sellerCheck: Prisma.DbNull } });
    return "skipped";
  }
  const configured = await prisma.somonRecipient.findMany({ where: { enabled: true }, select: { agentId: true } });
  const eligible = await prisma.agent.count({ where: { id: { in: configured.map(x => x.agentId) }, isActive: true, role: "AGENT", telegramChatId: { not: null } } });
  if (!eligible) return "waiting";
  // Счёт объявлений автора в категории — по нашим записям выдачи, без запросов к сайту.
  // Карточку и телефон при счёте ≠ 1 не запрашиваем вовсе (бюджет источника не тратится).
  const categoryAdverts = await countSomonSellerAdverts(item.sellerKey);
  if (categoryAdverts === null) {
    // Автор неизвестен (нет ключа) — не отказ: откладываем. Не «waiting»: он прерывает
    // очередь, а она берёт самые старые записи, и одна такая запись держала бы все новые
    // до трёх дней. Ключ придёт, если объявление снова попадёт в выдачу с автором
    // (`backfillSellerKeys` вернёт его в PENDING); иначе через 3 дня — EXPIRED (`cleanupSomonReceipts`).
    await prisma.somonSeenAdvert.updateMany({ where: { advertId, status: "PENDING" }, data: { status: SOMON_SELLER_UNKNOWN, sellerCheck: Prisma.DbNull } });
    await logSystemError("cron", "Somon: в выдаче нет автора объявления; объявление отложено до появления автора (не более 3 дней)", { dedupKey: "somon-seller-count-unknown" });
    return "skipped";
  }
  if (!somonCategoryCountAllowsOwner(categoryAdverts)) {
    await prisma.somonSeenAdvert.updateMany({ where: { advertId, status: "PENDING" }, data: { status: "REJECTED", slug: null, sellerCheck: Prisma.DbNull } });
    return "skipped";
  }
  let source: Response;
  try { source = await fetchSomon(`/api/v2/spa/adverts/card/${item.slug}/`); }
  catch (error) {
    if (error instanceof SomonSourceUnavailable && error.status === 404) {
      await prisma.somonSeenAdvert.updateMany({ where: { advertId, status: "PENDING" }, data: { status: "UNAVAILABLE", slug: null, sellerCheck: Prisma.DbNull } });
      return "skipped";
    }
    throw error;
  }
  let detail: ReturnType<typeof parseSomonDetail>;
  try { detail = parseSomonDetail(await source.json(), advertId, categoryAdverts); }
  catch {
    await prisma.somonSeenAdvert.updateMany({ where: { advertId, status: "PENDING" }, data: { status: "INVALID", slug: null, sellerCheck: Prisma.DbNull } });
    await logSystemError("cron", "Не удалось разобрать карточку Somon; запись требует проверки", { dedupKey: "somon-card-invalid" });
    return "skipped";
  }
  // Одна оценка продавца на всё (sellerAssessment.ts): текст/профиль агентства, счёт по
  // автору в категории и общий потолок объявлений на сайте.
  if (!detail.inScope || detail.isClosed || detail.assessment.status === "agency") {
    await prisma.somonSeenAdvert.updateMany({ where: { advertId, status: "PENDING" }, data: { status: "REJECTED", slug: null, sellerCheck: Prisma.DbNull } });
    return "skipped";
  }
  if (detail.assessment.status !== "likely_owner" || detail.seller.total === null || detail.seller.total < 1) {
    await prisma.somonSeenAdvert.updateMany({ where: { advertId, status: "PENDING" }, data: { status: "REVIEW_SELLER", sellerCheck: Prisma.DbNull } });
    await logSystemError("cron", "Somon: продавец требует ручной проверки; автоматическая отправка пропущена", { dedupKey: "somon-seller-review" });
    return "skipped";
  }
  // Пока старым записям дописывается ключ автора (`rekeySellerPage`), счёт по автору может
  // быть занижен: его прошлые объявления ещё без ключа. Единственное объявление на сайте
  // (total = 1) занижения не допускает; остальных откладываем до конца дозаписи —
  // `requeueAfterRekey` вернёт их в очередь (не дольше 3 дней, дальше EXPIRED).
  if (detail.seller.total > 1 && await sellerKeyRekeyInProgress()) {
    await prisma.somonSeenAdvert.updateMany({ where: { advertId, status: "PENDING" }, data: { status: SOMON_SELLER_UNKNOWN, sellerCheck: Prisma.DbNull } });
    return "skipped";
  }
  if (detail.seller.total > 2) {
    await pause(10200);
    let result: Awaited<ReturnType<typeof checkSellerProperties>>;
    try { result = await checkSellerProperties(advertId, detail.seller.id, detail.seller.total); }
    catch (error) {
      if (error instanceof SomonSourceUnavailable && error.status === 404) result = { kind: "review" };
      else throw error;
    }
    if (result.kind === "waiting") return "waiting";
    if (result.kind === "review" || result.count > 2) {
      await prisma.somonSeenAdvert.updateMany({ where: { advertId, status: "PENDING" }, data: { status: result.kind === "review" ? "REVIEW_SELLER" : "REJECTED", ...(result.kind === "review" ? {} : { slug: null }), sellerCheck: Prisma.DbNull } });
      if (result.kind === "review") await logSystemError("cron", "Somon: не удалось полностью проверить объявления продавца", { dedupKey: "somon-seller-review" });
      return "skipped";
    }
    await pause(10200);
  }
  // The public page uses a separate request for the phone. Keep source requests spaced.
  await pause(10200);
  let phone: string | null;
  try { phone = await fetchSomonPhone(advertId); }
  catch (error) { if (error instanceof SomonSourceUnavailable && error.reason === "not_ready") return "waiting"; throw error; }
  if (!phone || !normalizeSomonPhone(phone)) {
    await prisma.somonSeenAdvert.updateMany({ where: { advertId, status: "PENDING" }, data: { status: "NO_PHONE", slug: null, sellerCheck: Prisma.DbNull } });
    return "skipped";
  }
  // Один номер в нескольких разных объявлениях за месяц — агентство, а не собственник.
  // Запись делаем до резервирования, чтобы повторы считались и у уже известных контактов.
  if (await recordSomonPhoneSighting(phone, advertId)) {
    await prisma.somonSeenAdvert.updateMany({ where: { advertId, status: "PENDING" }, data: { status: "REJECTED", slug: null, sellerCheck: Prisma.DbNull } });
    return "skipped";
  }
  const card = formatSomonCard({ title: detail.title, price: detail.price, location: detail.location, phone, sourceUrl: `https://somon.tj/adv/${item.slug}/`, assessment: "likely_owner" });
  const reservation = await reserveSomonDelivery(advertId, phone, { kind: "uncertain" });
  if (reservation.status !== "reserved") return reservation.status === "no_agent" || reservation.status === "disabled" ? "waiting" : "skipped";
  const outcome = await sendReservedSomon(advertId, reservation.agentId, reservation.chatId, card, detail.image);
  if (outcome === "unknown" || outcome === "blocked") {
    await logSystemError("telegram", outcome === "blocked" ? "Somon: Telegram отклонил отправку агенту; агент временно исключён из очереди" : "Somon: результат отправки агенту неизвестен; автоматический повтор отключён", { dedupKey: `somon-delivery-${outcome}` });
  }
  return outcome === "sent" ? "sent" : outcome === "cancelled" ? "skipped" : "unknown";
}
