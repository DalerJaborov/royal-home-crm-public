import { z } from "zod";
import { expenseListQuerySchema, type ClientSource, type ExpensePivot } from "@royal-home/shared";
import { prisma } from "../db.js";
import { isDealSalaryExpense } from "./companyProfit.js";
import { getDealPayouts } from "./dealDocumentsDb.js";
import { dushanbeDayRange, dushanbeEndOfDay, dushanbeWallClock, DUSHANBE_OFFSET_MS } from "./dushanbeTime.js";
import { ExpenseCommandError } from "./expenseCommands.js";
import {
  expenseDay, expenseDtos, expenseWhere, ExpenseLifecycleError, occurrenceDates, orderedExpenseIds, todayExpenseDay,
} from "./expenseWorkspace.js";
import { centsToTjs, expenseCentsToTjs, fromCents, loadMoneyContext, splitCents, toCents } from "./money.js";
import { logSystemError } from "./systemError.js";

/**
 * ЧТЕНИЕ РАСХОДОВ — ОДНО МЕСТО ДЛЯ ЭКРАНА «РАСХОДЫ» И ПОМОЩНИЦЫ (10.11.2026).
 * Тела GET-маршрутов `routes/expenses.ts` / `routes/expenseWorkspace.ts` вынесены сюда
 * без изменений: помощница отвечает теми же цифрами, что видит экран, а не своей копией
 * арифметики.
 */

/**
 * Потолок выборки для /summary и /export (22.09.2026, класс «Пагинация» из
 * CLAUDE.md). Окно уже ограничено 60 месяцами, но само число сделок/расходов/
 * клиентов за пять лет ничем не ограничено — без потолка это неограниченная
 * выборка на один HTTP-запрос. 20 000 — с большим запасом над реальным темпом
 * этого агентства (сотни строк в месяц), предел на практике не задевается; если
 * всё же задет — не отдаём молча усечённые суммы, а говорим об этом в ответе.
 */
export const FINANCE_ROW_LIMIT = 20_000;

/**
 * Месяц по Душанбе, а не по UTC. Ровно та же ошибка уже была в отчётах: сделка,
 * закрытая 1-го числа до 05:00, попадала в прошлый месяц — и в сводке, и в
 * стоимости лида, и в выгрузке для бухгалтерии.
 */
