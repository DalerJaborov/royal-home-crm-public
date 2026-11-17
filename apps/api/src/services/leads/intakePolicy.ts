import type { ClientKind } from "@royal-home/shared";
import { decideLeadKind, type LeadKindDecision, type LeadKindInput } from "../../ai/leadKind.js";
import type { LeadIntent } from "../../ai/botContract.js";
import { assignAgentForLead } from "./assignment.js";
import type { LeadAssignContext, LeadAssignment, LeadAssignReason } from "./assignmentTypes.js";

/**
 * ЕДИНАЯ ОБВЯЗКА ВОКРУГ РЕШЕНИЯ «ТИП ОБРАЩЕНИЯ» И «КОМУ ДОСТАЁТСЯ ЛИД»
 * (П-13, 18.09.2026, `docs/audit/recon-17-09/07-routing-code.md` §F).
 *
 * НЕ переписывает `decideLeadKind` (ai/leadKind.ts) и `assignAgentForLead`
 * (./assignment.ts) — обе функции и их лесенки/пять точек вызова остаются как
 * есть. Модуль формализует КОНТРАКТ вокруг них: явный `channel` у классификации
 * (сейчас `fallbackKind` есть только у формы сайта, `routes/webhooks.ts:249` —
 * разработчик нового канала легко может забыть его передать и получить OTHER
 * там, где ожидал BUYER) и типизированные причины OTHER вместо голых строк.
 *
 * Новые вызывающие места переключаются на этот модуль. Существующие пять точек
 * вызова остаются нетронутыми там, где перевод не входил в объём этой задачи —
 * список см. в отчёте PR.
 */

/** Типизированная причина, по которой обращение — «прочее» (не BUYER/SELLER).
 *  Раньше это была голая строка в `reason` без единого набора значений — годится
 *  и для журнала, и для будущего фильтра в «Прочих обращениях» по причине. */
export enum OtherReason {
  /** Клиент сам назвал город/район вне Душанбе (coverageGuard) либо объект
   *  продавца — вне Душанбе (поле модели locationOutsideDushanbe). */
  OUTSIDE_COVERAGE = "OUTSIDE_COVERAGE",
  /** Предложение услуг агентству (ремонт, реклама и т.п.), не клиент. */
  SERVICE_OFFER = "SERVICE_OFFER",
  /** Не наш профиль объекта — участок, коммерция и т.п. */
  OUT_OF_SCOPE_ASSET = "OUT_OF_SCOPE_ASSET",
  /** Похоже на месячную аренду по названной сумме (без явного слова «аренда»). */
  RENT_BY_BUDGET = "RENT_BY_BUDGET",
  /** Модель сама не уверена в типе обращения (confident === false). */
  LOW_CONFIDENCE = "LOW_CONFIDENCE",
  /** Соискатель вакансии. */
  JOB = "JOB",
  /** Явная аренда (обычно отсекается раньше, полным отказом без карточки —
   *  сюда попадает только то, что дошло, минуя ранний отказ). */
  RENT = "RENT",
  /** intent="other" — модель сама разметила как прочее. */
  OTHER_INTENT = "OTHER_INTENT",
  /** Намерения нет вовсе, fallbackKind не задан или тоже OTHER. */
  NO_INTENT = "NO_INTENT",
  /** Похоже на просьбу о материальной помощи, а не на клиента недвижимости. */
  NOT_ABOUT_REAL_ESTATE = "NOT_ABOUT_REAL_ESTATE",
  /** Пришёл по рекламе (click-to-WhatsApp) и не написал ни одного своего слова —
   *  намерение в этот момент было бы выдумкой модели. */
  AD_NO_WORDS = "AD_NO_WORDS",
  /** intent=sell, но клиент ни разу не сказал «продаю» своими словами — направление
   *  могло взяться из наводящего вопроса самого бота (см. ai/intentDirectionGuard.ts). */
  DIRECTION_UNCONFIRMED = "DIRECTION_UNCONFIRMED",
}

/** Переводит текстовую причину `decideLeadKind` в типизированный enum. Сопоставление
 *  по префиксу/содержимому строки — сами тексты решения не переписываем, только
 *  читаем их здесь, в одном месте, вместо голых строк по всем вызывающим местам. */
function classifyOtherReason(decision: LeadKindDecision): OtherReason | undefined {
  if (decision.kind !== "OTHER") return undefined;
  const reason = decision.reason ?? "";
  if (reason === "объект вне Душанбе" || reason.startsWith("другой город (")) return OtherReason.OUTSIDE_COVERAGE;
  if (reason === "модель не уверена в типе обращения") return OtherReason.LOW_CONFIDENCE;
  if (reason === "работа") return OtherReason.JOB;
  if (reason === "аренда") return OtherReason.RENT;
  if (reason === "бюджет ниже порога покупки — похоже на месячную плату") return OtherReason.RENT_BY_BUDGET;
  if (reason === "прочее") return OtherReason.OTHER_INTENT;
  if (reason === "намерение не определено") return OtherReason.NO_INTENT;
  if (reason === "не по теме") return OtherReason.NOT_ABOUT_REAL_ESTATE;
  if (reason === "реклама без слов клиента") return OtherReason.AD_NO_WORDS;
  if (reason === "направление не подтверждено словами клиента") return OtherReason.DIRECTION_UNCONFIRMED;
  // serviceOfferGuard/assetScopeGuard пишут динамический текст причины (сама
  // находка, не фиксированная строка) — отличаем их по меткам решения, которые
  // decideLeadKind проставляет только этим двум отсечкам.
  if (decision.label?.startsWith("💼 НЕ КЛИЕНТ:")) return OtherReason.SERVICE_OFFER;
  if (decision.label?.startsWith("🚫 НЕ НАШ ПРОФИЛЬ:")) return OtherReason.OUT_OF_SCOPE_ASSET;
  return OtherReason.OTHER_INTENT;
}

