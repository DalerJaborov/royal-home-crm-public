import { z } from "zod";
import { formatClientCode, formatPropertyCode } from "@royal-home/shared";
import { scopeDealsToOwnAgent } from "../../../auth/middleware.js";
import { prisma } from "../../../db.js";
import {
  AssistantActionError,
  type AssistantActionActor,
  type AssistantActionExecutor,
  type AssistantActionPreview,
} from "../../../lib/assistantActions.js";
import {
  annulDealFor,
  canCompleteDeal,
  createDealFor,
  markDealPayoutFor,
  scaleClosedCommissionShares,
  seesDealMoneyFor,
  updateDealFor,
  type DealActor,
} from "../../../lib/dealWrites.js";
import { fromCents, sumCents, toCents } from "../../../lib/money.js";
import { runAsActor } from "../../../lib/requestActor.js";
import { plainField } from "./safeField.js";
import { asPluginExecutor } from "./showingToolSupport.js";
import {
  dealRefusal,
  dealWritesAllowed,
  loadDealWriter,
  loadUsdRate,
  moneyWithRate,
  stageLabel,
  WORDS,
  type DealLang,
} from "./dealToolSupport.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * ЗАПИСЬ В РАЗДЕЛ «СДЕЛКИ» ИЗ ЛИЧКИ ШАБНАМ (10.11.2026). Уровень C: инструмент
 * готовит карточку «было → станет», исполняет человек кнопкой «✅ Подтвердить».
 *
 * НИ ОДНОГО СВОЕГО ПРАВИЛА. Исполнение — те же функции, что у REST
 * (lib/dealWrites.ts: createDealFor / updateDealFor / markDealPayoutFor /
 * annulDealFor) от имени нажавшего, с его свежими правами. Превью строится
 * ПРОВЕРОЧНЫМ прогоном той же функции (`dryRun`): отказ REST («нет показа»,
 * «не хватает документов», «закрыть может только руководитель») человек видит до
 * кнопки, а не после.
 *
 * ГОНКИ:
 *  1. Превью → нажатие: брокер сверяет снимок (этап, версия, деньги, выплата,
 *     аннулирование, курс доллара) — изменилось → 409 STALE и новое превью.
 *  2. Сверка → запись: PATCH уходит с `version` из снимка — условная запись
 *     REST (`updateMany … version`), не совпало → STALE.
 *  3. Двойное «Подтвердить» — захват PENDING → CONFIRMED в брокере; выплата и
 *     аннулирование ещё и условной записью в самой базе.
 *
 * ДЕНЬГИ. Суммы — в валюте сделки, доллары — со строкой «1 500 $ × 11,15 =
 * 16 725 с.». Валюта в просьбе обязана совпасть с валютой сделки (без тихой
 * конвертации), а долларовую сумму без курса в Настройках помощница не пишет.
 *
 * Только личка (privateTelegram + dealWritesAllowed): в группе этих действий нет.
 * Отката нет ни у одного — у REST его тоже нет (выплату и закрытие не «отжать»),
 * поэтому денежные карточки помечены необратимыми.
 */

const langSchema = z.enum(["ru", "tg"]).default("ru");
const LANG_PROP = { type: "string", enum: ["ru", "tg"], description: "Язык сотрудника: ru или tg" } as const;
const moneySchema = z.number().finite().nonnegative().max(1e12);

const DEAL_SELECT = {
  id: true,
  stage: true,
  version: true,
  agentId: true,
  clientId: true,
  propertyId: true,
  currency: true,
  soldPrice: true,
  commissionAmount: true,
  commissionPercent: true,
  commissionIntakeAmount: true,
  commissionRealtorAmount: true,
  commissionCompanyAmount: true,
  realtorPayoutAt: true,
  annulledAt: true,
  closedAt: true,
  client: { select: { shortId: true, kind: true, fullName: true, deletedAt: true } },
  property: { select: { shortId: true, title: true, status: true } },
  agent: { select: { fullName: true } },
} as const;

type DealRow = NonNullable<Awaited<ReturnType<typeof loadDeal>>>;

function loadDeal(dealId: string) {
  return prisma.deal.findUnique({ where: { id: dealId }, select: DEAL_SELECT });
}

const amount = (value: unknown) => (value === null || value === undefined ? null : fromCents(toCents(value)));
const iso = (value: Date | null) => (value ? value.toISOString() : null);

/** Сделка, которую этот сотрудник видит (как список REST). Иначе 404 — без подсказки, что она есть. */
async function visibleDeal(req: DealActor, dealId: string): Promise<DealRow> {
  const deal = await loadDeal(dealId);
  const own = scopeDealsToOwnAgent(req);
  if (!deal || deal.client.deletedAt || (own && deal.agentId !== own)) {
    throw new AssistantActionError(404, "NOT_FOUND", "Сделка не найдена");
  }
  return deal;
}