export function monthKey(d: Date): string {
  const wall = dushanbeWallClock(d);
  return `${wall.getUTCFullYear()}-${String(wall.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Начало месяца по Душанбе как реальный момент времени (UTC-инстант). */
export function dushanbeMonthStart(yearsMonthsBack: number): Date {
  const wall = dushanbeWallClock();
  return new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() - yearsMonthsBack, 1) - DUSHANBE_OFFSET_MS);
}

/** GET /expenses — список с фильтрами и страницами. */
export async function listExpenses(raw: unknown) {
  const query = expenseListQuerySchema.safeParse(raw);
  if (!query.success) throw new ExpenseCommandError(400, { error: "Некорректные фильтры", details: query.error.flatten() });
  const where = expenseWhere(query.data);
  if (query.data.sortBy) {
    try {
      const context = query.data.sortBy === "amount" ? await loadMoneyContext() : undefined;
      const ids = await orderedExpenseIds(where, query.data.sortBy, query.data.sortDirection, context);
      const offset = query.data.page ? (query.data.page - 1) * query.data.pageSize : 0;
      const pageIds = ids.slice(offset, offset + (query.data.page ? query.data.pageSize : 200));
      const rows = await prisma.expense.findMany({ where: { id: { in: pageIds }, deletedAt: null }, include: { agent: { select: { id: true, fullName: true } }, receipts: true } });
      const byId = new Map(rows.map(row => [row.id, row]));
      const ordered = pageIds.flatMap(id => { const row = byId.get(id); return row ? [row] : []; });
      const items = await expenseDtos(ordered, context);
      return query.data.page ? { items, total: ids.length, page: query.data.page, pageSize: query.data.pageSize } : items;
    } catch (error) {
      if (error instanceof ExpenseLifecycleError) throw new ExpenseCommandError(error.status, { error: error.message });
      throw error;
    }
  }
  const expenses = await prisma.expense.findMany({
    where,
    orderBy: [{ month: "desc" }, { createdAt: "desc" }],
    include: { agent: { select: { id: true, fullName: true } }, receipts: true },
    take: query.data.page ? query.data.pageSize : 200,
    ...(query.data.page ? { skip: (query.data.page - 1) * query.data.pageSize } : {}),
  });
  const items = await expenseDtos(expenses);
  return query.data.page ? { items, total: await prisma.expense.count({ where }), page: query.data.page, pageSize: query.data.pageSize } : items;
}

/** GET /expenses/archive — удалённые расходы за диапазон дат (по Душанбе). */
export async function listArchivedExpenses(fromValue?: unknown, toValue?: unknown) {
  // Границы суток — по Душанбе (аудит №4). Голый new Date("2026-08-26") даёт
  // полночь UTC: выбор одного дня (с 26.08 по 26.08) сравнивался с единственным
  // мгновением и всегда возвращал пусто, а в диапазоне первый день терял утро,
  // а последний обрезался на 05:00 местного.
  const fromRaw = typeof fromValue === "string" ? new Date(fromValue) : undefined;
  const toRaw = typeof toValue === "string" ? new Date(toValue) : undefined;
  const from = fromRaw && !Number.isNaN(fromRaw.getTime()) ? dushanbeDayRange(fromRaw).start : undefined;
  const to = toRaw && !Number.isNaN(toRaw.getTime()) ? dushanbeEndOfDay(toRaw) : undefined;
  return prisma.expense.findMany({
    where: { deletedAt: { not: null, ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } },
    orderBy: { deletedAt: "desc" },
    include: { agent: { select: { id: true, fullName: true } } },
    take: 200,
  });
}

/** GET /expenses/recurring — шаблоны с датой ближайшего неоплаченного платежа. */
export async function listRecurringExpenses() {
  const rows = await prisma.recurringExpense.findMany({ where: { deletedAt: null }, orderBy: [{ active: "desc" }, { dayOfMonth: "asc" }], take: 100 });
  const today = todayExpenseDay();
  const to = new Date(expenseDay(today));
  to.setUTCFullYear(to.getUTCFullYear() + 2);
  const payments = await prisma.expense.findMany({ where: { deletedAt: null, status: "PAID", OR: [{ recurringId: { in: rows.map(r => r.id) } }, { autoKey: { startsWith: "rec:" } }] }, select: { autoKey: true, recurringId: true, occurrenceDate: true }, take: 20001 });
  if (payments.length > 20000) throw new ExpenseLifecycleError(413, "Слишком много платежей для списка подписок");
  return rows.map(row => ({ ...row, nextDate: row.active ? occurrenceDates(row, today, to.toISOString().slice(0, 10)).find(day => !row.skippedDates.includes(day) && !payments.some(p => p.recurringId === row.id && p.occurrenceDate === day || p.autoKey === `rec:${row.id}:${day.slice(0, 7)}` || p.autoKey === `rec:${row.id}:${day}`)) ?? null : null }));
}

/** Отфильтрованные расходы целиком, с потолком (pivot, CSV). */
export async function filteredExpenses(query: unknown) {
  const p = expenseListQuerySchema.parse(query);
  const rows = await prisma.expense.findMany({ where: expenseWhere(p), take: 20001, orderBy: [{ month: "asc" }, { createdAt: "asc" }] });
  if (rows.length > 20000) throw new ExpenseLifecycleError(413, "Сузьте период: более 20 000 расходов");
  return rows;
}

/** GET /expenses/pivot — оплаченные расходы: категория × месяц, в сомони. */
export async function buildExpensePivot(filters: z.infer<typeof expenseListQuerySchema>): Promise<ExpensePivot> {
  const [expenses, categories, money] = await Promise.all([filteredExpenses({ ...filters, status: "PAID" }), prisma.expenseCategoryDefinition.findMany(), loadMoneyContext()]);
  const result: ExpensePivot = { months: [], rows: [], totalTjs: 0 };
  const groups = new Map<string, ExpensePivot["rows"][number]>();
  let total = 0;
  for (const e of expenses) {
    const month = e.month.toISOString().slice(0, 7);
    if (!result.months.includes(month)) result.months.push(month);
    const key = e.categoryId ?? e.category;
    const cat = categories.find(c => c.id === e.categoryId);
    let row = groups.get(key);
    if (!row) {
      row = { categoryId: key, title: cat?.title ?? e.category, rootCategory: e.category, color: cat?.color ?? "#7F97B4", values: {} };
      groups.set(key, row);
    }
    const amount = expenseCentsToTjs(e, money);
    row.values[month] = (row.values[month] ?? 0) + amount;
    total += amount;
  }
  result.months.sort();
  result.rows = [...groups.values()].map(r => ({ ...r, values: Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, fromCents(v)])) }));
  result.totalTjs = fromCents(total);
  return result;
}

/** GET /expenses/categories — справочник с частотой и тратой за месяц. */
export async function listExpenseCategories(month: string) {
  const cutoff = new Date(Date.now() - 90 * 86400000);
  const [categories, expenses, money] = await Promise.all([prisma.expenseCategoryDefinition.findMany({ orderBy: { title: "asc" } }), prisma.expense.findMany({ where: { deletedAt: null, status: "PAID", OR: [{ month: expenseDay(`${month}-01`) }, { createdAt: { gte: cutoff } }] }, take: 20001 }), loadMoneyContext()]);
  if (expenses.length > 20000) throw new ExpenseLifecycleError(413, "Слишком много расходов для справочника");
  return categories.map(c => {
    const ids = new Set([c.id]);
    for (let i = 0; i < categories.length; i++) {
      let changed = false;
      for (const child of categories) if (child.parentId && ids.has(child.parentId) && !ids.has(child.id)) { ids.add(child.id); changed = true; }
      if (!changed) break;
    }
    const isRoot = /^00000000-0000-4000-8000-00000000000[1-4]$/.test(c.id);
    const matches = expenses.filter(e => isRoot ? e.category === c.rootCategory : !!e.categoryId && ids.has(e.categoryId));
    return { ...c, usageCount: matches.filter(e => e.createdAt >= cutoff).length, spentTjs: fromCents(matches.filter(e => e.month.toISOString().slice(0, 7) === month).reduce((sum, e) => sum + expenseCentsToTjs(e, money), 0)) };
  }).sort((a, b) => b.usageCount - a.usageCount || a.title.localeCompare(b.title, "ru"));
}

/**
 * Финансовая сводка за последние N месяцев (по умолчанию 6) — тело GET /expenses/summary,
 * вынесено без изменений (10.11.2026), чтобы помощница читала те же цифры, что экран.
 */
export async function buildExpenseSummary(query: { months?: unknown; through?: unknown }) {
  const monthsBack = Math.min(Math.max(Number(query.months) || 6, 1), 60);
  const through=z.string().regex(/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/).optional().safeParse(query.through);
  if(!through.success)throw new ExpenseCommandError(400,{error:"Некорректный месяц"});
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
  return { months: summary, currency: "TJS" as const, usdToTjsRate: money.usdToTjs, truncated };
}