/** Каналы, из которых сейчас приходит обращение. Ровно тот список, что в
 *  §F отчёта 07: у переписки (chat) fallbackKind нет и не должно быть — «модель
 *  не поняла» обязана остаться OTHER; у формы сайта человек сам заполнил форму,
 *  «намерение не определено» там означает обычного покупателя. */
export type InboundChannel = "chat" | "call" | "site_form" | "comment";

export interface ClassifyInboundInput {
  clientText: string;
  intent?: LeadIntent;
  confident?: boolean;
  budgetMin?: number;
  budgetMax?: number;
  budgetUnrealistic?: number;
  locationOutsideDushanbe?: boolean;
  fromAd?: boolean;
  channel: InboundChannel;
  /** См. `ai/leadKind.ts::LeadKindInput.priorCategory` — категория досье,
   *  только чтобы разрешить неуверенный ход, никогда не сильнее кода/модели. */
  priorCategory?: string;
}

export interface ClassifyInboundResult {
  kind: ClientKind;
  label?: string;
  /** Та же строка, что раньше возвращал `decideLeadKind` напрямую — вызывающий
   *  код (тексты в журнал, `isOtherCityReason`) читает её как раньше, ничего
   *  ломать не пришлось при переключении существующих call site'ов. */
  reason?: string;
  /** Типизированная причина — только для kind="OTHER". Новое поле поверх
   *  прежнего `reason`, не замена: пригодится будущему фильтру в «Прочих
   *  обращениях» по причине без разбора голых строк. */
  otherReason?: OtherReason;
}

/** По каналу — свой fallbackKind, когда намерение не определено вовсе (см.
 *  комментарий `LeadKindInput.fallbackKind` в ai/leadKind.ts). Только сайт даёт
 *  BUYER: человек сам открыл форму подбора и заполнил её — это не «не поняли»,
 *  а обычный покупатель. Остальные три канала — без fallback (тихое обращение
 *  остаётся OTHER, разбирает руководство). Явный список вместо `?? undefined`
 *  в вызывающем коде — чтобы новый канал не забыл решить этот вопрос молча. */
function fallbackKindForChannel(channel: InboundChannel): ClientKind | undefined {
  switch (channel) {
    case "site_form":
      return "BUYER";
    case "chat":
    case "call":
    case "comment":
      return undefined;
  }
}

/**
 * Тонкая обёртка над `decideLeadKind`: требует явный `channel` и сама решает
 * `fallbackKind` по нему, чтобы разработчик нового канала не мог случайно
 * забыть этот параметр (как это раньше было возможно — Telegram и форма сайта
 * передавали разный набор полей).
 */
export function classifyInbound(input: ClassifyInboundInput): ClassifyInboundResult {
  const kindInput: LeadKindInput = {
    intent: input.intent,
    confident: input.confident,
    clientText: input.clientText,
    budgetMin: input.budgetMin,
    budgetMax: input.budgetMax,
    budgetUnrealistic: input.budgetUnrealistic,
    locationOutsideDushanbe: input.locationOutsideDushanbe,
    fromAd: input.fromAd,
    fallbackKind: fallbackKindForChannel(input.channel),
    priorCategory: input.priorCategory,
  };
  const decision = decideLeadKind(kindInput);
  return {
    kind: decision.kind,
    label: decision.label,
    reason: decision.reason,
    otherReason: classifyOtherReason(decision),
  };
}

export interface ResolveOwnerAgentLead {
  clientId?: string;
  channel?: string;
  recipientId?: string;
  propertyId?: string;
  inquiryText?: string | null;
  kind: "BUYER" | "SELLER";
}

export interface ResolvedOwnerAgent {
  agentId: string;
  reason: LeadAssignReason;
  propertyId?: string;
  score?: number;
}

/**
 * Переименованная обёртка вокруг `assignAgentForLead` — лесенка выбора агента НЕ
 * меняется (см. `./assignment.ts`). Оба точечных исправления находок §E отчёта
 * 07 (#1, #2) внесены В САМОЙ лесенке (`pickByExplicitProperty` теперь проверяет
 * `property.status`, `resolveCallPropertyHint` — тоже), а не здесь: обвязка лишь
 * даёт вызывающему коду единое, понятное имя и явный контракт «BUYER|SELLER»
 * вместо необязательного `kind`.
 */
export async function resolveOwnerAgent(
  lead: ResolveOwnerAgentLead,
  excludeAgentIds?: string | string[]
): Promise<ResolvedOwnerAgent | null> {
  const ctx: LeadAssignContext = {
    clientId: lead.clientId,
    channel: lead.channel,
    recipientId: lead.recipientId,
    propertyId: lead.propertyId,
    inquiryText: lead.inquiryText,
    kind: lead.kind,
  };
  const assignment: LeadAssignment = await assignAgentForLead(ctx, excludeAgentIds);
  if (!assignment.agentId) return null;
  return {
    agentId: assignment.agentId,
    reason: assignment.reason,
    propertyId: assignment.propertyId,
    score: assignment.score,
  };
}
