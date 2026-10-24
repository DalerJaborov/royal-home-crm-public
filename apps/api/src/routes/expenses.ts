import { Router } from "express";
import { createHash } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";
import { CLIENT_SOURCES, expenseCreateSchema, expenseUpdateSchema, expenseListQuerySchema, recurringWorkspaceFields, type ClientSource } from "@royal-home/shared";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { logAudit } from "../lib/audit.js";
import { buildExpenseForecast } from "../lib/financeAutomation.js";
import { buildFinancePulse } from "../lib/financePulse.js";
import { isDealSalaryExpense } from "../lib/companyProfit.js";
import { recentMonths, upsertAiExpenses } from "../lib/ads/adExpenseSync.js";
import { loadMetaAdsCredentials, isMetaAdsConfigured } from "../lib/ads/metaAdsApi.js";
import { syncMetaAdsQuietly } from "../lib/ads/syncMetaAds.js";
import { z } from "zod";
import { centsToTjs, fromCents, loadMoneyContext, roundMoney, splitCents, toCents } from "../lib/money.js";
import { getDealPayouts } from "../lib/dealDocumentsDb.js";
import { dushanbeWallClock, dushanbeDayRange, dushanbeEndOfDay, DUSHANBE_OFFSET_MS } from "../lib/dushanbeTime.js";
import { logSystemError } from "../lib/systemError.js";
import { csvSafeText } from "../lib/csv.js";
import { expenseWorkspaceRouter } from "./expenseWorkspace.js";
import { expenseDay, expenseDto, expenseDtos, expenseWhere, occurrenceDates, todayExpenseDay, validateExpenseCategory,orderedExpenseIds,ExpenseLifecycleError } from "../lib/expenseWorkspace.js";
import { expenseCentsToTjs } from "../lib/money.js";

export const expensesRouter = Router();

/**
 * Потолок выборки для /summary и /export (22.09.2026, класс «Пагинация» из
 * CLAUDE.md). Окно уже ограничено 60 месяцами, но само число сделок/расходов/
 * клиентов за пять лет ничем не ограничено — без потолка это неограниченная
 * выборка на один HTTP-запрос. 20 000 — с большим запасом над реальным темпом
 * этого агентства (сотни строк в месяц), предел на практике не задевается; если
 * всё же задет — не отдаём молча усечённые суммы, а говорим об этом в ответе.
 */
const FINANCE_ROW_LIMIT = 20_000;

// Раздел целиком закрыт правом «Финансы»; изменение расходов — правом finance.manage.
expensesRouter.use(requireAuth, requirePermission("finance.view"));
// Читать финансы и вести их — разные права: бухгалтеру можно открыть цифры,
// не давая заводить, править и удалять расходы.
const requireFinanceWrite = requirePermission("finance.manage");
expensesRouter.use(expenseWorkspaceRouter);

/** "2026-07" → Date первого дня месяца (UTC, чтобы не плавать по таймзонам). */
function monthToDate(month: string): Date {
  return new Date(`${month}-01T00:00:00.000Z`);
}

/**
 * Месяц по Душанбе, а не по UTC. Ровно та же ошибка уже была в отчётах: сделка,
 * закрытая 1-го числа до 05:00, попадала в прошлый месяц — и в сводке, и в
 * стоимости лида, и в выгрузке для бухгалтерии.
 */
