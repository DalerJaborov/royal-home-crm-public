/**
 * ПОБОЧНЫЕ ЭФФЕКТЫ ОБНОВЛЕНИЯ КАРТОЧКИ ОБЪЕКТА — ОДНО МЕСТО НА ДВА ВХОДА (07.10.2026).
 *
 * Вынесено из `PATCH /properties/:id` (routes/properties/crud.ts) БЕЗ смены
 * поведения: тот же код теперь зовут и сам PATCH, и «Принять» по заявке агента на
 * изменение опубликованного объекта (lib/propertyChangeExecutor.ts). Копия этой
 * цепочки в исполнителе заявок однажды забыла бы то, что в PATCH добавили позже
 * (автоподбор покупателей на снижение цены, пересбор подписи в базе, сайт) — тот же
 * урок, что и с trashProperty.
 *
 * Что здесь:
 *  — SEO-мета после правки (платный запрос к ИИ только если поменялось нужное поле);
 *  — «после обновления»: автоподбор покупателей на снижение цены, досылка на сайт,
 *    точечная перепись подписи в базе, цена в посты соцсетей.
 */
import type { Property } from "../generated/prisma/client.js";
import { generateSeoFields, type SeoFields } from "../ai/seoGenerator.js";
import { notifyWaitingBuyersOfNewProperty } from "./propertyMatchFilter.js";
import { loadMoneyContext, toTjs } from "./money.js";
import { resyncPhotosIfPublished } from "./siteSync.js";
import { syncPublishedPriceChange, type PriceSyncResult } from "./publishedListingSync.js";
import { CAPTION_FACT_FIELDS, rewriteStoredCaptionAfterEdit } from "./publishedVideoFix.js";
import { logSystemError } from "./systemError.js";
import { refreshSellerAfterPropertyChange } from "./clientAutoStatus.js";

/** Поля объекта, от которых зависит автосгенерированный SEO-текст — при их изменении
 * текст пересобирается заново, чтобы не разъезжаться с фактическими параметрами. */
export const SEO_RELEVANT_FIELDS = [
  "type",
  "rooms",
  "areaSqm",
  "floor",
  "totalFloors",
  "price",
  "currency",
  "districtId",
  "address",
  "condition",
  "amenities",
  "stage",
  "marketType",
  "urgent",
] as const;

/** Что правка может поменять в исходных данных SEO (форма и значения — как у propertyUpdateSchema). */
export interface SeoPatch {
  type?: string;
  rooms?: number | null;
  areaSqm?: number;
  floor?: number | null;
  totalFloors?: number | null;
  price?: number;
  currency?: string;
  address?: string;
  condition?: string;
  amenities?: string[];
  stage?: string | null;
  marketType?: string | null;
  urgent?: boolean;
}

/**
 * SEO-поля после правки или null, если ничего из SEO_RELEVANT_FIELDS не менялось
 * (форма шлёт карточку целиком, и раньше каждое «Сохранить» без правок гоняло
 * платный запрос к ИИ — поэтому смотрим на `changedFields`, а не на «поле пришло»).
 * ИИ-текст — всегда в сомони (владелец 16.09.2026): metaTitle/metaDescription/h1/
 * seoDesc идут на сайт и в поиск, «$» там неуместен.
 */
export async function seoFieldsForUpdate(
  existing: Property,
  data: SeoPatch,
  districtName: string | undefined,
  changedFields: readonly string[]
): Promise<SeoFields | null> {
  if (!SEO_RELEVANT_FIELDS.some((f) => changedFields.includes(f))) return null;
  const seoMoney = await loadMoneyContext();
  return generateSeoFields(
    {
      type: data.type ?? existing.type,
      rooms: data.rooms !== undefined ? data.rooms : existing.rooms,
      areaSqm: data.areaSqm ?? Number(existing.areaSqm),
      floor: data.floor !== undefined ? data.floor : existing.floor,
      totalFloors: data.totalFloors !== undefined ? data.totalFloors : existing.totalFloors,
      price: toTjs(data.price ?? Number(existing.price), data.currency ?? existing.currency, seoMoney),
      currency: "TJS",
      districtName: districtName ?? "Душанбе",
      address: data.address ?? existing.address ?? "",
      condition: data.condition ?? existing.condition,
      amenities: data.amenities ?? existing.amenities,
      stage: data.stage !== undefined ? data.stage : existing.stage,
      marketType: data.marketType !== undefined ? data.marketType : existing.marketType,
      urgent: data.urgent !== undefined ? data.urgent : existing.urgent,
    },
    { includeDescription: false } // description здесь всё равно выбрасывается — не платим за него
  );
}