/** Снимок сделки: всё, от чего зависит решение и что действие меняет. */
function dealSnapshot(deal: DealRow, rate: number | null) {
  return {
    dealId: deal.id,
    stage: deal.stage,
    version: deal.version,
    agentId: deal.agentId,
    currency: deal.currency,
    soldPrice: amount(deal.soldPrice),
    commissionAmount: amount(deal.commissionAmount),
    commissionIntakeAmount: amount(deal.commissionIntakeAmount),
    commissionRealtorAmount: amount(deal.commissionRealtorAmount),
    commissionCompanyAmount: amount(deal.commissionCompanyAmount),
    realtorPayoutAt: iso(deal.realtorPayoutAt),
    annulledAt: iso(deal.annulledAt),
    // Курс входит в снимок: его поправили между превью и нажатием — человек
    // подтверждал другие сомони, превью строится заново.
    usdToTjsRate: deal.currency === "USD" ? rate : null,
  };
}
type DealSnap = ReturnType<typeof dealSnapshot>;

const codes = (deal: DealRow) =>
  `${formatClientCode(deal.client.shortId, deal.client.kind)} · ${formatPropertyCode(deal.property.shortId)}`;

/** Деньги — в карточку только тому, кто их видит в CRM (seesDealMoney). */
function moneyFields(
  req: DealActor,
  deal: DealRow,
  values: { soldPrice?: unknown; commission?: unknown; realtor?: unknown; company?: unknown },
  rate: number | null,
  lang: DealLang,
): Record<string, string> {
  if (!seesDealMoneyFor(req, deal)) return {};
  const w = WORDS[lang];
  const out: Record<string, string> = {};
  if (values.soldPrice !== undefined && values.soldPrice !== null) out[w.price] = moneyWithRate(values.soldPrice, deal.currency, rate, lang);
  if (values.commission !== undefined && values.commission !== null) out[`💰 ${w.commission}`] = moneyWithRate(values.commission, deal.currency, rate, lang);
  if (values.realtor !== undefined && values.realtor !== null) out[`👤 ${w.realtor}`] = moneyWithRate(values.realtor, deal.currency, rate, lang);
  if (values.company !== undefined && values.company !== null) out[`🏢 ${w.company}`] = moneyWithRate(values.company, deal.currency, rate, lang);
  return out;
}

/** Валюта просьбы = валюта сделки; доллары — только при заданном курсе. */
function assertCurrency(deal: DealRow, currency: string, rate: number | null, lang: DealLang) {
  if (currency !== deal.currency) {
    throw new AssistantActionError(
      409,
      "CURRENCY_MISMATCH",
      lang === "tg"
        ? `Муомила бо ${deal.currency === "USD" ? "доллар ($)" : "сомонӣ"} аст — маблағро бо ҳамин асъор гӯед.`
        : `Сделка в ${deal.currency === "USD" ? "долларах ($)" : "сомони"} — назовите суммы в этой же валюте, сама я не пересчитываю.`,
    );
  }
  if (deal.currency === "USD" && rate === null) {
    throw new AssistantActionError(
      409,
      "NO_RATE",
      lang === "tg"
        ? "Қурби доллар дар Танзимот гузошта нашудааст — маблағи долларро сабт намекунам. Аввал қурбро гузоред."
        : "Курс доллара в Настройках не задан — долларовую сумму не записываю. Сначала укажите курс в Настройках.",
    );
  }
}

function resultOf(req: DealActor, deal: { id: string; stage: string; agentId: string } & Record<string, unknown>) {
  const sees = seesDealMoneyFor(req, deal);
  return {
    dealId: deal.id,
    stage: deal.stage,
    href: "/deals",
    ...(sees
      ? {
          currency: deal.currency,
          soldPrice: amount(deal.soldPrice),
          commissionAmount: amount(deal.commissionAmount),
          commissionRealtorAmount: amount(deal.commissionRealtorAmount),
          commissionCompanyAmount: amount(deal.commissionCompanyAmount),
        }
      : {}),
  };
}

const dealResultSchema = z.object({ dealId: z.string() });

/** Повтор по уже исполненному: результат читает только тот, кто сделку и сейчас видит. */
async function authorizeDealResult(actionActor: AssistantActionActor, result: unknown): Promise<void> {
  const parsed = dealResultSchema.safeParse(result);
  if (!parsed.success) return;
  const { req } = await loadDealWriter(actionActor);
  const deal = await prisma.deal.findUnique({ where: { id: parsed.data.dealId }, select: { agentId: true } });
  const own = scopeDealsToOwnAgent(req);
  if (!deal || (own && deal.agentId !== own)) throw new AssistantActionError(403, "FORBIDDEN", "Нет доступа к этой сделке");
}

async function snapshotDeal(dealId: string, actionActor: AssistantActionActor): Promise<DealSnap> {
  const { req } = await loadDealWriter(actionActor);
  const deal = await visibleDeal(req, dealId);
  return dealSnapshot(deal, deal.currency === "USD" ? await loadUsdRate() : null);
}