function monthKey(d: Date): string {
  const wall = dushanbeWallClock(d);
  return `${wall.getUTCFullYear()}-${String(wall.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Начало месяца по Душанбе как реальный момент времени (UTC-инстант). */
function dushanbeMonthStart(yearsMonthsBack: number): Date {
  const wall = dushanbeWallClock();
  return new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() - yearsMonthsBack, 1) - DUSHANBE_OFFSET_MS);
}


expensesRouter.get("/", async (req, res) => {
  const query=expenseListQuerySchema.safeParse(req.query);
  if(!query.success)return res.status(400).json({error:"Некорректные фильтры",details:query.error.flatten()});
  const where=expenseWhere(query.data);
  if(query.data.sortBy){
    try{
      const context=query.data.sortBy==="amount"?await loadMoneyContext():undefined;
      const ids=await orderedExpenseIds(where,query.data.sortBy,query.data.sortDirection,context);
      const offset=query.data.page?(query.data.page-1)*query.data.pageSize:0;const pageIds=ids.slice(offset,offset+(query.data.page?query.data.pageSize:200));
      const rows=await prisma.expense.findMany({where:{id:{in:pageIds},deletedAt:null},include:{agent:{select:{id:true,fullName:true}},receipts:true}});
      const byId=new Map(rows.map(row=>[row.id,row]));const ordered=pageIds.flatMap(id=>{const row=byId.get(id);return row?[row]:[];});
      const items=await expenseDtos(ordered,context);return res.json(query.data.page?{items,total:ids.length,page:query.data.page,pageSize:query.data.pageSize}:items);
    }catch(error){if(error instanceof ExpenseLifecycleError)return res.status(error.status).json({error:error.message});throw error;}
  }
  const expenses = await prisma.expense.findMany({
    where,
    orderBy: [{ month: "desc" }, { createdAt: "desc" }],
    include: { agent: { select: { id: true, fullName: true } }, receipts:true },
    take: query.data.page?query.data.pageSize:200,
    ...(query.data.page?{skip:(query.data.page-1)*query.data.pageSize}:{}),
  });
  const items=await expenseDtos(expenses);
  res.json(query.data.page?{items,total:await prisma.expense.count({where}),page:query.data.page,pageSize:query.data.pageSize}:items);
});

/** Архив удалённых расходов за диапазон дат — ничего не удаляется физически, только
 * скрывается из активных списков. ADMIN/DIRECTOR может посмотреть и восстановить. */
expensesRouter.get("/archive", async (req, res) => {
  // Границы суток — по Душанбе (аудит №4). Голый new Date("2026-08-26") даёт
  // полночь UTC: выбор одного дня (с 26.08 по 26.08) сравнивался с единственным
  // мгновением и всегда возвращал пусто, а в диапазоне первый день терял утро,
  // а последний обрезался на 05:00 местного.
  const fromRaw = typeof req.query.from === "string" ? new Date(req.query.from) : undefined;
  const toRaw = typeof req.query.to === "string" ? new Date(req.query.to) : undefined;
  const from = fromRaw && !Number.isNaN(fromRaw.getTime()) ? dushanbeDayRange(fromRaw).start : undefined;
  const to = toRaw && !Number.isNaN(toRaw.getTime()) ? dushanbeEndOfDay(toRaw) : undefined;

  const expenses = await prisma.expense.findMany({
    where: {
      deletedAt: {
        not: null,
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      },
    },
    orderBy: { deletedAt: "desc" },
    include: { agent: { select: { id: true, fullName: true } } },
    take: 200,
  });
  res.json(expenses);
});

expensesRouter.patch("/:id/restore", requireFinanceWrite, async (req, res) => {
  try {
    const expense = await prisma.expense.update({ where: { id: req.params.id }, data: { deletedAt: null } });
    logAudit(req, "RESTORE", "Expense", expense.id, { category: expense.category, amount: expense.amount.toString() });
    res.json(expense);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return res.status(404).json({ error: "Расход не найден" });
    }
    throw err;
  }
});

expensesRouter.post("/", requireFinanceWrite, async (req, res) => {
  const parsed = expenseCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const { month, ...rest } = parsed.data;
  if(rest.amount>99_999_999.99)return res.status(400).json({error:"Сумма слишком большая"});
  if(!await validateExpenseCategory(rest.categoryId,rest.category))return res.status(400).json({error:"Выберите категорию соответствующего раздела"});
  const key=req.get("Idempotency-Key");
  if(key&&!/^[A-Za-z0-9:_-]{8,120}$/.test(key))return res.status(400).json({error:"Неверный ключ запроса"});
  const requestKey=key?`${req.agent!.id}:${key}`:undefined;
  const money=await loadMoneyContext();
  const fingerprint=createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");
  const rate=rest.currency==="USD"?(rest.exchangeRate??(rest.status==="PLANNED"?null:money.usdToTjs)):1;
  const data={...rest,paymentDate:rest.paymentDate?expenseDay(rest.paymentDate):null,month:monthToDate((rest.status??"PAID")==="PAID"&&rest.paymentDate?rest.paymentDate.slice(0,7):month),createdById:req.agent!.id,exchangeRate:rate,rateCapturedAt:rate!=null?new Date():null,requestKey,...(requestKey?{autoFingerprint:fingerprint}:{})};
  if((rest.status??"PAID")==="PAID"&&rest.paymentDate&&rest.paymentDate>todayExpenseDay())return res.status(400).json({error:"Будущий платёж запишите как план"});
  const expense=requestKey?await prisma.expense.upsert({where:{requestKey},update:{},create:data}):await prisma.expense.create({data});
  if(requestKey&&expense.autoFingerprint!==fingerprint)return res.status(409).json({error:"Этот ключ уже использован для другого расхода",code:"IDEMPOTENCY_CONFLICT"});
  // Единственный из четырёх пишущих роутов, который не писал в аудит: заведение
  // денег оставалось без следа, а правка и удаление — со следом.
  logAudit(req, "EXPENSE_CREATE", "Expense", expense.id, {
    amount: Number(expense.amount),
    category: expense.category,
    month,
  });
  res.status(201).json((await expenseDtos([expense]))[0]);
});

expensesRouter.patch("/:id", requireFinanceWrite, async (req, res) => {
  const parsed = expenseUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const { month, version, ...rest } = parsed.data;
  // expenseUpdateSchema — partial без superRefine создания, поэтому обязательность
  // проверяется здесь, по ИТОГОВОМУ состоянию строки (26.08.2026): раньше PATCH
  // { category: "ADVERTISING" } по расходу без канала проходил молча, и стоимость
  // лида по каналам теряла эту сумму; обратная смена оставляла устаревший source.
  const current = await prisma.expense.findUnique({ where: { id: req.params.id } });
  if (!current || current.deletedAt) return res.status(404).json({ error: "Расход не найден" });
  // Cached legacy clients may still issue a deliberate one-field PATCH. A full
  // form snapshot without its opening version must never overwrite newer edits.
  const changedFields = Object.keys(parsed.data).filter(key => key !== "version");
  if (version === undefined && changedFields.length > 1) {
    return res.status(409).json({ code: "EXPENSE_VERSION_REQUIRED", error: "Обновите страницу и снова откройте расход: старая форма не передаёт версию записи" });
  }
  if (version !== undefined && version !== current.version) {
    return res.status(409).json({ code: "EXPENSE_VERSION_CONFLICT", error: "Расход изменён другим сотрудником. Обновите запись перед сохранением" });
  }
  if(rest.amount!==undefined&&rest.amount>99_999_999.99)return res.status(400).json({error:"Сумма слишком большая"});
  if(!await validateExpenseCategory(rest.categoryId===undefined?current.categoryId:rest.categoryId,rest.category??current.category,current))return res.status(400).json({error:"Категория не соответствует разделу"});
  const money=await loadMoneyContext();
  const finalPaymentDate = rest.paymentDate === undefined ? current.paymentDate?.toISOString().slice(0, 10) : rest.paymentDate;
  const finalStatus = rest.status ?? current.status;
  const finalCurrency = rest.currency ?? current.currency;
  if(finalStatus==="PAID"&&finalPaymentDate&&finalPaymentDate>todayExpenseDay())return res.status(400).json({error:"Будущий платёж запишите как план"});
  // A plan without an explicit rate uses the rate at payment, including payment
  // through the editor. Currency changes must discard the previous currency's rate.
  const currencyChanged = finalCurrency !== current.currency;
  const rateEdited = rest.exchangeRate !== undefined || currencyChanged;
  const becomesPaid = finalStatus === "PAID" && current.status !== "PAID";
  const suppliedRate = finalCurrency === "USD"
    ? rest.exchangeRate !== undefined ? rest.exchangeRate : currencyChanged ? null : current.exchangeRate
    : 1;
  const finalRate = suppliedRate ?? (finalStatus === "PAID" ? money.usdToTjs : null);
  const finalCategory = rest.category ?? current.category;
  const finalSource = rest.source === undefined ? current.source : rest.source;
  const finalAgentId = rest.agentId === undefined ? current.agentId : rest.agentId;
  const finalNote = rest.note === undefined ? current.note : rest.note;
  if (finalCategory === "ADVERTISING" && !finalSource) {
    return res.status(400).json({ error: "Укажите канал рекламы" });
  }
  if (finalCategory === "SALARY" && !finalAgentId) {
    return res.status(400).json({ error: "Укажите сотрудника" });
  }
  if ((finalCategory === "OFFICE" || finalCategory === "OTHER") && !finalNote?.trim()) {
    return res.status(400).json({ error: "Укажите комментарий — куда пошли деньги" });
  }
  // Поля чужой категории обнуляются сами: канал имеет смысл только у рекламы,
  // сотрудник — только у зарплаты; оставить их значит врать отчётам.
  const clearStale = {
    ...(finalCategory !== "ADVERTISING" ? { source: null } : {}),
    ...(finalCategory !== "SALARY" ? { agentId: null } : {}),
  };
  try {
    const expense = await prisma.expense.update({
      where: { id: req.params.id,version:version ?? current.version, deletedAt: null },
      data: {
        ...rest,
        ...clearStale,
        version:{increment:1},paymentUndo:Prisma.DbNull,
        ...(rest.paymentDate!==undefined?{paymentDate:rest.paymentDate?expenseDay(rest.paymentDate):null}:{}),
        ...(rateEdited || becomesPaid ? { exchangeRate: finalRate, rateCapturedAt: finalRate === null ? null : !rateEdited && current.rateCapturedAt ? current.rateCapturedAt : new Date() } : {}),
        ...(finalStatus==="PAID"&&finalPaymentDate?{month:monthToDate(finalPaymentDate.slice(0,7))}:month ? { month: monthToDate(month) } : {}),
        // Правку СУММЫ у авто-строки помечаем: ночная автоматика (зарплаты,
        // реклама, ИИ) такую строку больше не пересчитывает — раньше она молча
        // откатывала исправление директора ближайшей ночью (аудит №4).
        ...(rest.amount !== undefined && current.autoKey ? { manualEditedAt: new Date() } : {}),
      },
    });
    logAudit(req, "UPDATE", "Expense", expense.id, { changed: Object.keys(parsed.data) });
    res.json((await expenseDtos([expense]))[0]);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return res.status(409).json({ code: "EXPENSE_VERSION_CONFLICT", error: "Расход изменён другим сотрудником. Обновите запись перед сохранением" });
    }
    throw err;
  }
});

expensesRouter.delete("/:id", requireFinanceWrite, async (req, res) => {
  const parsed = z.object({ version: z.coerce.number().int().nonnegative().optional() }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Неверная версия расхода" });
  try {
    // Мягкое удаление — запись остаётся в архиве, доступна для восстановления.
    const deleted = await prisma.expense.update({ where: { id: req.params.id, ...(parsed.data.version !== undefined ? { version: parsed.data.version, deletedAt: null } : {}) }, data: { deletedAt: new Date(), version: { increment: 1 } } });
    logAudit(req, "DELETE", "Expense", deleted.id, {
      category: deleted.category,
      amount: deleted.amount.toString(),
      month: deleted.month,
    });
    res.status(204).end();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      if (parsed.data.version !== undefined) return res.status(409).json({ code: "EXPENSE_VERSION_CONFLICT", error: "Расход уже изменён. Обновите запись перед удалением" });
      return res.status(404).json({ error: "Расход не найден" });
    }
    throw err;
  }
});

/**
 * Финансовая сводка за последние N месяцев (по умолчанию 6):
 * доход (комиссии закрытых сделок) − расходы = прибыль; реклама детализируется
 * по источникам вместе с числом лидов → стоимость лида по каждому каналу.
 */
expensesRouter.get("/summary", async (req, res) => {
  const monthsBack = Math.min(Math.max(Number(req.query.months) || 6, 1), 60);
  const through=z.string().regex(/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/).optional().safeParse(req.query.through);
  if(!through.success)return res.status(400).json({error:"Некорректный месяц"});
  const now = through.data?expenseDay(`${through.data}-01`):dushanbeWallClock();
  const from = through.data?new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-monthsBack+1,1)-DUSHANBE_OFFSET_MS):dushanbeMonthStart(monthsBack - 1);
  const until=through.data?new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1)-DUSHANBE_OFFSET_MS):undefined;

  const [expenses, completedDeals, clients, settings, money] = await Promise.all([
    prisma.expense.findMany({ where: { month: { gte: from,...(until?{lt:until}:{}) }, deletedAt: null,status:"PAID" }, take: FINANCE_ROW_LIMIT }),
    prisma.deal.findMany({
      where: { stage: "COMPLETED", closedAt: { gte: from,...(until?{lt:until}:{}) } },
      orderBy: { closedAt: "desc" },
      take: FINANCE_ROW_LIMIT,
      select: {
        id: true,
        closedAt: true,
        commissionAmount: true,
        currency: true,
        commissionIntakeAmount: true,
        commissionRealtorAmount: true,
        commissionCompanyAmount: true,
        agent: { select: { id: true, fullName: true } },
        // Источник клиента сделки — чтобы посчитать «сомони за сделку» по каналу
        // рядом со стоимостью лида (тема 2026, C4.6): без source считать не с чем.
        // fullName — ночная проверка 24.09.2026, №206: «Выплаты агентам» теперь
        // называет сделку рядом с датой выплаты, не только сумму по агенту.
        client: { select: { source: true, fullName: true } },
        property: { select: { title: true } },
      },
    }),
    // deletedAt — удалённые клиенты не должны раздувать знаменатель стоимости лида.
    prisma.client.findMany({
      where: { createdAt: { gte: from,...(until?{lt:until}:{}) }, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: FINANCE_ROW_LIMIT,
      select: { createdAt: true, source: true },
    }),
    prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } }),
    loadMoneyContext(),
  ]);
  // Потолок задет — сводка за старые месяцы окна неполна. Не молчим: пишем в
  // журнал ошибок (как budget-сортировка клиентов) и честно сообщаем в ответе.
  const truncated =
    expenses.length >= FINANCE_ROW_LIMIT || completedDeals.length >= FINANCE_ROW_LIMIT || clients.length >= FINANCE_ROW_LIMIT;
  if (truncated) {
    void logSystemError(
      "api",
      `Финансовая сводка за ${monthsBack} мес.: выборка упёрлась в потолок ${FINANCE_ROW_LIMIT} строк — цифры по старым месяцам окна могут быть неполными`
    );
  }

  // Даты выплаты риелторам — одним запросом на все закрытые сделки окна разом
  // (ночная проверка 24.09.2026, №206: «Выплаты агентам» раньше не показывали,
  // выплачена ли комиссия и когда). Только выплаченные — карта короче.
  const payoutByDealId = await getDealPayouts(completedDeals.map((d) => d.id));

  // Для старых сделок без снапшота долей — восстановление по текущим настройкам
  // (той же пропорцией, что и при закрытии): полная картина без дыр в истории.
  // 0,5% «за приём объекта» отменены 11.09.2026: в отчётах эта доля больше не
  // выделяется отдельной строкой ни у новых, ни у старых сделок — она всегда
  // складывается с долей компании (Settings.commissionIntakePercent остаётся в
  // схеме БД как история, но в отчётах не участвует отдельно).
  const pRealtor = Number(settings.commissionRealtorPercent);
  const pCompany = Number(settings.commissionCompanyPercent) + Number(settings.commissionIntakePercent);
  // Все доли возвращаются УЖЕ в сомони: сделка по объекту в долларах хранит комиссию
  // в долларах, и без конвертации она складывалась с сомони один к одному.

  /**
   * Доли сделки В ЦЕЛЫХ СОТЫХ СОМОНИ.
   *
   * Всё, что ниже, складывается сотнями строк и сходится в итог месяца, поэтому
   * плавающей точке здесь делать нечего (см. lib/money.ts). У сделок со
   * снапшотом берём записанные доли риелтора/компании (историческая доля интейка,
   * если она была, прибавляется к доле компании), у legacy-сделок без снапшота —
   * делим базу тем же методом наибольшего остатка, что и при закрытии
   * (routes/deals.ts): независимые округления давали сумму долей, не равную комиссии.
   */
  const splitOf = (d: (typeof completedDeals)[number]) => {
    const cents = (value: unknown) => centsToTjs(toCents(value), d.currency, money);
    if (d.commissionCompanyAmount !== null) {
      return {
        realtor: cents(d.commissionRealtorAmount),
        company: cents(d.commissionCompanyAmount) + cents(d.commissionIntakeAmount),
      };
    }
    const baseCents = cents(d.commissionAmount);
    const [realtor, company] = splitCents(baseCents, [pRealtor, pCompany]);
    return { realtor, company };
  };

  const months: string[] = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    months.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  }

  const summary = months.map((m) => {
    const monthExpenses = expenses.filter((e) => monthKey(e.month) === m);
    const byCategory: Record<string, number> = {};
    /** Авто-строки «Зарплата из сделок» месяца, в сотых: это доли риелторов,
     *  уже вычтенные из дохода компании (C2, lib/companyProfit.ts). */
    let dealSalaryCents = 0;
    for (const e of monthExpenses) {
      if (isDealSalaryExpense(e)) dealSalaryCents += expenseCentsToTjs(e, money);
      // ПРИВОДИМ К СОМОНИ. Раньше здесь стояло «расходы ведутся только в сомони,
      // конвертировать нечего» — и это было правдой, пока строки заводились
      // руками формой, где валюты нет. С 20.08.2026 CRM ведёт строки сама
      // (реклама из кабинета Meta и обращения к ИИ — в долларах), и без
      // пересчёта доллары складывались с сомони один к одному: сводка
      // показывала 25 147 с. там, где расходов было 26 037 с.
      byCategory[e.category] = (byCategory[e.category] ?? 0) + expenseCentsToTjs(e, money);
    }
    const monthDeals = completedDeals.filter((d) => d.closedAt && monthKey(d.closedAt) === m);
    // Полная честность: валовая комиссия → выплаты агентам → доход компании. Всё в сомони.
    const grossCommission = monthDeals.reduce(
      (s, d) => s + centsToTjs(toCents(d.commissionAmount), d.currency, money),
      0
    );
    let realtorPayouts = 0;
    let companyRevenue = 0;
    const payoutByAgent = new Map<
      string,
      { name: string; realtor: number; deals: { dealId: string; clientName: string | null; propertyTitle: string; realtor: number; payoutAt: string | null }[] }
    >();
    for (const d of monthDeals) {
      const { realtor, company } = splitOf(d);
      realtorPayouts += realtor;
      companyRevenue += company;
      if (realtor > 0) {
        const p = payoutByAgent.get(d.agent.id) ?? { name: d.agent.fullName, realtor: 0, deals: [] };
        p.realtor += realtor;
        // Дата выплаты рядом со сделкой (ночная проверка 24.09.2026, №206) —
        // Finance.tsx до этого не печатал её вовсе, хотя окно документов
        // (DealDocumentsModal) её уже показывает по одной сделке.
        p.deals.push({
          dealId: d.id,
          clientName: d.client?.fullName ?? null,
          propertyTitle: d.property.title,
          realtor: fromCents(realtor),
          payoutAt: payoutByDealId.get(d.id)?.toISOString() ?? null,
        });
        payoutByAgent.set(d.agent.id, p);
      }
    }
    const revenue = grossCommission;
    const totalExpenses = Object.values(byCategory).reduce((s, v) => s + v, 0);
    /** Расходы компании для прибыли — все строки, кроме зарплат из сделок. */
    const operatingExpenses = totalExpenses - dealSalaryCents;

    // Стоимость лида: рекламные расходы канала / число лидов канала за месяц.
    const monthClients = clients.filter((c) => monthKey(c.createdAt) === m);
    const adBySource = new Map<ClientSource, number>();
    for (const e of monthExpenses) {
      if (e.category === "ADVERTISING" && e.source) {
        adBySource.set(
          e.source as ClientSource,
          (adBySource.get(e.source as ClientSource) ?? 0) + expenseCentsToTjs(e, money)
        );
      }
    }
    const costPerLead = [...adBySource.entries()].map(([source, spentCents]) => {
      const leads = monthClients.filter((c) => c.source === source).length;
      // «Сомони за сделку»: тот же расход канала, но на число ЗАКРЫТЫХ сделок его
      // клиентов в месяце, а не на все лиды — воронка «лид → сделка» короче
      // воронки «лид → лид», и по каналу это часто 0 при десятках лидов.
      // Строка есть только для источников с расходом (adBySource), поэтому
      // «без расхода» здесь в принципе не возникает — раз источника нет в этой
      // карте, для него нет строки вовсе (решение владельца — не показывать 0/—
      // для каналов без рекламного бюджета). Внутри строки: сделок 0 → прочерк,
      // не деление на ноль.
      const deals = monthDeals.filter((d) => d.client?.source === source).length;
      return {
        source,
        spent: fromCents(spentCents),
        leads,
        // Стоимость лида — тоже до копейки: при 3 лидах и 100 с. это 33,33, а не 33.
        costPerLead: leads > 0 ? fromCents(Math.round(spentCents / leads)) : null,
        deals,
        costPerDeal: deals > 0 ? fromCents(Math.round(spentCents / deals)) : null,
      };
    });

    /**
     * В JSON суммы уходят обычными числами с двумя знаками — но собраны они из
     * ТЕХ ЖЕ целых сотых, что складывались выше. Поэтому «итого расходов» равно
     * сумме категорий, а «прибыль» — разности показанных чисел, без вечной
     * неувязки в единицу, которую бухгалтер ищет полдня.
     */
    return {
      month: m,
      /** Валовая комиссия (всё, что заплатили клиенты по закрытым сделкам). */
      revenue: fromCents(revenue),
      /** Из неё: выплаты риелторам и доход компании (0,5% «за приём объекта»
       *  отменены 11.09.2026 — эта доля больше не выделяется отдельно). */
      realtorPayouts: fromCents(realtorPayouts),
      companyRevenue: fromCents(companyRevenue),
      /** Кому сколько причитается за месяц — прозрачность выплат. */
      payouts: [...payoutByAgent.entries()].map(([agentId, p]) => ({
        agentId,
        name: p.name,
        realtor: fromCents(p.realtor),
        total: fromCents(p.realtor),
        deals: p.deals,
      })),
      expenses: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, fromCents(v)])),
      totalExpenses: fromCents(totalExpenses),
      /** Из них авто-строки «Зарплата из сделок» — доли риелторов, уже не входящие в доход компании. */
      dealSalaryExpenses: fromCents(dealSalaryCents),
      /** Расходы, которые вычитаются из дохода компании: все, кроме зарплат из сделок. */
      operatingExpenses: fromCents(operatingExpenses),
      /** Прибыль компании = ЕЁ доля комиссии − расходы без зарплат из сделок
       *  (доля риелтора вычитается один раз — C2, lib/companyProfit.ts). */
      profit: fromCents(companyRevenue - operatingExpenses),
      leads: monthClients.length,
      costPerLead,
    };
  });

  // currency/usdToTjsRate — чтобы фронт подписывал суммы честно и мог показать,
  // по какому курсу сведены долларовые сделки, а не жёстко печатал «с.».
  res.json({ months: summary, currency: "TJS", usdToTjsRate: money.usdToTjs, truncated });
});

/**
 * Выгрузка бухгалтерии в CSV (Excel-совместимый, с BOM для кириллицы):
 * лист «Сделки» — каждая закрытая сделка с разбивкой комиссии, затем «Расходы».
 * Полная прозрачность: те же данные, что на экране, ничего скрытого.
 */
expensesRouter.get("/export", async (req, res) => {
  const monthsBack = Math.min(Math.max(Number(req.query.months) || 6, 1), 60);
  const from = dushanbeMonthStart(monthsBack - 1);

  const [deals, expenses, settings, money] = await Promise.all([
    prisma.deal.findMany({
      where: { stage: "COMPLETED", closedAt: { gte: from } },
      orderBy: { closedAt: "asc" },
      take: FINANCE_ROW_LIMIT,
      select: {
        closedAt: true,
        soldPrice: true,
        commissionAmount: true,
        currency: true,
        commissionIntakeAmount: true,
        commissionRealtorAmount: true,
        commissionCompanyAmount: true,
        client: { select: { fullName: true } },
        agent: { select: { fullName: true } },
        property: {
          select: { title: true, soldPrice: true, price: true, currency: true },
        },
      },
    }),
    prisma.expense.findMany({
      where: { month: { gte: from }, deletedAt: null,status:"PAID" },
      orderBy: { month: "asc" },
      take: FINANCE_ROW_LIMIT,
    }),
    prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } }),
    loadMoneyContext(),
  ]);
  const truncated = deals.length >= FINANCE_ROW_LIMIT || expenses.length >= FINANCE_ROW_LIMIT;
  if (truncated) {
    void logSystemError(
      "api",
      `Выгрузка бухгалтерии за ${monthsBack} мес.: выборка упёрлась в потолок ${FINANCE_ROW_LIMIT} строк — файл усечён`
    );
  }

  // 0,5% «за приём объекта» отменены 11.09.2026: доля интейка (текущая и
  // историческая) в выгрузке больше не выделяется отдельно, всегда идёт в доход компании.
  const pRealtor = Number(settings.commissionRealtorPercent);
  const pCompany = Number(settings.commissionCompanyPercent) + Number(settings.commissionIntakePercent);

  // csvSafeText — защита от CSV-инъекции (№216): имя клиента/объекта/примечание
  // не должны начинаться формулой (= + - @).
  const q = (v: unknown) => `"${csvSafeText(v).replace(/"/g, '""')}"`;
  /** Деньги в выгрузке — всегда с двумя знаками: «1200» и «1200.5» в одной
   *  колонке заставляют бухгалтера гадать, копейки это или сомони. */
  const m = (cents: number) => fromCents(cents).toFixed(2);
  const lines: string[] = [];
  lines.push(`СДЕЛКИ (закрытые). Все суммы в сомони, доллары пересчитаны по курсу ${money.usdToTjs}`);
  lines.push(
    [
      "Дата",
      "Объект",
      "Клиент",
      "Исходная валюта",
      "Цена продажи, с.",
      "Комиссия всего, с.",
      "Риелтор",
      "Доля за продажу, с.",
      "Доход компании, с.",
    ]
      .map(q)
      .join(";")
  );
  for (const d of deals) {
    const cents = (value: unknown) => centsToTjs(toCents(value), d.currency, money);
    const base = cents(d.commissionAmount);
    /**
     * Доли: снапшот сделки (доля интейка, если была историческая, прибавляется
     * к доле компании), а у legacy-сделок без снапшота — то же деление методом
     * наибольшего остатка, что при закрытии и в сводке.
     */
    let realtor: number;
    let company: number;
    if (d.commissionCompanyAmount !== null) {
      realtor = cents(d.commissionRealtorAmount);
      company = cents(d.commissionCompanyAmount) + cents(d.commissionIntakeAmount);
    } else {
      [realtor, company] = splitCents(base, [pRealtor, pCompany]);
    }
    lines.push(
      [
      // Дата сделки — по Душанбе, как и месяц в сводке: иначе сделка, закрытая
      // 1-го числа ночью, попадала в августовскую сумму июльской строкой.
        d.closedAt ? dushanbeWallClock(d.closedAt).toISOString().slice(0, 10) : "",
        d.property.title,
        d.client.fullName,
        d.currency,
        // Цена ОБЪЕКТА конвертируется по валюте ОБЪЕКТА, а не сделки (аудит №4,
        // 27.08): валюту карточки можно сменить в любой момент после создания
        // сделки, и тогда 1 000 000 сомони пересчитывались как доллары — цена в
        // выгрузке становилась вдесятеро больше, и сверка бухгалтера не сходилась.
        //
        // Цена СДЕЛКИ первой (C13, 02.10.2026): директор правит цену закрытой
        // сделки — пишется только Deal.soldPrice (в валюте сделки), и выгрузка с
        // объекта показывала старую. Объект — только запасной вариант для старых
        // сделок без своей цены.
        m(
          d.soldPrice !== null
            ? centsToTjs(toCents(d.soldPrice), d.currency, money)
            : centsToTjs(toCents(d.property.soldPrice ?? d.property.price), d.property.currency, money)
        ),
        m(base),
        d.agent.fullName,
        m(realtor),
        m(company),
      ]
        .map(q)
        .join(";")
    );
  }
  lines.push("");
  lines.push("РАСХОДЫ");
  lines.push(["Месяц", "Категория", "Источник", "Сумма, с.", "Комментарий"].map(q).join(";"));
  for (const e of expenses) {
    lines.push(
      // toTjs обязателен (26.08.2026): шапка файла обещает «все суммы в сомони»,
      // а долларовые строки (реклама Meta, расходы на ИИ — CRM заводит их сама
      // с 20.08) печатались как есть — $890 попадал в колонку «Сумма, с.» числом
      // 890, итог CSV не сходился со сводкой на экране.
      [monthKey(e.month), e.category, e.source ?? "", m(expenseCentsToTjs(e, money)), e.note ?? ""]
        .map(q)
        .join(";")
    );
  }

  if (truncated) {
    lines.push("");
    lines.push(q(`ВНИМАНИЕ: выборка упёрлась в потолок ${FINANCE_ROW_LIMIT} строк — файл усечён, сузьте период`));
  }

  logAudit(req, "FINANCE_EXPORT", "Expense", null, { monthsBack, truncated });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  // now здесь уже «настенные часы» Душанбе, а monthKey сдвигает второй раз —
  // отдаём ему настоящий момент, иначе июльский файл назывался бы августовским.
  res.setHeader("Content-Disposition", `attachment; filename="royal-home-finance-${monthKey(new Date())}.csv"`);
  // BOM — иначе Excel открывает кириллицу кракозябрами.
  res.send("﻿" + lines.join("\r\n"));
});