export interface PostUpdateEffectsInput {
  /** Карточка ДО правки. */
  existing: Property;
  /** Карточка ПОСЛЕ правки (свежая из базы). */
  updated: Property;
  /** Что реально изменилось (changedPropertyFields). */
  changedFields: readonly string[];
  /** Цена или валюта реально изменились — даже если число то же, а валюта другая. */
  priceActuallyChanged: boolean;
  /** Объект остаётся «в продаже» этим же обновлением (статус не уходит из AVAILABLE) —
   *  условие автоподбора покупателей на снижение цены. */
  staysAvailable: boolean;
  /** Досылать ли карточку на сайт (в PATCH false, если статусный переход уже досылает сам). */
  resyncSite: boolean;
  /** Причина для журнала досылки на сайт. */
  resyncReason: string;
  /** Ждать ли ответа посылки цены в соцсети: PATCH не ждёт (void), исполнитель заявок — ждёт и
   *  читает результат, чтобы собрать «что осталось руками». */
  awaitPriceSync: boolean;
}

export interface PostUpdateEffectsResult {
  /** Итог посылки цены в посты; null — цена не менялась или посылка шла «в отрыве» (awaitPriceSync=false). */
  priceSync: PriceSyncResult | null;
  /** Блок фактов в подписи нашёлся и переписан (true), не нашёлся — подпись правили руками (false),
   *  null — факты не менялись. */
  captionRewritten: boolean | null;
}

/**
 * ЭФФЕКТЫ ПОСЛЕ ЗАПИСИ ПРАВКИ (тот же порядок и те же условия, что были в PATCH):
 *  1. автоподбор покупателей на СНИЖЕНИЕ цены (12.09.2026, docs/geo-match-plan-12-09.md блок D);
 *  2. досылка на сайт — любая правка опубликованного объекта доезжает до витрины (аудит №4, 27.08);
 *  3. факты подписи ролика — точечно в базе сразу, в посты уходит по «Готово» (23.09.2026);
 *  4. цена в посты соцсетей: Facebook / Telegram / YouTube, остальное — в журнал и «руками» (16.09.2026).
 * Ни один шаг не бросает наружу: сбой — в logSystemError, как и было.
 */
export async function runPostUpdateEffects(input: PostUpdateEffectsInput): Promise<PostUpdateEffectsResult> {
  const { existing, updated, changedFields, priceActuallyChanged } = input;
  if (existing.sellerClientId !== updated.sellerClientId || existing.status !== updated.status) {
    await refreshSellerAfterPropertyChange(updated.sellerClientId);
  }

  // ДЕДУП И ПОВТОРНОЕ УВЕДОМЛЕНИЕ (решение владельца 12.09.2026, «все да» п.5):
  // notifyWaitingBuyersOfNewProperty пропускает клиента, которому этот объект уже предлагался,
  // ТОЛЬКО пока цена с тех пор не упала на 5% и больше от цены последнего уведомления
  // (Interaction.matchNotifiedPriceTjs) — иначе шлёт снова. Новые клиенты, которым объект по
  // старой цене не подходил по бюджету, дедупом не затронуты.
  // Условие: объект был И остаётся в AVAILABLE этим же обновлением — если он вошёл в AVAILABLE
  // только сейчас, сработал хук статуса (existing.status==="AVAILABLE" делает ветки взаимоисключающими).
  // Сравниваем в сомони — валюта могла смениться вместе с ценой.
  if (priceActuallyChanged && existing.status === "AVAILABLE" && input.staysAvailable) {
    const money = await loadMoneyContext();
    const oldTjs = toTjs(existing.price, existing.currency, money);
    const newTjs = toTjs(updated.price, updated.currency, money);
    if (newTjs < oldTjs) {
      void notifyWaitingBuyersOfNewProperty(updated).catch((err) =>
        console.error("[автоподбор] снижение цены объекта:", err instanceof Error ? err.message : err)
      );
    }
  }

  if (input.resyncSite) {
    void resyncPhotosIfPublished(updated.id, input.resyncReason);
  }

  let captionRewritten: boolean | null = null;
  if (changedFields.some((f) => (CAPTION_FACT_FIELDS as readonly string[]).includes(f))) {
    captionRewritten = await rewriteStoredCaptionAfterEdit(existing, updated).catch(async (err) => {
      await logSystemError(
        "meta",
        `Объект ${updated.id}: подпись после правки — ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    });
  }

  let priceSync: PriceSyncResult | null = null;
  if (priceActuallyChanged) {
    const run = syncPublishedPriceChange(updated.id, Number(existing.price), existing.currency);
    if (input.awaitPriceSync) priceSync = (await run) ?? { updated: [], failed: [], skipped: null, captionNeedsManualFix: false };
    else void run;
  }

  return { priceSync, captionRewritten };
}