/** Запись от имени нажавшего: журнал переходов (db.ts) видит, КТО двинул сделку. */
const asActor = <T>(agentId: string, work: () => Promise<T>) => runAsActor(agentId, work);

function common<A>(tool: string): Pick<AssistantActionExecutor<A>, "tool" | "channels" | "privateTelegram"> {
  return { tool, channels: ["crm", "telegram"], privateTelegram: true };
}

// ─────────────────────────── create_deal ───────────────────────────

const createArgs = z.object({
  clientId: z.string().trim().uuid(),
  propertyId: z.string().trim().uuid(),
  lang: langSchema,
}).strict();
type CreateArgs = z.infer<typeof createArgs>;

const createExecutor: AssistantActionExecutor<CreateArgs> = {
  ...common<CreateArgs>("create_deal"),
  parseArgs: (raw) => createArgs.parse(raw),
  authorize: async (_args, actor, action) => {
    await loadDealWriter(actor);
    if (action.status === "EXECUTED") await authorizeDealResult(actor, action.result);
  },
  async snapshot(args, actionActor) {
    await loadDealWriter(actionActor);
    const [client, property, liveDeal] = await Promise.all([
      prisma.client.findUnique({
        where: { id: args.clientId },
        select: { assignedAgentId: true, kind: true, deletedAt: true, assignmentCompletedAt: true },
      }),
      prisma.property.findUnique({
        where: { id: args.propertyId },
        select: { status: true, assignedAgentId: true, reservedForClientId: true, price: true, currency: true, deletedAt: true },
      }),
      prisma.deal.findFirst({ where: { propertyId: args.propertyId, stage: { notIn: ["COMPLETED", "CANCELLED"] } }, select: { id: true } }),
    ]);
    const rate = property?.currency === "USD" ? await loadUsdRate() : null;
    return {
      client: client ? { ...client, deletedAt: iso(client.deletedAt), assignmentCompletedAt: iso(client.assignmentCompletedAt) } : null,
      property: property ? { ...property, price: amount(property.price), deletedAt: iso(property.deletedAt) } : null,
      liveDeal: liveDeal?.id ?? null,
      usdToTjsRate: rate,
    };
  },
  async buildPreview(args, raw, actionActor) {
    const { req } = await loadDealWriter(actionActor);
    const snap = raw as { usdToTjsRate: number | null };
    const planned = await createDealFor(req, { clientId: args.clientId, propertyId: args.propertyId }, { dryRun: true });
    if (!planned.ok) throw dealRefusal(planned);
    if (!("plan" in planned)) throw new Error("create_deal: проверочный прогон записал сделку");
    const plan = planned.plan;
    const lang = args.lang;
    const w = WORDS[lang];
    if (plan.currency === "USD" && snap.usdToTjsRate === null) {
      throw new AssistantActionError(409, "NO_RATE", lang === "tg"
        ? "Объект бо доллар аст, қурби доллар дар Танзимот нест — муомиларо сабт намекунам."
        : "Объект в долларах, а курс доллара в Настройках не задан — сделку с долларовой комиссией не завожу.");
    }
    const [client, property, agent] = await Promise.all([
      prisma.client.findUnique({ where: { id: plan.clientId }, select: { shortId: true, kind: true, fullName: true } }),
      prisma.property.findUnique({ where: { id: plan.propertyId }, select: { shortId: true, title: true, status: true } }),
      prisma.agent.findUnique({ where: { id: plan.agentId }, select: { fullName: true } }),
    ]);
    const clientCode = formatClientCode(client!.shortId, client!.kind);
    const propertyCode = formatPropertyCode(property!.shortId);
    const toSelf = plan.agentId === req.agent!.id;
    return {
      title: (lang === "tg" ? `🤝 Муомилаи нав: ${clientCode} · ${propertyCode}` : `🤝 Новая сделка: ${clientCode} · ${propertyCode}`),
      was: {
        [w.property]: `${propertyCode} ${plainField(property!.title, 80) ?? ""}`.trim(),
        [w.deal]: lang === "tg" ? "нест" : "нет",
      },
      becomes: {
        [w.client]: `${clientCode} ${plainField(client!.fullName, 80) ?? ""}`.trim(),
        [w.stage]: stageLabel(plan.stage, lang),
        [w.agent]: `${agent?.fullName ?? "—"}${toSelf ? (lang === "tg" ? " (шумо)" : " (вы)") : ""}`,
        ...(plan.commissionAmount !== undefined
          ? { [`💰 ${w.commission}${lang === "tg" ? " (тахминӣ)" : " (оценка)"}`]: moneyWithRate(plan.commissionAmount, plan.currency, snap.usdToTjsRate, lang) }
          : {}),
      },
      risk: lang === "tg"
        ? "Объект барои ҳамин мизоҷ захира мешавад. Комиссияи дақиқ ҳангоми бастан муайян мешавад."
        : "Объект уйдёт в резерв под этого клиента. Точная комиссия — при закрытии сделки.",
    } satisfies AssistantActionPreview;
  },
  async execute(args, actionActor) {
    const { req } = await loadDealWriter(actionActor);
    const outcome = await asActor(actionActor.agentId, () =>
      createDealFor(req, { clientId: args.clientId, propertyId: args.propertyId }));
    if (!outcome.ok) throw dealRefusal(outcome);
    if (!("deal" in outcome)) throw new Error("create_deal: нет сделки после записи");
    return { result: resultOf(req, outcome.deal), audit: { entityType: "Deal", entityId: outcome.deal.id } };
  },
};

