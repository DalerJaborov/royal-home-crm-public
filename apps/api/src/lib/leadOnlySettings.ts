/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ» — ЧТЕНИЕ НАСТРОЕК И ДАННЫХ БАЗЫ ДЛЯ ОТВЕТА
 * (владелец 12–13.11.2026). Решения и тексты — ai/leadOnlyMode.ts; здесь то, что
 * требует базы: рубильники экрана «Бот», «сейчас» по Душанбе и минимальная цена
 * вариантов (сценарий «нужна квартира»: число только из базы, никогда из модели).
 *
 * Обоим маршрутам бота (ядро и старый путь) настройки режима отдаёт ТОЛЬКО эта
 * функция — второго места, где читается botLeadOnlyMode, быть не должно.
 */
import { prisma } from "../db.js";
import { dushanbeTimeString } from "./dushanbeTime.js";
import { findMatchingProperties } from "./propertyMatch.js";
import { loadMoneyContext } from "./money.js";
import { resolveSearchPlace } from "./searchPlace.js";
import { clampMaxPhoneAsks, leadOnlyCallbackWhen, LEAD_ONLY_DEFAULTS, type LeadOnlyConfig,
  type LeadOnlyMarketSummary } from "../ai/leadOnlyMode.js";
import type { CustomerSearchIntent } from "../ai/customerAgentSearchIntent.js";

export async function loadLeadOnlyConfig(): Promise<LeadOnlyConfig> {
  try {
    const row = await prisma.settings.findUnique({ where: { id: "singleton" }, select: {
      botLeadOnlyMode: true, botUseWhatsappNumber: true, botMaxPhoneAsks: true, botHotIntentHandover: true,
      workHoursStart: true, workHoursEnd: true,
    } });
    if (!row) return LEAD_ONLY_DEFAULTS;
    return { enabled: row.botLeadOnlyMode === true, useWhatsappNumber: row.botUseWhatsappNumber !== false,
      maxPhoneAsks: clampMaxPhoneAsks(row.botMaxPhoneAsks), hotIntentHandover: row.botHotIntentHandover !== false,
      workHoursStart: row.workHoursStart || LEAD_ONLY_DEFAULTS.workHoursStart, workHoursEnd: row.workHoursEnd || LEAD_ONLY_DEFAULTS.workHoursEnd };
  } catch {
    // Настройки недоступны — режим считаем выключенным: прежнее поведение безопаснее молчания.
    return LEAD_ONLY_DEFAULTS;
  }
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
    const rows = await findMatchingProperties({ type: intent?.type, districtName: districtName ?? undefined, rooms: intent?.rooms,
      sort: "cheap" }, { limit: 20 });
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
