import { confirmedClientIntents, formatClientCode, formatPropertyCode, parseShortCode } from "@royal-home/shared";
import { z } from "zod";
import { prisma } from "../../../db.js";
import { cardWhereFromParam } from "../../../lib/cardIdParam.js";
import { currentBuyerMatchingCriteria } from "../../../lib/clientPropertyMatching.js";
import { buyerWantsFromCriteria, describeBuyerCriteria, findBuyerListings, hasBuyerCriteria } from "../../../lib/market/buyerMatch.js";
import { findBuyerMarketSummary } from "../../../lib/market/buyerMarket.js";
import { loadOwnersFilter } from "../../../lib/market/ownerFilter.js";
import { evaluatePropertyAgainstMarket } from "../../../lib/market/propertyMarket.js";
import { loadMoneyContext } from "../../../lib/money.js";
import { findPropertiesByRef } from "../../../lib/propertyRefLookup.js";
import { FOREIGN_CLIENT_SCOPE_MESSAGE } from "../actor.js";
import { propertyHref } from "./propertyPresenter.js";
import type { AssistantReadToolPlugin } from "./types.js";

/**
 * РЫНОК SOMON.TJ / PAYDO.TJ В ПОМОЩНИЦЕ (14.11.2026, два инструмента только для чтения).
 *
 * Данные те же, что видит агент на экране, и считаются теми же функциями (одна дверь): подбор под запрос
 * покупателя — lib/market/buyerMatch.ts, строка рынка — lib/market/buyerMarket.ts, оценка объекта —
 * lib/market/propertyMarket.ts (ею же отвечает GET /market/property/:id). Здесь только доступ и подача.
 *
 * ЧЕСТНОСТЬ ОТВЕТА. Цены объявлений — не цены сделок: модель обязана это сказать. Меньше MIN_SAMPLE (8)
 * объявлений — чисел нет вовсе (status insufficient), модель не «догадывается».
 * Телефонов продавцов и текста объявлений в ответе нет: только площадка, ссылка, цена, площадь, комнаты.
 */

const NOTE_ASKING_NOT_DEALS = "Это цены объявлений на площадках, а не цены сделок: реальная сделка обычно проходит ниже.";
const MAX_LISTINGS = 5;
const MAX_COMPARABLES = 3;

const clientArgs = z.object({ clientId: z.string().trim().min(1).max(100) });
const propertyArgs = z.object({ propertyId: z.string().trim().min(1).max(100) });

/** Словами: бюджет к рынку (знак → «выше»/«ниже»). Число считает сервер, модель его только пересказывает. */
export function budgetVsMarketText(percent: number | null): string | null {
  if (percent == null) return null;
  if (percent === 0) return "бюджет равен типичной цене объявлений";
  return `бюджет на ${Math.abs(percent)}% ${percent > 0 ? "выше" : "ниже"} типичной цены объявлений`;
}

export const marketForClientTool: AssistantReadToolPlugin = {
  name: "market_for_client",
  level: "A",
  description:
    "Рынок под запрос клиента-покупателя: какие объявления с Somon.tj и Paydo.tj подходят его району, комнатам и бюджету " +
    "(до 5 ближайших, со ссылками) и типичная цена на рынке в его районе (медиана за м² и за квартиру), и как она соотносится " +
    "с его бюджетом. Зови на «что есть на рынке для клиента», «хватит ли бюджета», «сколько стоит такое в этом районе». " +
    "Это чужие объявления, не наши объекты. Цены объявлений — не цены сделок: скажи это. Если объявлений мало (меньше порога), " +
    "числа нет: так и скажи, не додумывай. Телефонов продавцов нет. Наши объекты под клиента ищи через find_property.",
  parameters: {
    type: "object",
    properties: {
      clientId: { type: "string", description: "id клиента из find_clients или номер карточки (ПК-000042, 42)" },
    },
    required: ["clientId"],
  },
  statusPhrase: "Смотрю рынок под запрос клиента…",
  async run(rawArgs, { actor }) {
    const parsed = clientArgs.safeParse(rawArgs);
    if (!parsed.success) return { error: "Укажите клиента" };
    const shortCode = parseShortCode(parsed.data.clientId);
    const where = cardWhereFromParam(shortCode !== null ? String(shortCode) : parsed.data.clientId);
    if (!where) return { error: "Клиент не найден" };
    const ownScope = actor.canViewAllClients ? undefined : actor.id;
    const client = await prisma.client.findUnique({ where, include: { desiredPlaces: true } });
    // Корзина и чужой непринятый лид для агента — «не найден»; чужой клиент — отказ (как в get_client_card).
    if (!client || client.deletedAt || (ownScope && client.acceptedAt === null)) return { error: "Клиент не найден" };
    if (ownScope && client.assignedAgentId !== ownScope) return { error: FOREIGN_CLIENT_SCOPE_MESSAGE };
    const code = formatClientCode(client.shortId, client.kind);
    // shortId и href нужны сторожу ссылок на карточки (cardLinkEvidence): без них ответ со ссылкой на клиента отвергается.
    const identity = { code, shortId: client.shortId, href: `/clients/${client.shortId}` };
    if (!confirmedClientIntents(client).buys) return { ...identity, status: "not_buyer", note: "Клиент не покупатель: рынок под запрос не считается." };

    const wants = await buyerWantsFromCriteria(currentBuyerMatchingCriteria(client));
    const criteria = describeBuyerCriteria(wants);
    if (!hasBuyerCriteria(wants)) {
      return { ...identity, status: "no_criteria", note: "В пожеланиях нет ни района, ни бюджета: подбирать не из чего. Попросите агента уточнить." };
    }
    const [{ total, totalIsLowerBound, listings, ownersOnly }, market] = await Promise.all([
      loadOwnersFilter().then((realtors) => findBuyerListings(wants, MAX_LISTINGS, realtors)),
      findBuyerMarketSummary(wants),
    ]);
    return {
      ...identity,
      status: "ok",
      criteria,
      listingsTotal: total,
      // Агентства и риелторы в подборе скрыты (рубильник в Настройках): сколько отсеяно, говорим как есть. Медиана ниже считана по всем объявлениям.
      ownersOnly: ownersOnly.enabled ? { shownOwners: ownersOnly.kept, foundTotal: ownersOnly.total } : { enabled: false },
      listingsTotalIsLowerBound: totalIsLowerBound,
      listings: listings.map((l) => ({
        source: l.source, url: l.sourceUrl, priceTjs: l.priceTjs, pricePerSqmTjs: l.pricePerSqmTjs,
        areaSqm: l.areaSqm, rooms: l.rooms, floor: l.floor, totalFloors: l.totalFloors, district: l.districtName,
      })),
      market: {
        status: market.status,
        district: market.districtName,
        rooms: market.rooms,
        listingsInSegment: market.count,
        minSample: market.minSample,
        medianPerSqmTjs: market.medianPerSqmTjs,
        medianPriceTjs: market.medianPriceTjs,
        budgetTjs: market.budgetTjs,
        budgetVsMedianPercent: market.budgetVsMedianPercent,
        budgetVsMedianText: budgetVsMarketText(market.budgetVsMedianPercent),
        ...(market.status === "insufficient" ? { note: `Объявлений по району и комнатам меньше ${market.minSample}: типичной цены нет.` } : {}),
        ...(market.status === "no_segment" ? { note: "Нужны район и число комнат (квартира), чтобы назвать типичную цену." } : {}),
      },
      note: NOTE_ASKING_NOT_DEALS,
    };
  },
};

