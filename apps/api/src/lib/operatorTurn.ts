/**
 * ОПЕРАТОР ПРИЁМА ЗАЯВОК В ЖИВОМ ПУТИ — ОДНО МЕСТО, ГДЕ СОБИРАЕТСЯ КОНТЕКСТ И ГДЕ ДЕЙСТВИЕ СТАНОВИТСЯ ЧЕРНОВИКОМ ЗАЯВКИ
 * (PLAN.md, этап 1.2). Оба маршрута бота — ядро (lib/customerLeadOnlyCore.ts) и старый путь (messengers/conversation.ts) —
 * берут контекст и черновик отсюда, чтобы оператор в обоих видел одно и то же: объект в фокусе ИЛИ объект рекламы
 * (`BotConversation.adPropertyId` — запасной фокус, которого у ядра прежде не было), тему рекламы, «когда позвонит» из
 * рабочих часов Настроек, открытые вакансии, имя бренда аккаунта, номер офиса, комиссию продавца.
 *
 * Объект вне Душанбе сервер по объекту не определяет: в наших карточках только зона работы, а «вне зоны» приходит словами
 * клиента (понимание оператора). Поэтому `ctx.outOfArea` здесь всегда false.
 */
import { RECRUITMENT_CONTACT, type RecruitmentPosition } from "@royal-home/shared";
import { prisma } from "../db.js";
import { AGENCY_FACTS } from "../ai/agencyFacts.js";
import type { LeadDraft } from "../ai/leadDraft.js";
import type { LeadOnlyConfig } from "../ai/leadOnlyMode.js";
import { operatorPriceText, operatorWhenText } from "../ai/operator/phrases.js";
import { botWelcomeDelivered, readOperatorState } from "../ai/operator/state.js";
import type { OperatorAction, OperatorChannel, OperatorContext, OperatorPropertyFocus, OperatorState } from "../ai/operator/types.js";
import { PUBLIC_AGENCY_CONTACT } from "./publicAgencyContact.js";
import { readCustomerPropertyFacts } from "./customerPropertyFacts.js";
import { readCustomerOpenVacancies } from "./recruitmentPositions.js";
import { leadOnlyWhen } from "./leadOnlySettings.js";
import { leadOnlyCardAgentActive } from "./leadOnlyHandover.js";
import { contactWhenWithoutAgent } from "./handoffPromise.js";
import { isReviewerConversation } from "./botReviewers.js";
import { contactPromiseUnkept } from "./contactPromiseUnkept.js";


const AD_TOPICS = new Set(["property", "seller", "job"]);
/** Фоновое задание приёма заявки режима (lib/customerLeadOnlyCore.ts вывозит его оттуда же; здесь — без круга импортов). */
export const CUSTOMER_LEAD_ONLY_INTAKE_JOB = "customer-lead-only-intake";

export interface OperatorTurnSetup {
  ctx: OperatorContext;
  /** Сырая память из `BotConversation.leadOnlyPending` — runOperatorTurn читает её сам. */
  stored: unknown;
  /** Прочитанная память (для решения, какой объект в фокусе, и для тестов). */
  state: OperatorState;
  clientId: string | null;
}

async function focusOf(propertyId: string | null, channel: string): Promise<OperatorPropertyFocus | null> {
  if (!propertyId) return null;
  const facts = await readCustomerPropertyFacts(propertyId, channel).catch(() => null);
  if (!facts) return null;
  const sold = facts.availability === "SOLD";
  // Характеристики карточки — для «конкретней / сколько комнат?»; адрес — только район и город (district_city_only).
  return { propertyId, shortId: facts.shortId, priceText: facts.price ? operatorPriceText(facts.price, facts.currency) : null,
    sold, place: sold ? null : facts.publicAddress ?? null, characteristics: sold ? null : facts.characteristics ?? null };
}

/** Открытые вакансии и включён ли приём вакансий (Настройки: botCanHandleVacancies → путь рекрутёра). */
async function vacancies(): Promise<{ open: readonly RecruitmentPosition[]; collecting: boolean }> {
  try { const read = await readCustomerOpenVacancies(); return { open: read.positions, collecting: read.collecting }; }
  catch { return { open: [], collecting: true }; }
}

