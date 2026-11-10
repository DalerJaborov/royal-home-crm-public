import { z } from "zod";
import { DEAL_DOCUMENT_KIND_LABELS, formatClientCode, formatPropertyCode, type DealDocumentKind } from "@royal-home/shared";
import { can, scopeDealsToOwnAgent } from "../../../auth/middleware.js";
import { prisma } from "../../../db.js";
import { clientNamePhoneSafe } from "../../../lib/clientPhone.js";
import { getDealRequiredDocuments, listDealDocuments } from "../../../lib/dealDocumentsDb.js";
import { seesDealMoneyFor } from "../../../lib/dealWrites.js";
import { dushanbeMonthRange, dushanbeWallClock } from "../../../lib/dushanbeTime.js";
import { fromCents, toCents } from "../../../lib/money.js";
import { safeField } from "./safeField.js";
import {
  dealActorOf,
  dealLang,
  dealToolsAllowed,
  ISO_DAY,
  loadUsdRate,
  money,
  moneyWithRate,
  monthKeyOf,
  NOT_PRIVATE_ERROR,
  stageLabel,
  usdToTjs,
  WORDS,
  type DealLang,
} from "./dealToolSupport.js";
import type { AssistantReadToolPlugin } from "./types.js";

/**
 * ЧТЕНИЕ РАЗДЕЛА «СДЕЛКИ» ДЛЯ ШАБНАМ (10.11.2026): карточка сделки, «сколько я
 * заработал» и «кому сколько выплатить». Только личка (dealToolsAllowed), права
 * — те же функции, что у REST: scopeDealsToOwnAgent (чужие сделки — deals.viewAll),
 * seesDealMoneyFor (деньги сделки), deals.manageDocuments (документы), finance.view
 * (чужие доли и выплаты всей команде). Список сделок — встроенный search_deals.
 *
 * «Сколько я заработал» — ТОЛЬКО свои доли: доля агента по своим сделкам и доля за
 * приём объекта, если она есть. Общая комиссия и доля компании туда не попадают.
 * Ничего не пишет и сама никому не пишет: отвечает только на вопрос человека.
 */

const LANG_PROP = {
  type: "string",
  enum: ["ru", "tg"],
  description: "Язык, на котором пишет сотрудник: ru — русский, tg — таджикский",
} as const;

const dealCardArgs = z.object({ dealId: z.string().trim().uuid(), lang: z.enum(["ru", "tg"]).optional() });
const monthArgs = z.object({
  month: z.string().trim().max(7).optional(),
  lang: z.enum(["ru", "tg"]).optional(),
});

type Totals = Map<string, number>; // валюта → сотые
const add = (totals: Totals, currency: string, cents: number) => totals.set(currency, (totals.get(currency) ?? 0) + cents);

/** Итог по валютам + в сомони по курсу (доллары без курса в сомони не пересчитываются). */
function totalsView(totals: Totals, rate: number | null, lang: DealLang) {
  const byCurrency = [...totals.entries()].filter(([, cents]) => cents !== 0)
    .map(([currency, cents]) => ({ currency, amount: fromCents(cents), text: moneyWithRate(fromCents(cents), currency, rate, lang) }));
  const usd = totals.get("USD") ?? 0;
  const tjs = totals.get("TJS") ?? 0;
  const totalTjs = usd !== 0 && rate === null ? null : fromCents(tjs + toCents(usd !== 0 ? usdToTjs(fromCents(usd), rate!) : 0));
  return { byCurrency, totalTJS: totalTjs, totalText: totalTjs === null ? null : money(totalTjs, "TJS", lang) };
}

const sum = (totals: Totals) => [...totals.values()].reduce((a, b) => a + b, 0);