// ─────────────────────────── change_deal_stage ───────────────────────────

const STAGE_TARGETS = ["NEGOTIATION", "AGREEMENT_PENDING", "CONTRACT_SIGNED", "CANCELLED"] as const;
const stageArgs = z.object({
  dealId: z.string().trim().uuid(),
  stage: z.enum(STAGE_TARGETS),
  reason: z.string().trim().min(3).max(500).optional(),
  lang: langSchema,
}).strict();
type StageArgs = z.infer<typeof stageArgs>;

function stageBody(args: StageArgs, snap: DealSnap) {
  return { stage: args.stage, version: snap.version, ...(args.reason ? { rejectReason: args.reason } : {}) };
}

const stageExecutor: AssistantActionExecutor<StageArgs> = {
  ...common<StageArgs>("change_deal_stage"),
  parseArgs: (raw) => stageArgs.parse(raw),
  authorize: async (_args, actor) => void (await loadDealWriter(actor)),
  snapshot: (args, actor) => snapshotDeal(args.dealId, actor),
  async buildPreview(args, raw, actionActor) {
    const snap = raw as DealSnap;
    const { req } = await loadDealWriter(actionActor);
    const lang = args.lang;
    const w = WORDS[lang];
    if (snap.stage === args.stage) {
      throw new AssistantActionError(409, "NO_CHANGE", lang === "tg" ? "Муомила аллакай дар ҳамин марҳила аст." : "Сделка уже на этом этапе — менять нечего.");
    }
    const planned = await updateDealFor(req, snap.dealId, stageBody(args, snap), { dryRun: true });
    if (!planned.ok) throw dealRefusal(planned);
    const deal = await visibleDeal(req, snap.dealId);
    const cancelling = args.stage === "CANCELLED";
    const rejecting = snap.stage === "PENDING_APPROVAL";
    return {
      title: `🤝 ${lang === "tg" ? "Марҳилаи муомила" : "Этап сделки"} ${codes(deal)}`.slice(0, 200),
      was: { [w.stage]: stageLabel(snap.stage, lang) },
      becomes: {
        [w.stage]: stageLabel(args.stage, lang),
        ...(args.reason ? { [lang === "tg" ? "Сабаб" : "Причина"]: plainField(args.reason, 200) } : {}),
      },
      ...(cancelling
        ? { risk: lang === "tg"
            ? "Объект ба фурӯш бармегардад, агар муомилаи дигар набошад. Баргардонданро танҳо роҳбар метавонад."
            : "Объект вернётся в продажу, если по нему нет других сделок. Вернуть отменённую сделку в работу может только руководитель." }
        : rejecting
          ? { risk: lang === "tg" ? "Нарх ва ҳиссаҳо тоза мешаванд — агент онҳоро аз нав ворид мекунад." : "Цена и доли обнулятся — агент введёт их заново." }
          : {}),
    } satisfies AssistantActionPreview;
  },
  async execute(args, actionActor, ctx) {
    const snap = ctx.snapshotBefore as DealSnap;
    const { req } = await loadDealWriter(actionActor);
    const outcome = await asActor(actionActor.agentId, () => updateDealFor(req, snap.dealId, stageBody(args, snap)));
    if (!outcome.ok) throw dealRefusal(outcome);
    if (!("deal" in outcome)) throw new Error("change_deal_stage: нет сделки после записи");
    return { result: resultOf(req, outcome.deal), audit: { entityType: "Deal", entityId: snap.dealId } };
  },
};

// ─────────────────────────── close_deal ───────────────────────────

const closeArgs = z.object({
  dealId: z.string().trim().uuid(),
  currency: z.enum(["TJS", "USD"]),
  soldPrice: moneySchema.positive().optional(),
  realtorAmount: moneySchema.optional(),
  companyAmount: moneySchema.optional(),
  skipDocuments: z.boolean().optional(),
  lang: langSchema,
}).strict();
type CloseArgs = z.infer<typeof closeArgs>;

/** Руководитель закрывает сам; агент отправляет на закрытие (одобрит руководитель) — как в CRM. */
function closeTarget(req: DealActor): "COMPLETED" | "PENDING_APPROVAL" {
  return canCompleteDeal(req) ? "COMPLETED" : "PENDING_APPROVAL";
}