/**
 * ПРОГНОЗ РАСХОДОВ: потрачено с начала месяца, куда идём по темпу и средний
 * месяц за три прошлых. Считает lib/financeAutomation.ts, тот же расчёт шлёт
 * предупреждение директору при перерасходе.
 */
expensesRouter.get("/forecast", async (_req, res) => {
  res.json(await buildExpenseForecast());
});

/**
 * Поля шаблона БЕЗ значений по умолчанию: на них строится и создание, и правка.
 * `.partial()` схемы со значениями по умолчанию в Zod 4 всё равно подставляет их
 * (category=OFFICE, currency=TJS), и любая правка шаблона («выключить», «сумма»)
 * молча затирала категорию и валюту (найдено при CRM-07, 04.10.2026).
 */
const recurringFields = {
  ...recurringWorkspaceFields,
  title: z.string().min(1).max(200),
  // До копейки, как любые деньги на входе (C14, 02.10.2026; правило — в
  // packages/shared/src/schemas.ts у money()): доли копейки из шаблона уходили
  // в авто-строку расхода каждый месяц.
  amount: z.coerce.number().transform(roundMoney).pipe(z.number().positive().max(99_999_999.99)),
  currency: z.enum(["TJS", "USD"]),
  category: z.enum(["ADVERTISING", "SALARY", "OFFICE", "OTHER"]),
  /** 1–31; occurrenceDates clamps only the occurrence in a shorter month. */
  dayOfMonth: z.coerce.number().int().min(1).max(31),
  note: z.string().max(500).optional(),
  // nullish, не optional: канал/сотрудника при смене категории надо уметь ЯВНО
  // стереть (undefined выпадает из JSON и очисткой не является).
  source: z.enum(CLIENT_SOURCES).nullish(),
  agentId: z.guid().nullish(),
};