export const getDealCardTool: AssistantReadToolPlugin = {
  name: "get_deal_card",
  level: "A",
  statusPhrase: "Открываю сделку…",
  description:
    "Карточка одной сделки: этап, клиент, объект, агент, цена продажи, комиссия и её доли (агент, компания), " +
    "выплачена ли доля агенту, документы сделки и каких обязательных не хватает. dealId возьми из search_deals. " +
    "Деньги видны по тем же правам, что в CRM. Отвечай коротко, со смайликами по смыслу: 🤝 сделка, 💰 комиссия, " +
    "👤 доля агента, 🏢 доля компании, ✅ выплачено, ⏳ ждёт. Суммы и курс бери ровно из поля display.",
  parameters: {
    type: "object",
    properties: { dealId: { type: "string", description: "ID сделки из search_deals" }, lang: LANG_PROP },
    required: ["dealId"],
  },
  allowed: dealToolsAllowed,
  async run(raw, { actor, question }) {
    if (!dealToolsAllowed(actor)) return { error: NOT_PRIVATE_ERROR };
    const parsed = dealCardArgs.safeParse(raw);
    if (!parsed.success) return { error: "Не понял, какая сделка. Найдите её через поиск сделок." };
    const lang = dealLang(parsed.data.lang, question);
    const w = WORDS[lang];
    const req = dealActorOf(actor);
    const deal = await prisma.deal.findUnique({
      where: { id: parsed.data.dealId },
      include: {
        client: { select: { shortId: true, kind: true, fullName: true, deletedAt: true } },
        property: { select: { shortId: true, title: true, price: true, currency: true } },
        agent: { select: { fullName: true } },
      },
    });
    const own = scopeDealsToOwnAgent(req);
    // Чужая сделка без deals.viewAll и сделка клиента из Корзины — «не найдена», как у search_deals.
    if (!deal || deal.client.deletedAt || (own && deal.agentId !== own)) return { error: "Сделка не найдена" };

    const seesMoney = seesDealMoneyFor(req, deal);
    const rate = deal.currency === "USD" && seesMoney ? await loadUsdRate() : null;
    const cur = deal.currency;
    const intake = deal.commissionIntakeAmount !== null && toCents(deal.commissionIntakeAmount) > 0 ? deal.commissionIntakeAmount : null;
    const moneyBlock = seesMoney
      ? {
          currency: cur,
          usdToTjsRate: cur === "USD" ? rate : undefined,
          soldPrice: deal.soldPrice !== null ? moneyWithRate(deal.soldPrice, cur, rate, lang) : null,
          commission: deal.commissionAmount !== null ? moneyWithRate(deal.commissionAmount, cur, rate, lang) : null,
          commissionPercent: deal.commissionPercent !== null ? Number(deal.commissionPercent) : null,
          realtorShare: deal.commissionRealtorAmount !== null ? moneyWithRate(deal.commissionRealtorAmount, cur, rate, lang) : null,
          companyShare: deal.commissionCompanyAmount !== null ? moneyWithRate(deal.commissionCompanyAmount, cur, rate, lang) : null,
          ...(intake ? { intakeShare: moneyWithRate(intake, cur, rate, lang) } : {}),
        }
      : null;
    const paid = deal.realtorPayoutAt ? ISO_DAY(dushanbeWallClock(deal.realtorPayoutAt)) : null;

    let documents: { kind: string; name: string | null; uploadedAt: string }[] | undefined;
    let missingDocuments: string[] | undefined;
    if (can(req, "deals.manageDocuments")) {
      const [rows, required] = await Promise.all([listDealDocuments(deal.id), getDealRequiredDocuments()]);
      documents = rows.slice(0, 30).map((d) => ({
        kind: DEAL_DOCUMENT_KIND_LABELS[d.kind as DealDocumentKind] ?? d.kind,
        name: safeField(d.originalName, 120),
        uploadedAt: ISO_DAY(dushanbeWallClock(d.uploadedAt)),
      }));
      const have = new Set(rows.map((d) => d.kind as string));
      missingDocuments = required.filter((k) => !have.has(k)).map((k) => DEAL_DOCUMENT_KIND_LABELS[k as DealDocumentKind] ?? k);
    }

    const clientCode = formatClientCode(deal.client.shortId, deal.client.kind);
    const propertyCode = formatPropertyCode(deal.property.shortId);
    const stage = stageLabel(deal.stage, lang, Boolean(deal.annulledAt));
    const display = [
      `🤝 ${w.deal}: ${clientCode} · ${propertyCode} — ${stage}`,
      `${w.agent}: ${deal.agent.fullName}`,
      ...(moneyBlock
        ? [
            moneyBlock.soldPrice ? `${w.price}: ${moneyBlock.soldPrice}` : null,
            moneyBlock.commission ? `💰 ${w.commission}: ${moneyBlock.commission}` : null,
            moneyBlock.realtorShare ? `👤 ${w.realtor}: ${moneyBlock.realtorShare}` : null,
            moneyBlock.companyShare ? `🏢 ${w.company}: ${moneyBlock.companyShare}` : null,
          ]
        : []),
      deal.stage === "COMPLETED" ? (paid ? `✅ ${w.paid}: ${paid}` : `⏳ ${w.waiting}`) : null,
    ].filter(Boolean).join("\n");

    return {
      id: deal.id,
      client: safeField(clientNamePhoneSafe(deal.client.fullName, actor.canViewPhone)),
      clientCode,
      property: safeField(deal.property.title),
      propertyCode,
      agent: deal.agent.fullName,
      stage: deal.stage,
      stageLabel: stage,
      annulled: Boolean(deal.annulledAt),
      startedAt: ISO_DAY(dushanbeWallClock(deal.startedAt)),
      closedAt: deal.closedAt ? ISO_DAY(dushanbeWallClock(deal.closedAt)) : null,
      ...(moneyBlock ? { money: moneyBlock } : { money: "Суммы этой сделки вам не показываются" }),
      ...(deal.stage === "COMPLETED" ? { realtorPaidAt: paid } : {}),
      ...(documents ? { documents, missingDocuments } : {}),
      href: `/deals`,
      display,
    };
  },
};