function closeBody(args: CloseArgs, snap: DealSnap, target: string) {
  return {
    stage: target,
    version: snap.version,
    ...(args.soldPrice !== undefined ? { soldPrice: args.soldPrice } : {}),
    ...(args.realtorAmount !== undefined ? { commissionRealtorAmount: args.realtorAmount } : {}),
    ...(args.companyAmount !== undefined ? { commissionCompanyAmount: args.companyAmount } : {}),
    ...(args.skipDocuments ? { skipDocuments: true } : {}),
  };
}

const closeExecutor: AssistantActionExecutor<CloseArgs> = {
  ...common<CloseArgs>("close_deal"),
  parseArgs: (raw) => closeArgs.parse(raw),
  authorize: async (_args, actor) => void (await loadDealWriter(actor)),
  snapshot: (args, actor) => snapshotDeal(args.dealId, actor),
  async buildPreview(args, raw, actionActor) {
    const snap = raw as DealSnap;
    const { req } = await loadDealWriter(actionActor);
    const deal = await visibleDeal(req, snap.dealId);
    const lang = args.lang;
    const w = WORDS[lang];
    assertCurrency(deal, args.currency, snap.usdToTjsRate, lang);
    const target = closeTarget(req);
    const planned = await updateDealFor(req, snap.dealId, closeBody(args, snap, target), { dryRun: true });
    if (!planned.ok) throw dealRefusal(planned);
    const realtor = args.realtorAmount ?? snap.commissionRealtorAmount;
    const company = args.companyAmount ?? snap.commissionCompanyAmount;
    const sold = args.soldPrice ?? snap.soldPrice;
    const commission = realtor !== null && company !== null ? fromCents(sumCents([realtor, company])) : null;
    const rate = snap.usdToTjsRate;
    const completing = target === "COMPLETED";
    return {
      title: `🤝 ${completing
        ? (lang === "tg" ? "Бастани муомила" : "Закрыть сделку")
        : (lang === "tg" ? "Ба тасдиқи роҳбар фиристодан" : "Отправить на закрытие")} ${codes(deal)}`.slice(0, 200),
      was: {
        [w.stage]: stageLabel(snap.stage, lang),
        ...moneyFields(req, deal, {
          soldPrice: snap.soldPrice,
          commission: snap.commissionAmount,
          realtor: snap.commissionRealtorAmount,
          company: snap.commissionCompanyAmount,
        }, rate, lang),
      },
      becomes: {
        [w.stage]: stageLabel(target, lang),
        ...moneyFields(req, deal, { soldPrice: sold, commission, realtor, company }, rate, lang),
        ...(args.skipDocuments ? { [lang === "tg" ? "Ҳуҷҷатҳо" : "Документы"]: lang === "tg" ? "бе санҷиш (дар журнал)" : "без проверки (запись в журнале)" } : {}),
      },
      risk: completing
        ? (lang === "tg"
            ? "Объект «фурӯхта шуд» мешавад ва аз сайт мебарояд, ҳиссаҳо сабт мешаванд. Бозгашт нест — танҳо аннул."
            : "Объект станет «Продано» и уйдёт с сайта, доли зафиксируются, агенту начислятся баллы. Назад не вернуть — только аннулировать.")
        : (lang === "tg" ? "Роҳбар рақамҳоро тасдиқ мекунад." : "Цифры одобрит руководитель."),
      ...(completing ? { irreversible: true } : {}),
    } satisfies AssistantActionPreview;
  },
  async execute(args, actionActor, ctx) {
    const snap = ctx.snapshotBefore as DealSnap;
    const { req } = await loadDealWriter(actionActor);
    const outcome = await asActor(actionActor.agentId, () =>
      updateDealFor(req, snap.dealId, closeBody(args, snap, closeTarget(req))));
    if (!outcome.ok) throw dealRefusal(outcome);
    if (!("deal" in outcome)) throw new Error("close_deal: нет сделки после записи");
    return { result: resultOf(req, outcome.deal), audit: { entityType: "Deal", entityId: snap.dealId } };
  },
};

// ─────────────────────────── fix_deal_commission ───────────────────────────

const fixArgs = z.object({
  dealId: z.string().trim().uuid(),
  currency: z.enum(["TJS", "USD"]),
  commissionAmount: moneySchema.positive(),
  lang: langSchema,
}).strict();
type FixArgs = z.infer<typeof fixArgs>;

/** Переоценка закрытой сделки идёт по снимку долей; без снимка (старые сделки) — только в CRM. */
function hasShareSnapshot(snap: DealSnap): boolean {
  return snap.commissionIntakeAmount !== null && snap.commissionRealtorAmount !== null &&
    snap.commissionCompanyAmount !== null && (snap.commissionAmount ?? 0) > 0;
}