/** Заявка этого разговора ещё оформляется: задание приёма (не пометка) ждёт или работает. */
async function leadIntakePending(conversationId: string): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<Array<{ n: number }>>`SELECT 1 AS "n" FROM "BackgroundJob"
      WHERE "type"=${CUSTOMER_LEAD_ONLY_INTAKE_JOB} AND "status" IN ('PENDING','RUNNING')
        AND "payload"->>'conversationId'=${conversationId} AND COALESCE("payload"->>'scenario','') <> 'note' LIMIT 1`;
    return rows.length > 0;
  } catch { return true; }
}

/** Клиент дописывает подряд: прошлый ход оператора был не дольше этого назад («передал агенту» — один раз на серию). */
export const OPERATOR_BURST_MS = 3 * 60_000;

/**
 * Сотрудник сам писал в этой переписке за последние `minutes` минут (агент из CRM, ответ из приложения Meta): после заявки
 * бот уступает человеку (владелец 20.11.2026). Сбой чтения — «нет»: молчание без причины хуже короткого ответа.
 */
export async function staffWroteRecently(conversationId: string, minutes: number, now: Date): Promise<boolean> {
  try {
    const since = new Date(now.getTime() - Math.max(1, minutes) * 60_000).toISOString();
    const rows = await prisma.$queryRaw<Array<{ n: number }>>`SELECT 1 AS "n" FROM "BotConversation" c,
        jsonb_array_elements(CASE WHEN jsonb_typeof(c."messages") = 'array' THEN c."messages" ELSE '[]'::jsonb END) e
      WHERE c."id"=${conversationId} AND e->>'role'='assistant' AND e->'by'->>'kind' IN ('agent','manual') AND e->>'at' >= ${since} LIMIT 1`;
    return rows.length > 0;
  } catch { return false; }
}

/** В переписке хоть раз писал сотрудник (из CRM или из приложения Meta). Сбой чтения — «нет». */
export async function staffWroteEver(conversationId: string): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<Array<{ n: number }>>`SELECT 1 AS "n" FROM "BotConversation" c,
        jsonb_array_elements(CASE WHEN jsonb_typeof(c."messages") = 'array' THEN c."messages" ELSE '[]'::jsonb END) e
      WHERE c."id"=${conversationId} AND e->>'role'='assistant' AND e->'by'->>'kind' IN ('agent','manual') LIMIT 1`;
    return rows.length > 0;
  } catch { return false; }
}

