import { Router, type Response } from "express";
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
import { centsToTjs, fromCents, loadMoneyContext, splitCents, toCents } from "../lib/money.js";
import { dushanbeWallClock } from "../lib/dushanbeTime.js";
import { logSystemError } from "../lib/systemError.js";
import { csvSafeText } from "../lib/csv.js";
import { expenseWorkspaceRouter } from "./expenseWorkspace.js";
import { expenseDtos, ExpenseLifecycleError } from "../lib/expenseWorkspace.js";
import { expenseCentsToTjs } from "../lib/money.js";
import {
  createExpense, createRecurringExpense, deleteExpense, deleteRecurringExpense, ExpenseCommandError, restoreExpense,
  updateExpense, updateRecurringExpense,
} from "../lib/expenseCommands.js";
import {
  buildExpenseSummary, dushanbeMonthStart, FINANCE_ROW_LIMIT, listArchivedExpenses, listExpenses, listRecurringExpenses, monthKey,
} from "../lib/expenseQueries.js";

export const expensesRouter = Router();

// Раздел целиком закрыт правом «Финансы»; изменение расходов — правом finance.manage.
expensesRouter.use(requireAuth, requirePermission("finance.view"));
// Читать финансы и вести их — разные права: бухгалтеру можно открыть цифры,
// не давая заводить, править и удалять расходы.
const requireFinanceWrite = requirePermission("finance.manage");
expensesRouter.use(expenseWorkspaceRouter);

/** Ответ REST по ошибке правила из lib/expenseCommands.ts — тот же статус и текст, что раньше. */
function commandFailed(res: Response, err: unknown): boolean {
  if (!(err instanceof ExpenseCommandError)) return false;
  res.status(err.status).json(err.body);
  return true;
}


expensesRouter.get("/", async (req, res) => {
  try {
    res.json(await listExpenses(req.query));
  } catch (err) {
    if (!commandFailed(res, err)) throw err;
  }
});

/** Архив удалённых расходов за диапазон дат — ничего не удаляется физически, только
 * скрывается из активных списков. ADMIN/DIRECTOR может посмотреть и восстановить. */
expensesRouter.get("/archive", async (req, res) => {
  res.json(await listArchivedExpenses(req.query.from, req.query.to));
});

expensesRouter.patch("/:id/restore", requireFinanceWrite, async (req, res) => {
  try {
    const expense = await restoreExpense(req.params.id);
    logAudit(req, "RESTORE", "Expense", expense.id, { category: expense.category, amount: expense.amount.toString() });
    res.json(expense);
  } catch (err) {
    if (!commandFailed(res, err)) throw err;
  }
});

expensesRouter.post("/", requireFinanceWrite, async (req, res) => {
  try {
    const { expense, month } = await createExpense(req.body, { agentId: req.agent!.id, idempotencyKey: req.get("Idempotency-Key") });
    // Единственный из четырёх пишущих роутов, который не писал в аудит: заведение
    // денег оставалось без следа, а правка и удаление — со следом.
    logAudit(req, "EXPENSE_CREATE", "Expense", expense.id, {
      amount: Number(expense.amount),
      category: expense.category,
      month,
    });
    res.status(201).json((await expenseDtos([expense]))[0]);
  } catch (err) {
    if (!commandFailed(res, err)) throw err;
  }
});

expensesRouter.patch("/:id", requireFinanceWrite, async (req, res) => {
  try {
    const { expense, changed } = await updateExpense(req.params.id, req.body);
    logAudit(req, "UPDATE", "Expense", expense.id, { changed });
    res.json((await expenseDtos([expense]))[0]);
  } catch (err) {
    if (!commandFailed(res, err)) throw err;
  }
});

expensesRouter.delete("/:id", requireFinanceWrite, async (req, res) => {
  const parsed = z.object({ version: z.coerce.number().int().nonnegative().optional() }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Неверная версия расхода" });
  try {
    // Мягкое удаление — запись остаётся в архиве, доступна для восстановления.
    const deleted = await deleteExpense(req.params.id, parsed.data.version);
    logAudit(req, "DELETE", "Expense", deleted.id, {
      category: deleted.category,
      amount: deleted.amount.toString(),
      month: deleted.month,
    });
    res.status(204).end();
  } catch (err) {
    if (!commandFailed(res, err)) throw err;
  }
});

/**
 * Финансовая сводка за последние N месяцев (по умолчанию 6):
 * доход (комиссии закрытых сделок) − расходы = прибыль; реклама детализируется
 * по источникам вместе с числом лидов → стоимость лида по каждому каналу.
 */
expensesRouter.get("/summary", async (req, res) => {
  try {
    res.json(await buildExpenseSummary({ months: req.query.months, through: req.query.through }));
  } catch (err) {
    if (!commandFailed(res, err)) throw err;
  }
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


/** Повторяющиеся платежи: список шаблонов — активные и выключенные. */
expensesRouter.get("/recurring", async (_req, res) => {
  try {
    res.json(await listRecurringExpenses());
  } catch (err) {
    if (err instanceof ExpenseLifecycleError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

expensesRouter.post("/recurring", requireFinanceWrite, async (req, res) => {
  try {
    const row = await createRecurringExpense(req.body);
    logAudit(req, "CREATE", "RecurringExpense", row.id, { title: row.title, amount: Number(row.amount) });
    res.status(201).json(row);
  } catch (err) {
    if (!commandFailed(res, err)) throw err;
  }
});

expensesRouter.patch("/recurring/:id", requireFinanceWrite, async (req, res) => {
  try {
    const { row, changed } = await updateRecurringExpense(req.params.id, req.body);
    logAudit(req, "UPDATE", "RecurringExpense", row.id, { changed });
    res.json(row);
  } catch (err) {
    if (!commandFailed(res, err)) throw err;
  }
});

expensesRouter.delete("/recurring/:id", requireFinanceWrite, async (req, res) => {
  try {
    await deleteRecurringExpense(req.params.id);
    logAudit(req, "DELETE", "RecurringExpense", req.params.id, {});
    res.json({ ok: true });
  } catch (err) {
    if (!commandFailed(res, err)) throw err;
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