const fixExecutor: AssistantActionExecutor<FixArgs> = {
  ...common<FixArgs>("fix_deal_commission"),
  requires: ["deals.setCommission"],
  parseArgs: (raw) => fixArgs.parse(raw),
  authorize: async (_args, actor) => void (await loadDealWriter(actor)),
  snapshot: (args, actor) => snapshotDeal(args.dealId, actor),
  async buildPreview(args, raw, actionActor) {
    const snap = raw as DealSnap;
    const { req } = await loadDealWriter(actionActor);
    const deal = await visibleDeal(req, snap.dealId);
    const lang = args.lang;
    assertCurrency(deal, args.currency, snap.usdToTjsRate, lang);
    if (snap.commissionAmount !== null && toCents(snap.commissionAmount) === toCents(args.commissionAmount)) {
      throw new AssistantActionError(409, "NO_CHANGE", lang === "tg" ? "Комиссия аллакай ҳамин аст." : "Комиссия уже такая — менять нечего.");
    }
    const closed = snap.stage === "COMPLETED";
    if (closed && !hasShareSnapshot(snap)) {
      throw new AssistantActionError(409, "NO_SHARE_SNAPSHOT", lang === "tg"
        ? "Ин муомилаи кӯҳна ҳиссаҳои сабтшуда надорад — комиссияро дар корти CRM ислоҳ кунед."
        : "У этой старой сделки нет снимка долей — исправьте комиссию в карточке сделки в CRM.");
    }
    const planned = await updateDealFor(req, snap.dealId, { commissionAmount: args.commissionAmount, version: snap.version }, { dryRun: true });
    if (!planned.ok) throw dealRefusal(planned);
    const rate = snap.usdToTjsRate;
    // Те же копейки, что лягут в базу: одна функция с PATCH (scaleClosedCommissionShares).
    const scaled = closed ? scaleClosedCommissionShares(args.commissionAmount, snap) : null;
    return {
      title: `💰 ${lang === "tg" ? "Ислоҳи комиссия" : "Исправить комиссию"} ${codes(deal)}`.slice(0, 200),
      was: moneyFields(req, deal, {
        commission: snap.commissionAmount,
        ...(closed ? { realtor: snap.commissionRealtorAmount, company: snap.commissionCompanyAmount } : {}),
      }, rate, lang),
      becomes: moneyFields(req, deal, {
        commission: args.commissionAmount,
        ...(scaled ? { realtor: scaled.realtor, company: scaled.company } : {}),
      }, rate, lang),
      risk: closed
        ? (lang === "tg"
            ? "Ҳиссаҳо ба таносуби пештара аз нав ҳисоб мешаванд; маош барои моҳи бастан нав мешавад. Дар журнал сабт мешавад."
            : "Доли пересчитаются в прежней пропорции до копейки; зарплата за месяц закрытия обновится. Запись в журнале действий.")
        : (lang === "tg" ? "Комиссияи муомилаи кушода иваз мешавад." : "Меняется комиссия ещё не закрытой сделки."),
      ...(closed ? { irreversible: true } : {}),
    } satisfies AssistantActionPreview;
  },
  async execute(args, actionActor, ctx) {
    const snap = ctx.snapshotBefore as DealSnap;
    const { req } = await loadDealWriter(actionActor);
    const outcome = await asActor(actionActor.agentId, () =>
      updateDealFor(req, snap.dealId, { commissionAmount: args.commissionAmount, version: snap.version }));
    if (!outcome.ok) throw dealRefusal(outcome);
    if (!("deal" in outcome)) throw new Error("fix_deal_commission: нет сделки после записи");
    return { result: resultOf(req, outcome.deal), audit: { entityType: "Deal", entityId: snap.dealId } };
  },
};

// ─────────────────────────── annul_deal ───────────────────────────

const annulArgs = z.object({
  dealId: z.string().trim().uuid(),
  reason: z.string().trim().min(3).max(500),
  lang: langSchema,
}).strict();
type AnnulArgs = z.infer<typeof annulArgs>;

const annulExecutor: AssistantActionExecutor<AnnulArgs> = {
  ...common<AnnulArgs>("annul_deal"),
  requires: ["deals.complete"],
  parseArgs: (raw) => annulArgs.parse(raw),
  authorize: async (_args, actor) => void (await loadDealWriter(actor)),
  snapshot: (args, actor) => snapshotDeal(args.dealId, actor),
  async buildPreview(args, raw, actionActor) {
    const snap = raw as DealSnap;
    const { req } = await loadDealWriter(actionActor);
    const planned = await annulDealFor(req, snap.dealId, { reason: args.reason }, { dryRun: true });
    if (!planned.ok) throw dealRefusal(planned);
    const deal = await visibleDeal(req, snap.dealId);
    const lang = args.lang;
    const w = WORDS[lang];
    return {
      title: `🤝 ${lang === "tg" ? "Аннул кардани муомила" : "Аннулировать сделку"} ${codes(deal)}`.slice(0, 200),
      was: { [w.stage]: stageLabel(snap.stage, lang) },
      becomes: {
        [w.stage]: stageLabel("CANCELLED", lang, true),
        [lang === "tg" ? "Сабаб" : "Причина"]: plainField(args.reason, 200),
      },
      risk: lang === "tg"
        ? "Муомила дар ҳисобот ба ҳисоб намеравад, объект ба фурӯш бармегардад, холҳо гирифта мешаванд. Баргардонда намешавад."
        : "Сделка перестанет считаться продажей, объект вернётся в продажу, баллы за сделку снимутся. Вернуть нельзя — только завести новую.",
      irreversible: true,
    } satisfies AssistantActionPreview;
  },
  async execute(args, actionActor, ctx) {
    const snap = ctx.snapshotBefore as DealSnap;
    const { req } = await loadDealWriter(actionActor);
    const outcome = await asActor(actionActor.agentId, () => annulDealFor(req, snap.dealId, { reason: args.reason }));
    if (!outcome.ok) throw dealRefusal(outcome);
    return {
      result: { dealId: outcome.result.id, stage: outcome.result.stage, annulled: true, propertyReturnedToSale: outcome.result.propertyReturnedToSale, href: "/deals" },
      audit: { entityType: "Deal", entityId: snap.dealId },
    };
  },
};