/** Своя доля в сделке: агент сделки — доля агента, принявший объект — доля за приём. */
function ownShareCents(deal: {
  agentId: string;
  commissionRealtorAmount: unknown;
  commissionIntakeAgentId: string | null;
  commissionIntakeAmount: unknown;
}, agentId: string): number {
  let cents = 0;
  if (deal.agentId === agentId && deal.commissionRealtorAmount !== null) cents += toCents(deal.commissionRealtorAmount);
  if (deal.commissionIntakeAgentId === agentId && deal.commissionIntakeAmount !== null) cents += toCents(deal.commissionIntakeAmount);
  return cents;
}

export const getMyCommissionTool: AssistantReadToolPlugin = {
  name: "get_my_commission",
  level: "A",
  statusPhrase: "Считаю ваши доли…",
  description:
    "Сколько САМ сотрудник заработал за месяц по закрытым сделкам (только его доли: доля агента и доля за приём объекта) " +
    "и сколько ему ещё не выплачено по всем закрытым сделкам. Зови на «сколько я заработал», «сколько мне не выплатили». " +
    "Про других сотрудников и про долю компании этот инструмент не отвечает. month — «YYYY-MM» (по умолчанию текущий). " +
    "Отвечай коротко, со смайликами 👤 💰 ✅ ⏳; суммы и курс — ровно из display.",
  parameters: {
    type: "object",
    properties: { month: { type: "string", description: "Месяц YYYY-MM, например 2026-10" }, lang: LANG_PROP },
  },
  allowed: dealToolsAllowed,
  async run(raw, { actor, question }) {
    if (!dealToolsAllowed(actor)) return { error: NOT_PRIVATE_ERROR };
    const parsed = monthArgs.safeParse(raw);
    const lang = dealLang(parsed.success ? parsed.data.lang : undefined, question);
    const w = WORDS[lang];
    const month = monthKeyOf(parsed.success ? parsed.data.month : undefined, dushanbeWallClock().toISOString());
    const { from, to } = dushanbeMonthRange(month);
    const mine = { OR: [{ agentId: actor.id }, { commissionIntakeAgentId: actor.id }] };
    const select = {
      id: true,
      agentId: true,
      currency: true,
      closedAt: true,
      commissionRealtorAmount: true,
      commissionIntakeAgentId: true,
      commissionIntakeAmount: true,
      realtorPayoutAt: true,
      property: { select: { shortId: true } },
    } as const;
    const [monthDeals, unpaidDeals, rate] = await Promise.all([
      prisma.deal.findMany({ where: { stage: "COMPLETED", closedAt: { gte: from, lt: to }, ...mine }, select, orderBy: { closedAt: "asc" }, take: 500 }),
      prisma.deal.findMany({
        where: { stage: "COMPLETED", agentId: actor.id, realtorPayoutAt: null, commissionRealtorAmount: { gt: 0 } },
        select,
        orderBy: { closedAt: "asc" },
        take: 500,
      }),
      loadUsdRate(),
    ]);

    const earned: Totals = new Map();
    const paid: Totals = new Map();
    const deals = monthDeals.map((d) => {
      const cents = ownShareCents(d, actor.id);
      add(earned, d.currency, cents);
      if (d.agentId === actor.id && d.realtorPayoutAt) add(paid, d.currency, toCents(d.commissionRealtorAmount));
      return {
        dealId: d.id,
        property: formatPropertyCode(d.property.shortId),
        closedAt: d.closedAt ? ISO_DAY(dushanbeWallClock(d.closedAt)) : null,
        myShare: moneyWithRate(fromCents(cents), d.currency, rate, lang),
        paid: Boolean(d.agentId === actor.id && d.realtorPayoutAt),
      };
    });
    const unpaid: Totals = new Map();
    for (const d of unpaidDeals) add(unpaid, d.currency, toCents(d.commissionRealtorAmount));

    const earnedView = totalsView(earned, rate, lang);
    const unpaidView = totalsView(unpaid, rate, lang);
    const line = (view: ReturnType<typeof totalsView>) =>
      view.byCurrency.length === 0
        ? money(0, "TJS", lang)
        : view.byCurrency.map((c) => c.text).join(" + ") + (view.byCurrency.length > 1 && view.totalText ? ` = ${view.totalText}` : "");
    const display = [
      `👤 ${lang === "tg" ? `Ҳиссаи шумо барои ${month}` : `Ваши доли за ${month}`}: ${line(earnedView)} (${monthDeals.length})`,
      sum(paid) > 0 ? `✅ ${w.paid}: ${line(totalsView(paid, rate, lang))}` : null,
      `⏳ ${lang === "tg" ? "Ҳанӯз пардохт нашудааст (ҳамаи муомилаҳо)" : "Ещё не выплачено (все закрытые сделки)"}: ${line(unpaidView)} (${unpaidDeals.length})`,
    ].filter(Boolean).join("\n");

    return {
      scope: "только ваши доли",
      month,
      dealsClosed: monthDeals.length,
      earned: earnedView,
      unpaidAllTime: { ...unpaidView, deals: unpaidDeals.length },
      deals: deals.slice(0, 30),
      display,
    };
  },
};