/**
 * Что обязательно у шаблона, как у expenseCreateSchema (CRM-07, решение владельца
 * 04.10.2026): реклама — канал, зарплата — сотрудник; для остальных категорий они не
 * нужны. Нужны, потому что ночная задача копирует их в расход, а расход без канала
 * выпадает из стоимости лида, без сотрудника не правится.
 */
function recurringAttributionIssue(
  category: string,
  source: string | null | undefined,
  agentId: string | null | undefined
): { path: "source" | "agentId"; message: string } | null {
  if (category === "ADVERTISING" && !source) return { path: "source", message: "Укажите канал рекламы" };
  if (category === "SALARY" && !agentId) return { path: "agentId", message: "Укажите сотрудника" };
  return null;
}

const recurringSchema = z
  .object({
    ...recurringFields,
    currency: recurringFields.currency.default("TJS"),
    category: recurringFields.category.default("OFFICE"),
  })
  .superRefine((data, ctx) => {
    const issue = recurringAttributionIssue(data.category, data.source, data.agentId);
    if (issue) ctx.addIssue({ code: "custom", path: [issue.path], message: issue.message });
  });

const recurringPatchSchema = z.object(recurringFields).partial().extend({ active: z.boolean().optional() });

/** Повторяющиеся платежи: список шаблонов — активные и выключенные. */
expensesRouter.get("/recurring", async (_req, res) => {
  const rows = await prisma.recurringExpense.findMany({where:{deletedAt:null}, orderBy: [{ active: "desc" }, { dayOfMonth: "asc" }], take: 100 });
  const today=todayExpenseDay();const to=new Date(expenseDay(today));to.setUTCFullYear(to.getUTCFullYear()+2);
  const payments=await prisma.expense.findMany({where:{deletedAt:null,status:"PAID",OR:[{recurringId:{in:rows.map(r=>r.id)}},{autoKey:{startsWith:"rec:"}}]},select:{autoKey:true,recurringId:true,occurrenceDate:true},take:20001});
  if(payments.length>20000)return res.status(413).json({error:"Слишком много платежей для списка подписок"});
  res.json(rows.map(row=>({...row,nextDate:row.active?occurrenceDates(row,today,to.toISOString().slice(0,10)).find(day=>!row.skippedDates.includes(day)&&!payments.some(p=>p.recurringId===row.id&&p.occurrenceDate===day||p.autoKey===`rec:${row.id}:${day.slice(0,7)}`||p.autoKey===`rec:${row.id}:${day}`))??null:null})));
});