/** Контекст хода оператора из базы и Настроек. Сбой чтения необязательного (вакансии, объект) — без него, не отказ хода. */
export async function loadOperatorTurnSetup(input: {
  channel: string; conversationId: string; config: LeadOnlyConfig;
  /** Объект, определённый сервером в этом или прошлых ходах (ссылка, пост, реклама, картинка). */
  focusPropertyId: string | null;
  /** Номер для звонка известен по каналу (WhatsApp и рубильник «номер WhatsApp»). */
  phoneKnownByChannel: boolean;
  /** Номер отправителя в WhatsApp (для проверяющего из Настроек). */
  peerPhone?: string | null;
  now?: Date;
}): Promise<OperatorTurnSetup> {
  const now = input.now ?? new Date();
  const row = await prisma.botConversation.findUnique({ where: { id: input.conversationId }, select: {
    clientId: true, leadOnlyPending: true, adPropertyId: true, adTopic: true, account: { select: { brandName: true } },
    messages: true, client: { select: { lastAgentAttemptAt: true } } } });
  const state = readOperatorState(row?.leadOnlyPending ?? null, now);
  // Объект разговора: этого хода, иначе тот, о котором уже говорили, иначе объект рекламы.
  const propertyId = input.focusPropertyId ?? state.propertyId ?? row?.adPropertyId ?? null;
  const clientId = row?.clientId ?? null;
  const [focus, jobs, leadPending, cardAgentActive, noAgentWhen, staffActive] = await Promise.all([focusOf(propertyId, input.channel), vacancies(),
    clientId ? Promise.resolve(false) : leadIntakePending(input.conversationId),
    // Карточки ещё нет: заявка в очереди приёма — агента назначит приём через секунды (пометки ждут карточку и уходят ему,
    // lib/customerLeadOnlyCore.ts «card_pending»); заявки нет вовсе — живого агента нет (ревью #333).
    clientId ? leadOnlyCardAgentActive(clientId).catch(() => true) : leadIntakePending(input.conversationId),
    contactWhenWithoutAgent(now).catch(() => ({ ru: "в рабочее время", tg: "дар вақти корӣ" })),
    staffWroteRecently(input.conversationId, input.config.staffQuietMinutes ?? 180, now)]);
  const reviewer = await isReviewerConversation(input.conversationId, input.peerPhone ?? null);
  const staffThread = await staffWroteEver(input.conversationId);
  const previousAt = Date.parse(String((row?.leadOnlyPending as { updatedAt?: unknown } | null)?.updatedAt ?? ""));
  const topic = row?.adTopic && AD_TOPICS.has(row.adTopic) ? row.adTopic as "property" | "seller" | "job" : null;
  const ctx: OperatorContext = {
    channel: input.channel as OperatorChannel,
    phoneKnown: input.phoneKnownByChannel,
    // У проверяющего заявка карточкой не становится (lib/botReviewers.ts): «заявка принята» держит его память, а не карточка.
    leadExists: !!clientId || (reviewer && state.leadAccepted),
    leadPending,
    cardAgentActive,
    noAgentWhen,
    recruiterPath: jobs.collecting,
    ad: { topic: topic ?? (row?.adPropertyId ? "property" : null), propertyId: row?.adPropertyId ?? null },
    focus,
    callbackWhen: operatorWhenText(leadOnlyWhen(input.config, now)),
    maxPhoneAsks: input.config.maxPhoneAsks,
    vacancies: { open: jobs.open, contactPhone: RECRUITMENT_CONTACT.phone },
    brandName: row?.account?.brandName?.trim() || AGENCY_FACTS.name,
    // Номер или страница отдельного бренда («Арван»): первое слово бота — от его имени (27.11.2026).
    ...(row?.account?.brandName?.trim() && row.account.brandName.trim() !== AGENCY_FACTS.name ? { ownBrand: true } : {}),
    officePhone: PUBLIC_AGENCY_CONTACT.phone,
    sellerCommissionPercent: AGENCY_FACTS.commission.sellerPercent,
    outOfArea: false,
    afterLeadReplies: input.config.repliesAfterLead !== false,
    staffActive,
    recentTurn: Number.isFinite(previousAt) && now.getTime() - previousAt >= 0 && now.getTime() - previousAt <= OPERATOR_BURST_MS,
    workHours: { from: input.config.workHoursStart, to: input.config.workHoursEnd },
    reviewer,
    staffThread,
    // Бот уже поздоровался и спросил «купить или продать?» до первого слова человека (приветствие WhatsApp, 27.11.2026).
    ...(botWelcomeDelivered(row?.messages) ? { botWelcomed: true } : {}),
    // Только у клиента с карточкой: обещание связаться уже звучало, звонка и ответа сотрудника после него не было.
    ...(clientId && contactPromiseUnkept(row?.messages, row?.client?.lastAgentAttemptAt ?? null, now,
      { start: input.config.workHoursStart, end: input.config.workHoursEnd }) ? { promiseUnkept: true } : {}),
  };
  return { ctx, stored: row?.leadOnlyPending ?? null, state, clientId };
}

/**
 * Действие «принять заявку» → черновик для штатного приёма (messengers/conversation.ts::acceptLead): намерение по роли,
 * заметка оператора агенту, объект (агенту-хозяину объекта). Роль не ясна — намерение решает классификатор приёма.
 */
export function operatorLeadDraft(action: Extract<OperatorAction, { type: "accept_lead" }>, prior: LeadDraft | Record<string, unknown> | null): LeadDraft {
  const base = (prior ?? { stage: "chatting" }) as Record<string, unknown>;
  return { ...base, stage: base.stage === "awaiting_phone" ? "awaiting_phone" : "chatting",
    ...(action.role ? { intent: action.role === "seller" ? "sell" : "buy", confident: true } : {}),
    callbackTopic: action.note,
    ...(action.outOfArea ? { outOfArea: true } : {}),
    ...(action.propertyId ? { requestedPropertyId: action.propertyId } : {}) } as LeadDraft;
}
