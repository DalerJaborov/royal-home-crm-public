import { prisma } from "../../db.js";
import { formatSomonCard, normalizeSomonPhone } from "./card.js";
import { parseSomonDetail } from "./detail.js";
import { reserveSomonDelivery } from "./deliveryStore.js";
import { sendReservedSomon } from "./sendReserved.js";
import { fetchSomonPhone } from "./phone.js";
import { fetchSomon, SomonSourceUnavailable } from "./sourceClient.js";
import { logSystemError } from "../systemError.js";
import { Prisma } from "../../generated/prisma/client.js";
import { assessSeller } from "./sellerAssessment.js";
import { checkSellerProperties } from "./sellerPropertyCheck.js";

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

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
  try { detail = parseSomonDetail(await source.json(), advertId); }
  catch {
    await prisma.somonSeenAdvert.updateMany({ where: { advertId, status: "PENDING" }, data: { status: "INVALID", slug: null, sellerCheck: Prisma.DbNull } });
    await logSystemError("cron", "Не удалось разобрать карточку Somon; запись требует проверки", { dedupKey: "somon-card-invalid" });
    return "skipped";
  }
  const preliminary = assessSeller({ businessAccount: detail.seller.business, distinctApartments: 1, name: detail.seller.name, description: detail.seller.description });
  if (!detail.inScope || detail.isClosed || preliminary.status === "agency") {
    await prisma.somonSeenAdvert.updateMany({ where: { advertId, status: "PENDING" }, data: { status: "REJECTED", slug: null, sellerCheck: Prisma.DbNull } });
    return "skipped";
  }
  if (preliminary.status !== "likely_owner" || detail.seller.total === null || detail.seller.total < 1) {
    await prisma.somonSeenAdvert.updateMany({ where: { advertId, status: "PENDING" }, data: { status: "REVIEW_SELLER", sellerCheck: Prisma.DbNull } });
    await logSystemError("cron", "Somon: продавец требует ручной проверки; автоматическая отправка пропущена", { dedupKey: "somon-seller-review" });
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
  const card = formatSomonCard({ title: detail.title, price: detail.price, location: detail.location, phone, sourceUrl: `https://somon.tj/adv/${item.slug}/`, assessment: "likely_owner", dateUncertain: true });
  const reservation = await reserveSomonDelivery(advertId, phone, { kind: "uncertain" });
  if (reservation.status !== "reserved") return reservation.status === "no_agent" || reservation.status === "disabled" ? "waiting" : "skipped";
  const outcome = await sendReservedSomon(advertId, reservation.agentId, reservation.chatId, card, detail.image);
  if (outcome === "unknown" || outcome === "blocked") {
    await logSystemError("telegram", outcome === "blocked" ? "Somon: Telegram отклонил отправку агенту; агент временно исключён из очереди" : "Somon: результат отправки агенту неизвестен; автоматический повтор отключён", { dedupKey: `somon-delivery-${outcome}` });
  }
  return outcome === "sent" ? "sent" : outcome === "cancelled" ? "skipped" : "unknown";
}