expensesRouter.post("/recurring", requireFinanceWrite, async (req, res) => {
  const parsed = recurringSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  // Поля чужой категории не храним: канал имеет смысл только у рекламы, сотрудник —
  // только у зарплаты (то же правило, что у PATCH расхода).
  if(parsed.data.startsOn && parsed.data.endsOn && parsed.data.endsOn<parsed.data.startsOn)return res.status(400).json({error:"Конец подписки раньше начала"});
  if(!await validateExpenseCategory(parsed.data.categoryId,parsed.data.category))return res.status(400).json({error:"Неверная категория подписки"});
  const row = await prisma.recurringExpense.create({
    data: {
      ...parsed.data,
      ...(!parsed.data.startsOn&&(parsed.data.period!==undefined||parsed.data.autoPay!==undefined||parsed.data.dayOfMonth>28)?{startsOn:todayExpenseDay()}:{}),
      source: parsed.data.category === "ADVERTISING" ? parsed.data.source : null,
      agentId: parsed.data.category === "SALARY" ? parsed.data.agentId : null,
    },
  });
  logAudit(req, "CREATE", "RecurringExpense", row.id, { title: row.title, amount: Number(row.amount) });
  res.status(201).json(row);
});

expensesRouter.patch("/recurring/:id", requireFinanceWrite, async (req, res) => {
  const parsed = recurringPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const patch = parsed.data;
  const existing=await prisma.recurringExpense.findUnique({where:{id:req.params.id}});
  if(!existing||existing.deletedAt)return res.status(404).json({error:"Шаблон не найден"});
  const start=patch.startsOn===undefined?existing.startsOn:patch.startsOn;const end=patch.endsOn===undefined?existing.endsOn:patch.endsOn;
  if(start&&end&&end<start)return res.status(400).json({error:"Конец подписки раньше начала"});
  if(!await validateExpenseCategory(patch.categoryId===undefined?existing.categoryId:patch.categoryId,patch.category??existing.category,existing))return res.status(400).json({error:"Неверная категория подписки"});
  // Обязательность канала/сотрудника проверяется по ИТОГОВОМУ состоянию, но только
  // когда правка трогает категорию или сами эти поля: СУЩЕСТВУЮЩИЙ шаблон без канала
  // (заведён до CRM-07) можно выключить или поправить сумму, не выбирая канал.
  const touchesAttribution = patch.category !== undefined || patch.source !== undefined || patch.agentId !== undefined;
  let attributionData: { source?: ClientSource | null; agentId?: string | null } = {};
  if (touchesAttribution) {
    const current = await prisma.recurringExpense.findUnique({
      where: { id: req.params.id },
      select: { category: true, source: true, agentId: true },
    });
    if (!current) return res.status(404).json({ error: "Шаблон не найден" });
    const finalCategory = patch.category ?? current.category;
    const finalSource = patch.source === undefined ? current.source : patch.source;
    const finalAgentId = patch.agentId === undefined ? current.agentId : patch.agentId;
    const issue = recurringAttributionIssue(finalCategory, finalSource, finalAgentId);
    if (issue) return res.status(400).json({ error: issue.message });
    attributionData = {
      source: finalCategory === "ADVERTISING" ? finalSource : null,
      agentId: finalCategory === "SALARY" ? finalAgentId : null,
    };
  }
  try {
    const row = await prisma.recurringExpense.update({
      where: { id: req.params.id },
      data: { ...patch, ...attributionData },
    });
    logAudit(req, "UPDATE", "RecurringExpense", row.id, { changed: Object.keys(parsed.data) });
    res.json(row);
  } catch (err) {
    // Только «записи нет» — 404 (№154). Любой другой отказ базы раньше выглядел как
    // «Шаблон не найден» и не попадал в журнал ошибок — пробрасываем в общий обработчик.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return res.status(404).json({ error: "Шаблон не найден" });
    }
    throw err;
  }
});

