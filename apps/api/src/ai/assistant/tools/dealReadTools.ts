import { z } from "zod";
import { DEAL_DOCUMENT_KIND_LABELS, formatClientCode, formatPropertyCode, type DealDocumentKind } from "@royal-home/shared";
import { can, scopeDealsToOwnAgent } from "../../../auth/middleware.js";
import { prisma } from "../../../db.js";
import { clientNamePhoneSafe } from "../../../lib/clientPhone.js";
import { getDealRequiredDocuments, listDealDocuments } from "../../../lib/dealDocumentsDb.js";
import { seesDealMoneyFor } from "../../../lib/dealWrites.js";
import { agentPayoutsReport, type AgentMonthPayout, type CentsByCurrency } from "../../../lib/dealPayouts.js";
import { dushanbeWallClock } from "../../../lib/dushanbeTime.js";
import { fromCents, loadConfiguredUsdRate, toCents } from "../../../lib/money.js";
import { safeField } from "./safeField.js";
import {
  dealActorOf,
  dealLang,
  dealToolsAllowed,
  ISO_DAY,
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

/** Суммы по валютам (сотые) → строки для ответа; доллары — с курсом из Настроек, подписано «по курсу сегодня». */
function totalsView(bag: CentsByCurrency, rate: number | null, lang: DealLang) {
  const entries = Object.entries(bag).filter(([, cents]) => cents !== 0);
  const byCurrency = entries.map(([currency, cents]) => ({ currency, amount: fromCents(cents), text: moneyWithRate(fromCents(cents), currency, rate, lang) }));
  const usd = bag.USD ?? 0;
  const tjs = bag.TJS ?? 0;
  const totalTJS = usd !== 0 && rate === null ? null : fromCents(tjs + toCents(usd !== 0 ? usdToTjs(fromCents(usd), rate!) : 0));
  const today = usd !== 0 && rate !== null ? (lang === "tg" ? " (бо қурби имрӯза)" : " (по курсу сегодня)") : "";
  const text = byCurrency.length === 0
    ? money(0, "TJS", lang)
    : byCurrency.map((c) => c.text).join(" + ") + (byCurrency.length > 1 && totalTJS !== null ? ` = ${money(totalTJS, "TJS", lang)}` : "") + today;
  return { byCurrency, totalTJS, text };
}

const merge = (into: CentsByCurrency, from: CentsByCurrency) => {
  for (const [c, cents] of Object.entries(from)) into[c] = (into[c] ?? 0) + cents;
  return into;
};
const nonZero = (bag: CentsByCurrency) => Object.values(bag).some((c) => c !== 0);

const INTAKE_NOTE = {
  ru: "выплата приёмщику в CRM не отмечается",
  tg: "пардохт ба қабулкунанда дар CRM қайд намешавад",
} as const;

function monthView(m: AgentMonthPayout, rate: number | null, lang: DealLang) {
  return {
    month: m.month,
    earned: totalsView(m.earned, rate, lang),
    paid: totalsView(m.paid, rate, lang),
    due: totalsView(m.due, rate, lang),
    ...(nonZero(m.intakeNotTracked) ? { intakeShare: { ...totalsView(m.intakeNotTracked, rate, lang), note: INTAKE_NOTE[lang] } } : {}),
    // Строка «Зарплата из сделок» в Финансах: заморожена, с ней сходятся итоги месяца.
    salaryRowTJS: m.salaryRowTjs,
    unpaidDeals: m.unpaidDeals.map((d) => ({
      dealId: d.dealId,
      property: formatPropertyCode(d.propertyShortId),
      closedAt: d.closedAt,
      share: moneyWithRate(fromCents(d.realtorCents), d.currency, rate, lang),
    })),
  };
}

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
    const rate = deal.currency === "USD" && seesMoney ? await loadConfiguredUsdRate() : null;
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

export const getMyCommissionTool: AssistantReadToolPlugin = {
  name: "get_my_commission",
  level: "A",
  statusPhrase: "Считаю ваши доли…",
  description:
    "Сколько САМ сотрудник заработал за месяц по закрытым сделкам (только его доли: доля агента и доля за приём объекта) " +
    "и сколько ему ещё не выплачено по всем закрытым сделкам за все месяцы. Зови на «сколько я заработал», «сколько мне не выплатили». " +
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
    // Одно правило с «Финансами» и REST GET /deals/payouts (lib/dealPayouts.ts), только свои доли.
    const [monthReport, openReport, rate] = await Promise.all([
      agentPayoutsReport({ month }, { agentId: actor.id }),
      agentPayoutsReport({ open: true }, { agentId: actor.id }),
      loadConfiguredUsdRate(),
    ]);
    const own = monthReport.agents.find((a) => a.agentId === actor.id)?.months[0];
    const view = own ? monthView(own, rate, lang) : null;
    const allDue: CentsByCurrency = {};
    let unpaidDeals = 0;
    for (const m of openReport.agents.find((a) => a.agentId === actor.id)?.months ?? []) {
      merge(allDue, m.due);
      unpaidDeals += m.unpaidDeals.length;
    }
    const unpaid = totalsView(allDue, rate, lang);
    const earned = view?.earned ?? totalsView({}, rate, lang);
    const display = [
      `👤 ${lang === "tg" ? `Ҳиссаи шумо барои ${month}` : `Ваши доли за ${month}`}: ${earned.text}`,
      view && view.paid.byCurrency.length ? `✅ ${w.paid}: ${view.paid.text}` : null,
      view?.intakeShare ? `${w.intake}: ${view.intakeShare.text} — ${view.intakeShare.note}` : null,
      `⏳ ${lang === "tg" ? "Ҳанӯз пардохт нашудааст (ҳамаи моҳҳо)" : "Ещё не выплачено (все месяцы)"}: ${unpaid.text}`,
    ].filter(Boolean).join("\n");
    return {
      scope: "только ваши доли",
      month,
      earned,
      ...(view ? { paid: view.paid, ...(view.intakeShare ? { intakeShare: view.intakeShare } : {}), salaryRowTJS: view.salaryRowTJS } : {}),
      unpaidAllTime: { ...unpaid, deals: unpaidDeals },
      display,
    };
  },
};