// ─────────────────────────── mark_deal_payout ───────────────────────────

const payoutArgs = z.object({
  dealId: z.string().trim().uuid(),
  note: z.string().trim().max(500).optional(),
  lang: langSchema,
}).strict();
type PayoutArgs = z.infer<typeof payoutArgs>;

const payoutExecutor: AssistantActionExecutor<PayoutArgs> = {
  ...common<PayoutArgs>("mark_deal_payout"),
  parseArgs: (raw) => payoutArgs.parse(raw),
  authorize: async (_args, actor) => void (await loadDealWriter(actor)),
  snapshot: (args, actor) => snapshotDeal(args.dealId, actor),
  async buildPreview(args, raw, actionActor) {
    const snap = raw as DealSnap;
    const { req } = await loadDealWriter(actionActor);
    const lang = args.lang;
    const w = WORDS[lang];
    const planned = await markDealPayoutFor(req, snap.dealId, args.note ? { note: args.note } : {}, { dryRun: true });
    if (!planned.ok) throw dealRefusal(planned);
    const deal = await visibleDeal(req, snap.dealId);
    const share = snap.commissionRealtorAmount;
    return {
      title: `✅ ${lang === "tg" ? "Пардохт ба агент" : "Выплата агенту"} ${codes(deal)}`.slice(0, 200),
      was: { [`👤 ${w.realtor}`]: `${moneyWithRate(share, snap.currency, snap.usdToTjsRate, lang)} — ⏳ ${w.waiting}` },
      becomes: {
        [w.agent]: deal.agent.fullName,
        [`👤 ${w.realtor}`]: `${moneyWithRate(share, snap.currency, snap.usdToTjsRate, lang)} — ✅ ${w.paid}`,
        ...(args.note ? { [lang === "tg" ? "Эзоҳ" : "Заметка"]: plainField(args.note, 200) } : {}),
      },
      risk: lang === "tg"
        ? "Агент огоҳинома мегирад. Қайди пардохтро бекор кардан мумкин нест."
        : "Агент получит уведомление. Отметку о выплате потом не снять.",
      irreversible: true,
    } satisfies AssistantActionPreview;
  },
  async execute(args, actionActor, ctx) {
    const snap = ctx.snapshotBefore as DealSnap;
    const { req } = await loadDealWriter(actionActor);
    const outcome = await asActor(actionActor.agentId, () =>
      markDealPayoutFor(req, snap.dealId, args.note ? { note: args.note } : {}));
    if (!outcome.ok) throw dealRefusal(outcome);
    return {
      result: { dealId: snap.dealId, paidAt: outcome.payout.realtorPayoutAt.toISOString(), href: "/deals" },
      audit: { entityType: "Deal", entityId: snap.dealId },
    };
  },
};

// ─────────────────────────── плагины ───────────────────────────

const canMarkPayout = (actor: { permissions?: ReadonlySet<string> }) =>
  Boolean(actor.permissions?.has("finance.manage") || actor.permissions?.has("deals.setCommission"));