expensesRouter.delete("/recurring/:id", requireFinanceWrite, async (req, res) => {
  try {
    await prisma.recurringExpense.update({ where: { id: req.params.id },data:{deletedAt:new Date()} });
    logAudit(req, "DELETE", "RecurringExpense", req.params.id, {});
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return res.status(404).json({ error: "Шаблон не найден" });
    }
    throw err;
  }
});


/** Данные старше этого срока при открытии Финансов освежаются сами (см. ниже). */
const PULSE_STALE_MS = 15 * 60 * 1000;
let pulseSyncRunning = false;

/**
 * ПУЛЬС: приход, расход и остаток за сегодня / неделю / месяц / год со
 * сравнением с прошлым таким же периодом.
 *
 * «В РЕАЛЬНОМ ВРЕМЕНИ» (просьба владельца 20.08.2026: «расходы всегда
 * актуальные, а не раз в какое-то время»): открытие раздела само освежает
 * автоматические строки — расходы на ИИ пересчитываются из журнала обращений
 * сразу (это одна агрегация по своей же базе), а сверка с рекламным кабинетом
 * запускается в фоне, если её не было дольше 15 минут. Ответ при этом не ждёт
 * никого: цифры отдаются сразу, а refreshing говорит интерфейсу перечитать их
 * через полминуты.
 */
expensesRouter.get("/pulse", async (_req, res) => {
  // Расходы на ИИ: дёшево и всегда точно — считаем при каждом открытии.
  await upsertAiExpenses(recentMonths(2)).catch(() => 0);

  let refreshing = false;
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaAdsEnabled: true, metaAdsSyncedAt: true },
  });
  const syncedAgo = settings?.metaAdsSyncedAt ? Date.now() - settings.metaAdsSyncedAt.getTime() : Infinity;
  if (settings?.metaAdsEnabled && syncedAgo > PULSE_STALE_MS && !pulseSyncRunning) {
    const credentials = await loadMetaAdsCredentials();
    if (isMetaAdsConfigured(credentials)) {
      pulseSyncRunning = true;
      refreshing = true;
      void syncMetaAdsQuietly()
        .catch(() => null)
        .finally(() => {
          pulseSyncRunning = false;
        });
    }
  } else if (pulseSyncRunning) {
    refreshing = true;
  }

  res.json({ buckets: await buildFinancePulse(), refreshing, syncedAt: settings?.metaAdsSyncedAt ?? null });
});
