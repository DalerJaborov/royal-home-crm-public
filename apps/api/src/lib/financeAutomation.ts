import { expenseCentsToTjs } from "./money.js";
import { prisma } from "../db.js";
import { DEAL_SALARY_AUTO_KEY_PREFIX, dealSalaryAutoKey, isDealSalaryExpense } from "./companyProfit.js";
import { describeError } from "./describeError.js";
import { DUSHANBE_OFFSET_MS, dushanbeWallClock } from "./dushanbeTime.js";
import { centsToTjs, fromCents, loadMoneyContext, toCents } from "./money.js";
import { logSystemError } from "./systemError.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { shouldAlert } from "./notifications.js";
import { processWorkspaceRecurringExpenses } from "./expenseWorkspace.js";

/**
 * АВТОМАТИКА ФИНАНСОВ: повторяющиеся платежи, зарплаты из сделок, прогноз и
 * оповещения (решение владельца 20.08.2026 — «всё стекается в Расходы»).
 *
 * Всё построено на одном приёме — идемпотентном ключе Expense.autoKey: сколько бы
 * раз ни сработал крон, строка одна. Удалённые человеком строки не воскрешаются
 * (см. adExpenseSync.ts, правило общее).
 */

/** «2026-08» текущего месяца по Душанбе. */
function currentMonthKey(): string {
  const wall = dushanbeWallClock();
  return `${wall.getUTCFullYear()}-${String(wall.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthToDate(month: string): Date {
  return new Date(`${month}-01T00:00:00.000Z`);
}

/** Кому слать финансовые напоминания: директора и админы с правом финансов. */
const FINANCE_RECIPIENT_ROLES = ["DIRECTOR", "ADMIN"] as const;

/**
 * ПОВТОРЯЮЩИЕСЯ ПЛАТЕЖИ — суточный тик.
 *
 * За три дня до срока — напоминание «подходит оплата»; в сам день — строка
 * расхода из шаблона и уведомление «строка заведена, не забудьте оплатить».
 */
export async function processRecurringExpenses(): Promise<{ created: number; reminded: number }> {
  await processWorkspaceRecurringExpenses();
  const wall = dushanbeWallClock();
  const today = wall.getUTCDate();
  const month = currentMonthKey();

  const templates = await prisma.recurringExpense.findMany({ where: { active: true,deletedAt:null,startsOn:null } });
  if (templates.length === 0) return { created: 0, reminded: 0 };
  const paymentMoney = templates.some(t => t.autoPay) ? await loadMoneyContext() : null;

  let created = 0;
  let reminded = 0;

  for (const t of templates) {
    try {
      // Напоминание за 3 дня. dayOfMonth ограничен 1–28, переход через месяц не нужен.
      // Само решение (строка/отметка) не ждёт часов алармов — только доставка
      // (владелец 07.09.2026): этот тик крутится в 01:20 ночи, а идемпотентный
      // lastRemindedMonth/lastCreatedMonth должен проставиться сразу, иначе тик
      // следующей ночи посчитает то же самое повторно.
      if (t.lastRemindedMonth !== month && today >= t.dayOfMonth - 3 && today < t.dayOfMonth) {
        // Отметка идёт ДО оповещения (принцип из lib/dealReservation.ts): падение
        // между ними должно оставить неотправленный аларм, не невыставленную
        // отметку — иначе следующая ночь напомнит второй раз о том же самом.
        await prisma.recurringExpense.update({ where: { id: t.id }, data: { lastRemindedMonth: month } });
        await enqueueDirectorAlert({
          kind: "finance",
          title: `Скоро оплата: ${t.title}`,
          body: `${t.dayOfMonth}-го числа — ${Number(t.amount)} ${t.currency === "USD" ? "$" : "с."} (${t.title}). CRM заведёт строку расхода сама, оплату проводит человек.`,
          url: "/finance",
          recipientRoles: [...FINANCE_RECIPIENT_ROLES],
        });
        reminded++;
      }

      // День оплаты: заводим строку.
      if (t.lastCreatedMonth !== month && today >= t.dayOfMonth) {
        const autoKey = `rec:${t.id}:${month}`;
        const existing = await prisma.expense.findUnique({ where: { autoKey }, select: { id: true } });
        let expenseCreated = false;
        if (!existing) {
          // Строка расхода и отметка шаблона — одной транзакцией: autoKey уникален,
          // так что повторного расхода не будет, но без атомарности падение между
          // ними оставляет шаблон непомеченным, и следующий ночной тик заново шлёт
          // «Пора оплатить» по уже заведённой строке.
          await prisma.$transaction([
            prisma.expense.create({
              data: {
                autoKey,
                recurringId:t.id,
                occurrenceDate:`${month}-${String(t.dayOfMonth).padStart(2,"0")}`,
                status:t.autoPay?"PAID":"PLANNED",
                ...(t.autoPay ? {
                  exchangeRate: t.currency === "USD" ? paymentMoney!.usdToTjs : 1,
                  rateCapturedAt: new Date(),
                } : {}),
                paymentDate:new Date(`${month}-${String(t.dayOfMonth).padStart(2,"0")}T00:00:00.000Z`),
                month: monthToDate(month),
                amount: t.amount,
                currency: t.currency,
                category: t.category,
                // Канал и сотрудник шаблона (CRM-07, 04.10.2026): без них реклама
                // выпадала из стоимости лида по каналам, а зарплату нельзя править.
                // Шаблоны без этих полей (заведены раньше) создают расход, как и раньше.
                source: t.category === "ADVERTISING" ? t.source : null,
                agentId: t.category === "SALARY" ? t.agentId : null,
                note: `${t.title} — повторяющийся платёж, строка заведена автоматически.${t.note ? ` ${t.note}` : ""}`,
              },
            }),
            prisma.recurringExpense.update({ where: { id: t.id }, data: { lastCreatedMonth: month } }),
          ]);
          expenseCreated = true;
          created++;
        } else {
          await prisma.recurringExpense.update({ where: { id: t.id }, data: { lastCreatedMonth: month } });
        }
        if (expenseCreated) {
          await enqueueDirectorAlert({
            kind: "finance",
            title: `Пора оплатить: ${t.title}`,
            body: `Строка расхода за ${month} заведена (${Number(t.amount)} ${t.currency === "USD" ? "$" : "с."}). Осталось провести оплату.`,
            url: "/finance",
            recipientRoles: [...FINANCE_RECIPIENT_ROLES],
          });
        }
      }
    } catch (err) {
      void logSystemError("api", `Повторяющийся платёж «${t.title}» не обработан: ${describeError(err)}`);
    }
  }
  return { created, reminded };
}

/**
 * ЗАРПЛАТЫ ИЗ СДЕЛОК — в начале месяца за прошлый месяц.
 *
 * По каждой закрытой (COMPLETED) сделке прошлого месяца доли уже зафиксированы
 * снапшотом (commissionRealtorAmount / commissionIntakeAmount, см. schema) —
 * складываем по агентам и заводим строки SALARY. Это учётная строка «сколько
 * причитается», а не факт выплаты: выплату проводит человек, строка делает так,
 * чтобы Финансы её не забыли.
 */
export async function upsertSalaryExpenses(forMonth?: string): Promise<number> {
  const wall = dushanbeWallClock();
  // По умолчанию — прошлый месяц по Душанбе. forMonth («2026-08») — пересчёт
  // конкретного месяца: после правки долей уже закрытой сделки (№212) строка
  // того месяца должна догнать снапшот, а ночной тик смотрит только на прошлый.
  const prev = forMonth
    ? new Date(`${forMonth}-01T00:00:00.000Z`)
    : new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() - 1, 1));
  const month = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
  const from = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), 1) - DUSHANBE_OFFSET_MS);
  const to = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 1) - DUSHANBE_OFFSET_MS);

  const deals = await prisma.deal.findMany({
    where: { stage: "COMPLETED", closedAt: { gte: from, lt: to } },
    select: {
      agentId: true,
      commissionRealtorAmount: true,
      commissionIntakeAmount: true,
      commissionIntakeAgentId: true,
      currency: true,
    },
  });
  // Раннего выхода при пустом списке НЕТ нарочно (аудит Codex 04.10.2026, №7): после
  // аннулирования последней закрытой сделки месяца список пуст, а строки «причитается»
  // этого месяца надо обнулить — см. цикл по staleRows ниже.

  const money = await loadMoneyContext();
  /** Агент → причитается, В ЦЕЛЫХ СОТЫХ СОМОНИ (доли в валюте сделки приводим
   *  к отчётной). Складывать доли float'ом нельзя: это зарплата живых людей,
   *  и хвост в последних знаках уходил прямо в строку расхода. */
  const byAgent = new Map<string, number>();
  /**
   * Агент → отпечаток исходных долей В ВАЛЮТЕ СДЕЛКИ (аудит №4, 27.08).
   *
   * Именно он решает, надо ли переписывать уже заведённую строку. Сравнивать
   * итог в сомони нельзя: он пересчитывается по КУРСУ НА СЕГОДНЯ, и строка
   * «зарплата июля» месяц ездила вслед за курсом — бухгалтерия каждый раз
   * видела новую сумму за закрытый период.
   */
  const fingerprintOf = new Map<string, string[]>();
  const addShare = (agentId: string, amount: unknown, currency: string) => {
    const cents = toCents(amount);
    byAgent.set(agentId, (byAgent.get(agentId) ?? 0) + centsToTjs(cents, currency, money));
    const parts = fingerprintOf.get(agentId) ?? [];
    parts.push(`${currency}:${fromCents(cents)}`);
    fingerprintOf.set(agentId, parts);
  };
  for (const d of deals) {
    if (d.agentId && d.commissionRealtorAmount) {
      addShare(d.agentId, d.commissionRealtorAmount, d.currency);
    }
    if (d.commissionIntakeAgentId && d.commissionIntakeAmount) {
      addShare(d.commissionIntakeAgentId, d.commissionIntakeAmount, d.currency);
    }
  }

  let touched = 0;
  for (const [agentId, amountCents] of byAgent) {
    const autoKey = dealSalaryAutoKey(agentId, month);
    try {
      const existing = await prisma.expense.findUnique({
        where: { autoKey },
        select: { id: true, deletedAt: true, amount: true, autoFingerprint: true, manualEditedAt: true },
      });
      if (existing?.deletedAt) continue;
      if (amountCents <= 0) {
        // Все доли агента за месяц обнулены (№212: директор аннулировал сделку).
        // Новую строку на ноль не заводим, а уже заведённую автоматикой —
        // обнуляем, чтобы «причитается» не висело от аннулированной сделки.
        // Ручную правку директора и здесь не откатываем.
        if (existing && !existing.manualEditedAt && Number(existing.amount) !== 0) {
          await prisma.expense.update({
            where: { id: existing.id },
            data: { amount: 0, autoFingerprint: (fingerprintOf.get(agentId) ?? []).sort().join("|") },
          });
          touched++;
        }
        continue;
      }
      const rounded = fromCents(amountCents);
      // Порядок долей в отпечатке не должен зависеть от порядка выборки сделок.
      const fingerprint = (fingerprintOf.get(agentId) ?? []).sort().join("|");
      if (existing) {
        // Сумму правил человек — автоматика молчит (раньше правку директора
        // откатывала ближайшая ночь).
        if (existing.manualEditedAt) continue;
        // Набор и суммы долей те же — строку не трогаем, даже если курс уехал.
        // Старым строкам (отпечатка ещё нет) он проставляется без изменения суммы.
        if (existing.autoFingerprint === fingerprint) continue;
        await prisma.expense.update({
          where: { id: existing.id },
          data: existing.autoFingerprint === null ? { autoFingerprint: fingerprint } : { amount: rounded, autoFingerprint: fingerprint },
        });
        touched++;
        continue;
      }
      await prisma.expense.create({
        data: {
          autoKey,
          autoFingerprint: fingerprint,
          month: monthToDate(month),
          amount: rounded,
          currency: "TJS",
          category: "SALARY",
          agentId,
          note: `Доля агента по закрытым сделкам за ${month} — посчитано автоматически из снапшотов комиссий. Это «причитается», факт выплаты проводит человек.`,
        },
      });
      touched++;
    } catch (err) {
      void logSystemError("api", `Зарплатная строка ${autoKey} не записана: ${describeError(err)}`);
    }
  }

  /**
   * АГЕНТЫ БЕЗ ЗАКРЫТЫХ СДЕЛОК В МЕСЯЦЕ (аудит Codex 04.10.2026, №7).
   *
   * byAgent строится из COMPLETED-сделок: агент, у которого сделку аннулировали
   * (CANCELLED) и других закрытых за месяц нет, в нём не появляется, и цикл выше
   * его строку никогда не видит. Автоматика обнуляет такие строки сама: тот же
   * «ноль», что в ветке amountCents <= 0, с пустым отпечатком (долей нет).
   * Ручную правку директора (manualEditedAt) и удалённые строки не трогаем.
   */
  const activeKeys = new Set([...byAgent.keys()].map((agentId) => dealSalaryAutoKey(agentId, month)));
  try {
    const staleRows = await prisma.expense.findMany({
      where: {
        month: monthToDate(month),
        autoKey: { startsWith: DEAL_SALARY_AUTO_KEY_PREFIX, endsWith: `:${month}` },
        deletedAt: null,
        manualEditedAt: null,
        amount: { not: 0 },
      },
      select: { id: true, autoKey: true },
    });
    for (const row of staleRows) {
      if (!row.autoKey || activeKeys.has(row.autoKey)) continue;
      try {
        const zeroed = await prisma.expense.updateMany({
          where: { id: row.id, deletedAt: null, manualEditedAt: null },
          data: { amount: 0, autoFingerprint: "" },
        });
        touched += zeroed.count;
      } catch (err) {
        void logSystemError("api", `Зарплатная строка ${row.autoKey} не обнулена: ${describeError(err)}`);
      }
    }
  } catch (err) {
    void logSystemError("api", `Зарплатные строки ${month} без закрытых сделок не просмотрены: ${describeError(err)}`);
  }
  return touched;
}

export interface ExpenseForecast {
  month: string;
  /** Потрачено с начала месяца, сомони. */
  spentTjs: number;
  /** Прогноз на конец месяца по текущему темпу. */
  projectedTjs: number;
  /** Средний месяц за три предыдущих. */
  averageTjs: number;
  /** Прогноз превышает средний более чем на 25%. */
  overrun: boolean;
}

/**
 * ПРОГНОЗ РАСХОДОВ: линейная экстраполяция текущего месяца + сравнение со средним
 * трёх прошлых. Без машинного обучения нарочно: владельцу нужна ранняя цифра
 * «куда идём», а не модель — и объяснимость важнее точности.
 */
export async function buildExpenseForecast(): Promise<ExpenseForecast> {
  const wall = dushanbeWallClock();
  const month = currentMonthKey();
  const daysInMonth = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 0)).getUTCDate();
  const dayOfMonth = wall.getUTCDate();

  const money = await loadMoneyContext();
  const monthStart = monthToDate(month);

  const [currentRows, previousRows] = await Promise.all([
    prisma.expense.findMany({
      where: { deletedAt: null,status:"PAID", month: monthStart },
      select: { amount: true, currency: true, autoKey: true,exchangeRate:true },
    }),
    prisma.expense.findMany({
      where: {
        deletedAt: null,
        status:"PAID",
        month: {
          gte: new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() - 3, 1)),
          lt: monthStart,
        },
      },
      select: { amount: true, currency: true, month: true, autoKey: true,exchangeRate:true },
    }),
  ]);
  // Авто-строки «Зарплата из сделок» не сравниваем (C2, lib/companyProfit.ts):
  // строка месяца заводится только 1-го числа СЛЕДУЮЩЕГО, поэтому в текущем
  // месяце её нет никогда, а в среднем трёх прошлых она есть всегда — прогноз
  // сравнивал бы разное. Да и это доли агентов из сделок, а не траты.
  const current = currentRows.filter((e) => !isDealSalaryExpense(e));
  const previous = previousRows.filter((e) => !isDealSalaryExpense(e));

  // Всё в целых сотых: суммы отсюда идут в уведомление директору о превышении
  // бюджета, и расходиться с разделом «Финансы» они не должны ни на копейку.
  const spentCents = current.reduce((acc, e) => acc + expenseCentsToTjs(e, money), 0);
  // Месячные строки (реклама, зарплата) не растут по дням равномерно, но линейная
  // экстраполяция всё равно честнее, чем ничего: к середине месяца она уже близка.
  const projectedCents = dayOfMonth > 0 ? Math.round((spentCents / dayOfMonth) * daysInMonth) : spentCents;

  const byMonth = new Map<string, number>();
  for (const e of previous) {
    const key = e.month.toISOString().slice(0, 7);
    byMonth.set(key, (byMonth.get(key) ?? 0) + expenseCentsToTjs(e, money));
  }
  // Знаменатель — календарные месяцы окна (до трёх), считая от месяца самой ранней
  // траты компании (аудит 04.10.2026, ACCESS-14). Раньше делили на число месяцев, в
  // которых есть строки: завершённый месяц с нулём расходов выпадал из среднего,
  // база завышалась, и тревога о превышении молчала. Компания моложе трёх месяцев
  // делится на свой возраст, как и прежде.
  let monthsInWindow = byMonth.size;
  if (byMonth.size > 0) {
    // Зарплатные авто-строки не считаем «началом истории»: в среднее они не входят.
    const first = await prisma.expense.findFirst({
      where: {
        deletedAt: null,
        OR: [{ autoKey: null }, { autoKey: { not: { startsWith: DEAL_SALARY_AUTO_KEY_PREFIX } } }],
      },
      orderBy: { month: "asc" },
      select: { month: true },
    });
    if (first) {
      const age = (wall.getUTCFullYear() - first.month.getUTCFullYear()) * 12 + (wall.getUTCMonth() - first.month.getUTCMonth());
      monthsInWindow = Math.max(byMonth.size, Math.min(3, age));
    }
  }
  const averageCents =
    byMonth.size > 0 ? Math.round(Array.from(byMonth.values()).reduce((a, b) => a + b, 0) / monthsInWindow) : 0;

  return {
    month,
    spentTjs: fromCents(spentCents),
    projectedTjs: fromCents(projectedCents),
    averageTjs: fromCents(averageCents),
    overrun: averageCents > 0 && projectedCents > averageCents * 1.25,
  };
}

/** Предохранитель по частоте (владелец 15.09.2026) — см. shouldAlert в notifications.ts.
 *  Раньше дедуп держался в переменной процесса (overrunAlertedMonth) — рестарт API
 *  (деплой, падение) обнулял её, и суточный тик в тот же день слал напоминание
 *  заново. shouldAlert проверяет по БД (PendingDirectorAlert/Notification), значит
 *  переживает рестарт. */
const ALERT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Суточная проверка: прогноз превышает средний — оповестить директора. */
export async function alertExpenseOverrun(now: Date = new Date()): Promise<boolean> {
  const forecast = await buildExpenseForecast();
  // До 10-го числа темп месяца ещё случайный (одна крупная строка в начале месяца
  // «прогнозирует» тройной бюджет) — молчим, чтобы не приучать игнорировать.
  if (!forecast.overrun || dushanbeWallClock().getUTCDate() < 10) return false;

  const tag = `finance-overrun-${forecast.month}`;
  if (!(await shouldAlert(tag, ALERT_MIN_INTERVAL_MS, now))) return false;

  await enqueueDirectorAlert({
    kind: "finance",
    title: "Расходы идут на превышение",
    body:
      `По темпу месяца выйдет ~${forecast.projectedTjs.toLocaleString("ru-RU")} с. — ` +
      `это заметно больше среднего за три месяца (${forecast.averageTjs.toLocaleString("ru-RU")} с.). Загляните в Финансы.`,
    url: "/finance",
    tag,
    recipientRoles: [...FINANCE_RECIPIENT_ROLES],
  });
  return true;
}