export const dealWriteTools: AssistantWriteToolPlugin[] = [
  {
    name: "create_deal",
    level: "C",
    statusPhrase: "Готовлю сделку…",
    description:
      "Завести сделку: покупатель + объект. Зови на «открой сделку по клиенту … на объект …». clientId — из search_clients, " +
      "propertyId — из find_property. Агент сделки и комиссия по Настройкам — как в CRM. Ничего не меняет сам: " +
      "готовит карточку «было → станет», исполняет человек кнопкой «Подтвердить».",
    parameters: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "ID покупателя (из search_clients)" },
        propertyId: { type: "string", description: "ID объекта (из find_property)" },
        lang: LANG_PROP,
      },
      required: ["clientId", "propertyId"],
    },
    allowed: dealWritesAllowed,
    executor: asPluginExecutor(createExecutor),
  },
  {
    name: "change_deal_stage",
    level: "C",
    statusPhrase: "Готовлю смену этапа сделки…",
    description:
      "Сменить этап сделки: переговоры, согласование, договор подписан или отменить сделку. Для закрытия с суммами — close_deal. " +
      "Вернуть сделку с «Ждёт одобрения» на доработку может руководитель, и тогда нужна причина (reason). dealId — из search_deals. " +
      "Готовит карточку «было → станет», исполняет человек кнопкой «Подтвердить».",
    parameters: {
      type: "object",
      properties: {
        dealId: { type: "string", description: "ID сделки (из search_deals)" },
        stage: { type: "string", enum: [...STAGE_TARGETS], description: "Новый этап" },
        reason: { type: "string", description: "Причина: обязательна при возврате на доработку" },
        lang: LANG_PROP,
      },
      required: ["dealId", "stage"],
    },
    allowed: dealWritesAllowed,
    executor: asPluginExecutor(stageExecutor),
  },
  {
    name: "close_deal",
    level: "C",
    statusPhrase: "Готовлю закрытие сделки…",
    description:
      "Закрыть сделку с фактической ценой продажи и комиссией: доля агента (realtorAmount) и доля компании (companyAmount). " +
      "Руководитель закрывает сразу, агент — отправляет на одобрение руководителю. Одобрить уже отправленную сделку руководитель " +
      "может без сумм. currency — валюта, в которой сотрудник назвал суммы (TJS или USD); не пересчитывай сам. " +
      "Если суммы не названы — спроси, не придумывай. Исполняет человек кнопкой «Подтвердить».",
    parameters: {
      type: "object",
      properties: {
        dealId: { type: "string", description: "ID сделки (из search_deals)" },
        currency: { type: "string", enum: ["TJS", "USD"], description: "Валюта названных сумм" },
        soldPrice: { type: "number", description: "Фактическая цена продажи" },
        realtorAmount: { type: "number", description: "Доля агента суммой" },
        companyAmount: { type: "number", description: "Доля компании суммой" },
        skipDocuments: { type: "boolean", description: "Только руководитель и только по прямой просьбе: закрыть без обязательных документов" },
        lang: LANG_PROP,
      },
      required: ["dealId", "currency"],
    },
    allowed: dealWritesAllowed,
    executor: asPluginExecutor(closeExecutor),
  },
  {
    name: "fix_deal_commission",
    level: "C",
    statusPhrase: "Готовлю исправление комиссии…",
    description:
      "Руководителю: исправить общую сумму комиссии сделки (опечатка). У закрытой сделки доли агента и компании пересчитаются " +
      "в прежней пропорции до копейки — как в CRM. currency — валюта названной суммы (TJS или USD). " +
      "Исполняет человек кнопкой «Подтвердить».",
    parameters: {
      type: "object",
      properties: {
        dealId: { type: "string", description: "ID сделки (из search_deals)" },
        currency: { type: "string", enum: ["TJS", "USD"], description: "Валюта названной суммы" },
        commissionAmount: { type: "number", description: "Новая общая комиссия" },
        lang: LANG_PROP,
      },
      required: ["dealId", "currency", "commissionAmount"],
    },
    allowed: (actor) => dealWritesAllowed(actor) && Boolean(actor.permissions?.has("deals.setCommission")),
    executor: asPluginExecutor(fixExecutor),
  },
  {
    name: "annul_deal",
    level: "C",
    statusPhrase: "Готовлю аннулирование сделки…",
    description:
      "Руководителю: аннулировать ЗАКРЫТУЮ сделку (ошибка, мошенничество) с причиной. Незакрытую сделку не аннулируют — " +
      "её отменяют через change_deal_stage. Необратимо. Исполняет человек кнопкой «Подтвердить».",
    parameters: {
      type: "object",
      properties: {
        dealId: { type: "string", description: "ID сделки (из search_deals)" },
        reason: { type: "string", description: "Причина аннулирования словами сотрудника" },
        lang: LANG_PROP,
      },
      required: ["dealId", "reason"],
    },
    allowed: (actor) => dealWritesAllowed(actor) && Boolean(actor.permissions?.has("deals.complete")),
    executor: asPluginExecutor(annulExecutor),
  },
  {
    name: "mark_deal_payout",
    level: "C",
    statusPhrase: "Готовлю отметку о выплате…",
    description:
      "Отметить, что доля агента по закрытой сделке выплачена. Один раз на сделку: уже выплаченную второй раз не отметить. " +
      "dealId — из get_payouts_due или search_deals. Исполняет человек кнопкой «Подтвердить».",
    parameters: {
      type: "object",
      properties: {
        dealId: { type: "string", description: "ID закрытой сделки" },
        note: { type: "string", description: "Заметка к выплате, если сотрудник её назвал" },
        lang: LANG_PROP,
      },
      required: ["dealId"],
    },
    allowed: (actor) => dealWritesAllowed(actor) && canMarkPayout(actor),
    executor: asPluginExecutor(payoutExecutor),
  },
];