const VERDICT_TEXT = { below: "ниже рынка", market: "в рынке", above: "выше рынка", unknown: "сравнить нельзя" } as const;

export const marketPropertyPriceTool: AssistantReadToolPlugin = {
  name: "market_property_price",
  level: "A",
  description:
    "Цена нашего объекта против рынка: вердикт (ниже / в рынке / выше), вилка и ориентир цены по похожим объявлениям на " +
    "Somon.tj и Paydo.tj, на скольких объявлениях посчитано, до 3 похожих со ссылками. Зови на «дорого ли мы просим», " +
    "«какая цена по рынку», «в рынке ли объект». Принимает номер объекта (ОБ-000088, 88) или id. Цены объявлений — не цены " +
    "сделок: скажи это. Если похожих меньше порога, числа нет (status insufficient): так и скажи. Не для поиска объектов: " +
    "для него find_property.",
  parameters: {
    type: "object",
    properties: {
      propertyId: { type: "string", description: "номер объекта (ОБ-000088, 88) или id из find_property" },
    },
    required: ["propertyId"],
  },
  statusPhrase: "Сравниваю цену объекта с рынком…",
  async run(rawArgs, { actor }) {
    const parsed = propertyArgs.safeParse(rawArgs);
    if (!parsed.success) return { error: "Укажите объект" };
    const canDelete = actor.permissions?.has("properties.delete") ?? false;
    const found = await findPropertiesByRef(parsed.data.propertyId, { hideOwnPendingDeleteFor: canDelete ? undefined : actor.id, limit: 1 });
    // Только по точному номеру/id: подставить «похожий по адресу» объект и назвать его цену рынком нельзя.
    const property = found.kind === "id" || found.kind === "shortId" ? found.properties[0] : undefined;
    if (!property) return { error: "Объект не найден — найдите его через find_property и передайте id или номер" };

    const result = await evaluatePropertyAgainstMarket(property, await loadMoneyContext());
    const base = { code: formatPropertyCode(property.shortId), shortId: property.shortId, href: propertyHref(property.shortId) };
    if (result.status === "unsupported") return { ...base, status: "unsupported", note: result.basis };
    if (result.status === "insufficient") {
      return {
        ...base,
        status: "insufficient",
        askingPriceTjs: result.subject.askingPriceTjs,
        sampleSize: result.sampleSize,
        note: `Похожих объявлений слишком мало для честной оценки (нужно не меньше 8): цену рынка не называю. ${result.basis}`,
      };
    }
    return {
      ...base,
      status: "ok",
      askingPriceTjs: result.subject.askingPriceTjs,
      estimatedPriceTjs: result.estimatedPriceTjs,
      rangeLowTjs: result.rangeLowTjs,
      rangeHighTjs: result.rangeHighTjs,
      medianPerSqmTjs: result.medianPerSqm,
      verdict: result.comparison?.verdict ?? "unknown",
      verdictText: VERDICT_TEXT[result.comparison?.verdict ?? "unknown"],
      diffPercent: result.comparison?.diffPercent ?? null,
      sampleSize: result.sampleSize,
      basis: result.basis,
      sources: result.sources,
      comparables: result.listings.slice(0, MAX_COMPARABLES).map((l) => ({
        source: l.source, url: l.sourceUrl, priceTjs: l.priceTjs, areaSqm: l.areaSqm, rooms: l.rooms, district: l.districtName,
      })),
      note: NOTE_ASKING_NOT_DEALS,
    };
  },
};

export const marketTools: readonly AssistantReadToolPlugin[] = [marketForClientTool, marketPropertyPriceTool];