const agentArgs = z.object({
  month: z.string().trim().max(7).optional(),
  lang: z.enum(["ru", "tg"]).optional(),
});

export const getPayoutsDueTool: AssistantReadToolPlugin = {
  name: "get_payouts_due",
  level: "A",
  statusPhrase: "Считаю выплаты агентам…",
  description:
    "Руководству: кому сколько выплатить за месяц — доли агентов по сделкам, закрытым в этом месяце, что уже выплачено " +
    "и что ждёт выплаты, по каждому агенту. Зови на «кому сколько выплатить за октябрь», «сколько должны агентам». " +
    "month — «YYYY-MM» (по умолчанию текущий). Отметить выплату — mark_deal_payout по dealId из unpaidDeals. " +
    "Смайлики: 👤 агент, ✅ выплачено, ⏳ ждёт; суммы и курс — ровно из display.",
  parameters: {
    type: "object",
    properties: { month: { type: "string", description: "Месяц YYYY-MM, например 2026-10" }, lang: LANG_PROP },
  },
  allowed: (actor) => dealToolsAllowed(actor) && actor.canViewFinance,
  async run(raw, { actor, question }) {
    if (!dealToolsAllowed(actor)) return { error: NOT_PRIVATE_ERROR };
    // Чужие доли — деньги всей команды: то же право, что «Финансы» (finance.view).
    if (!actor.canViewFinance) return { error: "Выплаты команде видит только руководство" };
    const parsed = agentArgs.safeParse(raw);
    const lang = dealLang(parsed.success ? parsed.data.lang : undefined, question);
    const w = WORDS[lang];
    const month = monthKeyOf(parsed.success ? parsed.data.month : undefined, dushanbeWallClock().toISOString());
    const { from, to } = dushanbeMonthRange(month);
    const [deals, rate] = await Promise.all([
      prisma.deal.findMany({
        where: { stage: "COMPLETED", closedAt: { gte: from, lt: to } },
        select: {
          id: true,
          agentId: true,
          currency: true,
          commissionRealtorAmount: true,
          commissionIntakeAgentId: true,
          commissionIntakeAmount: true,
          realtorPayoutAt: true,
          agent: { select: { fullName: true } },
          property: { select: { shortId: true } },
        },
        orderBy: { closedAt: "asc" },
        take: 1000,
      }),
      loadUsdRate(),
    ]);
    const intakeIds = [...new Set(deals.map((d) => d.commissionIntakeAgentId).filter((id): id is string => Boolean(id)))];
    const intakeNames = new Map(
      (await prisma.agent.findMany({ where: { id: { in: intakeIds } }, select: { id: true, fullName: true } })).map((a) => [a.id, a.fullName]),
    );

    interface Row { name: string; earned: Totals; paid: Totals; due: Totals; unpaidDeals: { dealId: string; property: string; share: string }[] }
    const byAgent = new Map<string, Row>();
    const row = (id: string, name: string) => {
      let r = byAgent.get(id);
      if (!r) byAgent.set(id, (r = { name, earned: new Map(), paid: new Map(), due: new Map(), unpaidDeals: [] }));
      return r;
    };
    for (const d of deals) {
      const realtor = d.commissionRealtorAmount !== null ? toCents(d.commissionRealtorAmount) : 0;
      if (realtor > 0) {
        const r = row(d.agentId, d.agent.fullName);
        add(r.earned, d.currency, realtor);
        if (d.realtorPayoutAt) add(r.paid, d.currency, realtor);
        else {
          add(r.due, d.currency, realtor);
          if (r.unpaidDeals.length < 20) {
            r.unpaidDeals.push({ dealId: d.id, property: formatPropertyCode(d.property.shortId), share: moneyWithRate(fromCents(realtor), d.currency, rate, lang) });
          }
        }
      }
      const intake = d.commissionIntakeAmount !== null ? toCents(d.commissionIntakeAmount) : 0;
      if (intake > 0 && d.commissionIntakeAgentId) {
        // Доля за приём объекта: отметки выплаты в CRM у неё нет — считается «ждёт».
        const r = row(d.commissionIntakeAgentId, intakeNames.get(d.commissionIntakeAgentId) ?? "Сотрудник");
        add(r.earned, d.currency, intake);
        add(r.due, d.currency, intake);
      }
    }
    const agents = [...byAgent.values()].sort((a, b) => a.name.localeCompare(b.name, "ru")).map((r) => ({
      agent: r.name,
      earned: totalsView(r.earned, rate, lang),
      paid: totalsView(r.paid, rate, lang),
      due: totalsView(r.due, rate, lang),
      unpaidDeals: r.unpaidDeals,
    }));
    const text = (v: ReturnType<typeof totalsView>) =>
      v.byCurrency.length === 0 ? money(0, "TJS", lang) : v.byCurrency.map((c) => c.text).join(" + ") + (v.byCurrency.length > 1 && v.totalText ? ` = ${v.totalText}` : "");
    const display = agents.length === 0
      ? (lang === "tg" ? `Дар ${month} муомилаи басташуда нест.` : `За ${month} закрытых сделок нет.`)
      : [
          lang === "tg" ? `💰 Пардохт ба агентҳо барои ${month}:` : `💰 Выплаты агентам за ${month}:`,
          ...agents.map((a) =>
            `👤 ${a.agent}: ⏳ ${text(a.due)}` + (a.paid.byCurrency.length ? ` · ✅ ${w.paid.toLowerCase()} ${text(a.paid)}` : ""),
          ),
        ].join("\n");
    return { month, dealsClosed: deals.length, agents, display };
  },
};

export const dealReadTools: AssistantReadToolPlugin[] = [getDealCardTool, getMyCommissionTool, getPayoutsDueTool];
