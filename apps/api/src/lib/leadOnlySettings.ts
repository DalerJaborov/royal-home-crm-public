/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ» — ЧТЕНИЕ НАСТРОЕК И ДАННЫХ БАЗЫ ДЛЯ ОТВЕТА
 * (владелец 12–13.11.2026). Решения и тексты — ai/leadOnlyMode.ts; здесь то, что
 * требует базы: рубильники экрана «Бот», «сейчас» по Душанбе и минимальная цена
 * вариантов (сценарий «нужна квартира»: число только из базы, никогда из модели).
 *
 * Настройки режима читает ТОЛЬКО lib/leadOnlyConfig.ts (вынесено 13.11.2026: его зовут и общие
 * уведомления CRM, а этот файл тянет поиск объектов и приём заявок — круг импортов).
 */
import { prisma } from "../db.js";
import { dushanbeTimeString } from "./dushanbeTime.js";
import { findMatchingProperties } from "./propertyMatch.js";
import { loadMoneyContext } from "./money.js";
import { resolveSearchPlace } from "./searchPlace.js";
import { leadOnlyCallbackWhen, type LeadOnlyConfig,
  type LeadOnlyMarketSummary } from "../ai/leadOnlyMode.js";
import type { CustomerSearchIntent } from "../ai/customerAgentSearchIntent.js";
import { clientOwnWords } from "../ai/untrustedContent.js";
import { classifyCustomerPropertyFactIntent } from "./customerPropertyFactIntent.js";
export { leadOnlyQuietBeforeLead, loadLeadOnlyConfig } from "./leadOnlyConfig.js";


/**
 * Клиент спрашивает о самом объекте, который уже в разговоре (цена, адрес, площадь, «подробнее»): тот же
 * узкий классификатор вопросов об объекте, что у ядра (lib/customerPropertyFactIntent.ts). Без этого
 * объект, оставшийся в фокусе, отвечался бы на любое «спасибо» и «где офис?» (ревью 13.11.2026).
 */
export function leadOnlyPropertyAsked(text: string): boolean {
  return classifyCustomerPropertyFactIntent(clientOwnWords(text), { hasPropertyContext: true }) !== null;
}

/** Когда агент позвонит, по Душанбе (lib/dushanbeTime.ts), по окну Настроек. */
export function leadOnlyWhen(config: Pick<LeadOnlyConfig, "workHoursStart" | "workHoursEnd">, at: Date = new Date()) {
  return leadOnlyCallbackWhen({ now: dushanbeTimeString(at), workHoursStart: config.workHoursStart, workHoursEnd: config.workHoursEnd });
}

/**
 * Самая низкая цена среди доступных объектов под запрос клиента — тем же
 * подбором и тем же правилом «что ботам можно предлагать», что у поиска бота
 * (lib/propertyMatch.ts → botOfferableWhere). Нет совпадений или район не
 * распознан — null, и ответ уходит без цифр.
 */
export async function leadOnlyMarketSummary(intent: CustomerSearchIntent | null): Promise<LeadOnlyMarketSummary | null> {
  try {
    let districtName: string | null = null;
    const asked = intent?.districtName ?? intent?.placeText ?? null;
    if (asked) {
      const exact = await prisma.district.findFirst({ where: { name: { equals: asked, mode: "insensitive" } }, select: { name: true } });
      if (exact) districtName = exact.name;
      else {
        const place = await resolveSearchPlace(asked).catch(() => null);
        const mapped = place && !place.suburban ? place.districtName ?? place.placeDistrictName ?? null : null;
        const row = mapped ? await prisma.district.findFirst({ where: { name: { equals: mapped, mode: "insensitive" } }, select: { name: true } }) : null;
        districtName = row?.name ?? null;
      }
      // Район назван, но не распознан: «от N» по всему городу было бы неправдой о его районе.
      if (!districtName) return null;
    }
    // Тип не назван — только жильё (квартира, дом): «варианты от 15 000» за гараж, участок или коммерцию человеку,
    // который ищет где жить, было бы неправдой (второе ревью 13.11).
    const rows = await findMatchingProperties({ type: intent?.type, districtName: districtName ?? undefined, rooms: intent?.rooms,
      sort: "cheap" }, { limit: 20, ...(intent?.type ? {} : { scope: { type: { in: ["APARTMENT", "HOUSE"] } } }) });
    const money = await loadMoneyContext();
    let best: { price: string; currency: string; tjs: number } | null = null;
    for (const row of rows) {
      const amount = Number(row.price);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const tjs = row.currency === "USD" ? amount * money.usdToTjs : amount;
      if (!best || tjs < best.tjs) best = { price: String(Math.round(amount)), currency: row.currency, tjs };
    }
    return best ? { districtName, minPrice: best.price, currency: best.currency } : null;
  } catch {
    return null;
  }
}

/** Тот же классификатор, что у приёма заявки (services/leads/intakePolicy.ts): «прочее» — честный текст без обещания звонка. */
export async function leadOnlyOtherInquiryReply(intent: "buy" | "sell" | undefined, clientText: string, language: "ru" | "tg"): Promise<string | null> {
  try {
    const [{ classifyInbound }, { isOtherCityReason }, replies] = await Promise.all([import("../services/leads/intakePolicy.js"),
      import("../ai/leadKind.js"), import("../messengers/leadAcceptedReply.js")]);
    const decision = classifyInbound({ intent, confident: !!intent, clientText, channel: "chat" });
    if (decision.kind !== "OTHER") return null;
    return isOtherCityReason(decision.reason) ? replies.otherCityAcceptedReply(language) : replies.otherInquiryAcceptedReply(language);
  } catch {
    return null;
  }
}