export const getPayoutsDueTool: AssistantReadToolPlugin = {
  name: "get_payouts_due",
  level: "A",
  statusPhrase: "Считаю выплаты агентам…",
  description:
    "Руководству: кому сколько выплатить. С month («YYYY-MM») — доли по сделкам, закрытым в этом месяце: всего, выплачено, ждёт. " +
    "Без month — сколько должны агентам за ВСЕ месяцы (всё невыплаченное). Зови на «кому сколько выплатить за октябрь», " +
    "«сколько должны агентам». Отметить выплату — mark_deal_payout по dealId из unpaidDeals. " +
    "Смайлики: 👤 агент, ✅ выплачено, ⏳ ждёт; суммы и курс — ровно из display.",
  parameters: {
    type: "object",
    properties: { month: { type: "string", description: "Месяц YYYY-MM, например 2026-10; без него — все невыплаченные" }, lang: LANG_PROP },
  },
  allowed: (actor) => dealToolsAllowed(actor) && actor.canViewFinance,
  async run(raw, { actor, question }) {
    if (!dealToolsAllowed(actor)) return { error: NOT_PRIVATE_ERROR };
    // Чужие доли — деньги всей команды: то же право, что «Финансы» и REST GET /deals/payouts.
    if (!actor.canViewFinance) return { error: "Выплаты команде видит только руководство" };
    const parsed = monthArgs.safeParse(raw);
    const lang = dealLang(parsed.success ? parsed.data.lang : undefined, question);
    const w = WORDS[lang];
    const rawMonth = parsed.success ? parsed.data.month : undefined;
    const month = rawMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(rawMonth) ? rawMonth : null;
    const [report, rate] = await Promise.all([
      agentPayoutsReport(month ? { month } : { open: true }),
      loadConfiguredUsdRate(),
    ]);
    const agents = report.agents.map((a) => ({ agent: a.agentName, months: a.months.map((m) => monthView(m, rate, lang)) }));
    const head = month
      ? (lang === "tg" ? `💰 Пардохт ба агентҳо барои ${month}:` : `💰 Выплаты агентам за ${month}:`)
      : (lang === "tg" ? "💰 Ба агентҳо ҳанӯз пардохт нашудааст (ҳамаи моҳҳо):" : "💰 Ещё не выплачено агентам (все месяцы):");
    const empty = month
      ? (lang === "tg" ? `Дар ${month} муомилаи басташуда нест.` : `За ${month} закрытых сделок нет.`)
      : (lang === "tg" ? "Ҳамаи ҳиссаҳо пардохт шудаанд." : "Невыплаченных долей нет.");
    const finance = (tjs: number) => (lang === "tg" ? ` · дар Молия: ${money(tjs, "TJS", lang)}` : ` · в Финансах: ${money(tjs, "TJS", lang)}`);
    const display = agents.length === 0
      ? empty
      : [
          head,
          ...agents.flatMap((a) => a.months.map((m) =>
            `👤 ${a.agent}${month ? "" : ` (${m.month})`}: ⏳ ${m.due.text}` +
            (m.paid.byCurrency.length ? ` · ✅ ${w.paid.toLowerCase()} ${m.paid.text}` : "") +
            (m.intakeShare ? ` · ${w.intake.toLowerCase()} ${m.intakeShare.text} (${m.intakeShare.note})` : "") +
            (m.salaryRowTJS !== null ? finance(m.salaryRowTJS) : ""),
          )),
          ...(report.truncated ? [lang === "tg" ? "Рӯйхат дароз аст — пурраашро дар CRM бинед." : "Список длинный — полностью смотрите в CRM."] : []),
        ].join("\n");
    return { scope: month ?? "все невыплаченные", agents, display };
  },
};

export const dealReadTools: AssistantReadToolPlugin[] = [getDealCardTool, getMyCommissionTool, getPayoutsDueTool];
