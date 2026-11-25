import { prisma } from "../db.js";
import { DUSHANBE_OFFSET_MS, dushanbeWallClock } from "./dushanbeTime.js";
import { isDealSalaryExpense } from "./companyProfit.js";
import { adSpendToTjsCents, centsToTjs, fromCents, loadMoneyContext, roundMoney, splitCents, toCents, toTjs } from "./money.js";
import { AI_ESTIMATE_VENDORS, COMMISSION_COMPANY_PERCENT, COMMISSION_REALTOR_PERCENT, splitAiEstimate } from "@royal-home/shared";
import { dushanbeDateString, dushanbeMonthRange } from "./dushanbeTime.js";
import { SYNCED_AD_PLATFORMS } from "./ads/adExpenseSync.js";
import { monthKey } from "./expenseQueries.js";
import { expenseCentsToTjs } from "./money.js";

/**
 * ПУЛЬС ДЕНЕГ — приход, расход и остаток за сегодня, неделю, месяц и год.
 *
 * Зачем отдельно от месячной сводки: сводка отвечает на вопрос бухгалтера
 * («как закрылся месяц»), а владельцу нужен вопрос хозяина — «что происходит
 * прямо сейчас и лучше ли, чем было». Отсюда два отличия: периоды короче месяца
 * и обязательное сравнение с предыдущим таким же периодом. Число без сравнения
 * не значит ничего: 4 000 сомони за неделю — это много или мало?
 *
 * ПРИХОД — доля компании в комиссии по сделкам, закрытым в периоде (снапшот
 * commissionCompanyAmount, зафиксированный при закрытии). Не валовая комиссия:
 * доли агентов компании не принадлежат, и показывать их приходом значит
 * завышать доход втрое.
 *
 * СУТКИ — по Душанбе (UTC+5), как и везде в CRM: контейнер живёт в UTC, и
 * «сегодня» без сдвига означало бы, что день начинается в пять утра.
 */

export type PulsePeriod = "today" | "week" | "month" | "year";

export interface PulseBucket {
  period: PulsePeriod;
  incomeTjs: number;
  /** Расход компании — все строки, кроме авто-зарплат из сделок (их доля уже не в приходе, C2). */
  expenseTjs: number;
  /** Приход минус расход. Отрицательное — жили в минус. */
  balanceTjs: number;
  /** Тот же остаток за предыдущий такой же период — для сравнения. */
  previousBalanceTjs: number;
  previousIncomeTjs: number;
  previousExpenseTjs: number;
  /** Понятная человеку подпись: «сегодня», «эта неделя», «август», «2026». */
  label: string;
}

/** Границы периода и предыдущего такого же — в реальных моментах времени (UTC). */
function bounds(period: PulsePeriod): { from: Date; to: Date; prevFrom: Date; prevTo: Date; label: string } {
  const wall = dushanbeWallClock();
  const y = wall.getUTCFullYear();
  const m = wall.getUTCMonth();
  const d = wall.getUTCDate();
  /** Полночь по Душанбе как момент времени. */
  const at = (year: number, month: number, day: number) => new Date(Date.UTC(year, month, day) - DUSHANBE_OFFSET_MS);

  switch (period) {
    case "today": {
      const from = at(y, m, d);
      return {
        from,
        to: at(y, m, d + 1),
        prevFrom: at(y, m, d - 1),
        prevTo: from,
        label: "сегодня",
      };
    }
    case "week": {
      // Неделя с понедельника: воскресенье как начало недели читается неверно
      // всеми, кто планирует работу с понедельника.
      const weekday = (wall.getUTCDay() + 6) % 7;
      const from = at(y, m, d - weekday);
      return {
        from,
        to: at(y, m, d - weekday + 7),
        prevFrom: at(y, m, d - weekday - 7),
        prevTo: from,
        label: "эта неделя",
      };
    }
    case "month": {
      const from = at(y, m, 1);
      return {
        from,
        to: at(y, m + 1, 1),
        prevFrom: at(y, m - 1, 1),
        prevTo: from,
        label: new Date(Date.UTC(y, m, 1)).toLocaleDateString("ru-RU", { month: "long", timeZone: "UTC" }),
      };
    }
    case "year": {
      const from = at(y, 0, 1);
      return {
        from,
        to: at(y + 1, 0, 1),
        prevFrom: at(y - 1, 0, 1),
        prevTo: from,
        label: String(y),
      };
    }
  }
}

const PERIODS: PulsePeriod[] = ["today", "week", "month", "year"];

/**
 * Все четыре периода разом: экран показывает их плашками, и четыре отдельных
 * запроса ради одного экрана — лишние четыре обхода базы.
 */
/** Автострока месяца: реклама из кабинета или оценка ИИ — у неё нет дня, только месяц. */
const isMonthlyAutoRow = (e: { autoKey: string | null }) => !!e.autoKey && (e.autoKey.startsWith("ads:") || e.autoKey.startsWith("ai:"));

/**
 * РЕКЛАМА И ИИ ЗА ДЕНЬ/НЕДЕЛЮ — ИЗ ДНЕВНЫХ ИСТОЧНИКОВ (аудит денег 17.11.2026).
 *
 * Строки «Реклама за месяц» и «ИИ за месяц» дня не имеют, а «Пульс» за день и неделю относил их к
 * дню заведения строки: весь ноябрь рекламы ложился на 10.11, «эта неделя» показывала 0 при факте
 * 176 с. Теперь за день и неделю реклама — сумма AdSpendDaily по дням (то же, из чего собрана строка
 * месяца), ИИ — журнал обращений по тому же правилу «счёт поставщика сильнее оценки», что строка ai:.
 * Месяц и год по-прежнему считаются по строкам месяца — как «Финансы».
 */
async function dailyAutoSpendTjs(from: Date, to: Date, money: Awaited<ReturnType<typeof loadMoneyContext>>): Promise<number> {
  // Окно режется по месяцам (неделя на стыке): у каждого месяца свои счета поставщиков ИИ и свои
  // строки месяца. Строку месяца удалили — по этому источнику дневной расход не считаем: «Финансы»
  // её не видят, а ручной счёт с днём оплаты уже лежит в выборке «Пульса» (ревью 17.11: иначе
  // реклама считалась дважды).
  let total = 0;
  let cursor = from;
  while (cursor < to) {
    const month = monthKey(cursor);
    const range = dushanbeMonthRange(month);
    const segEnd = range.to < to ? range.to : to;
    total += await monthSegmentAutoSpendTjs(month, cursor, segEnd, money);
    cursor = segEnd;
  }
  return total;
}

async function monthSegmentAutoSpendTjs(month: string, from: Date, to: Date, money: Awaited<ReturnType<typeof loadMoneyContext>>): Promise<number> {
  const monthDate = new Date(`${month}-01T00:00:00.000Z`);
  const dayFrom = new Date(`${dushanbeDateString(from)}T00:00:00.000Z`);
  const dayTo = new Date(`${dushanbeDateString(to)}T00:00:00.000Z`);
  const autoRows = await prisma.expense.findMany({
    where: { month: monthDate, OR: [{ autoKey: { startsWith: "ads:" } }, { autoKey: { startsWith: "ai:" } }] },
    select: { autoKey: true, deletedAt: true },
  });
  // Только удалённая строка снимает источник (значит, есть другой счёт); ручная правка суммы — нет:
  // иначе «Пульс» за неделю снова показывал бы 0 при настоящем расходе (повторное ревью 17.11).
  const skip = (key: string) => autoRows.some((r) => r.autoKey === key && r.deletedAt);
  const platforms = SYNCED_AD_PLATFORMS.filter((p) => !skip(`ads:${p}:${month}`));
  const [ads, ai, bills] = await Promise.all([
    platforms.length ? prisma.adSpendDaily.findMany({
      where: { date: { gte: dayFrom, lt: dayTo }, ad: { excluded: false, platform: { in: [...platforms] } } },
      select: { spend: true, currency: true },
      take: 50_000,
    }) : Promise.resolve([]),
    skip(`ai:${month}`) ? Promise.resolve([]) : prisma.aiLog.groupBy({ by: ["provider", "model"], where: { createdAt: { gte: from, lt: to }, costUsd: { not: null } }, _sum: { costUsd: true } }),
    prisma.expense.findMany({
      where: { month: monthDate, deletedAt: null, status: "PAID", coversAiUsage: true, vendor: { in: [...AI_ESTIMATE_VENDORS] } },
      select: { vendor: true }, distinct: ["vendor"],
    }),
  ]);
  const split = splitAiEstimate(ai.map((g) => ({ provider: g.provider, model: g.model, costUsd: g._sum.costUsd })), bills.flatMap((b) => (b.vendor ? [b.vendor] : [])));
  return fromCents(adSpendToTjsCents(ads, money) + centsToTjs(split.countedCents, "USD", money));
}

export async function buildFinancePulse(): Promise<PulseBucket[]> {
  const money = await loadMoneyContext();
  const earliest = bounds("year").prevFrom;
  // Проценты деления комиссии — ими считается доля компании у СТАРЫХ сделок,
  // закрытых до появления снапшота долей (см. sumIncome ниже). Доли — 1% агенту и
  // 1% компании (shared/commissionShares.ts, владелец 25.11.2026); приёма 0,5% нет.
  const pRealtor = COMMISSION_REALTOR_PERCENT;
  const pCompany = COMMISSION_COMPANY_PERCENT;

  // Две выборки на всё: расходы и закрытые сделки от начала прошлого года.
  // Дальше режем по периодам в памяти — строк за два года сотни, не миллионы.
  const [expenses, deals] = await Promise.all([
    prisma.expense.findMany({
      // По createdAt ИЛИ по месяцу учёта: строка «зарплата декабря», заведённая
      // 1 января, нужна и январскому окну выборки, и декабрьскому срезу.
      where: { deletedAt: null,status:"PAID", OR: [{ paymentDate:{gte:earliest} },{ createdAt: { gte: earliest } }, { month: { gte: earliest } }] },
      select: { amount: true, currency: true, createdAt: true, month: true, autoKey: true,paymentDate:true,exchangeRate:true },
      take: 20_000,
    }),
    prisma.deal.findMany({
      where: { stage: "COMPLETED", closedAt: { gte: earliest } },
      select: { commissionCompanyAmount: true, commissionAmount: true, currency: true, closedAt: true },
    }),
  ]);

  // Реклама и ИИ за день и неделю — по дневным источникам (четыре окна, четыре выборки).
  const daily = new Map<string, number>();
  for (const period of ["today", "week"] as const) {
    const b = bounds(period);
    daily.set(`${period}:cur`, await dailyAutoSpendTjs(b.from, b.to, money));
    daily.set(`${period}:prev`, await dailyAutoSpendTjs(b.prevFrom, b.prevTo, money));
  }

  return PERIODS.map((period) => {
    const { from, to, prevFrom, prevTo, label } = bounds(period);

    /**
     * К КАКОЙ ДАТЕ ОТНОСИТСЯ РАСХОД (уточнено 27.08.2026, аудит №4).
     *
     * Раньше всегда брался createdAt — «для месяца и года разницы нет». Разница
     * есть, и большая: авто-строки заводятся ПЕРВОГО ЧИСЛА за ПРОШЛЫЙ месяц.
     * Зарплата июля (createdAt=август, month=июль) падала в августовский расход,
     * и «Пульс» расходился со «Сводкой» на всю зарплату — владелец видел два
     * разных числа за один месяц на соседних экранах.
     *
     * Теперь: у месячных и годовых срезов расход относится к МЕСЯЦУ УЧЁТА
     * (month) — по нему же считает сводка; у дневного и недельного месяц-ярлык
     * бесполезен (все строки месяца легли бы в один день), там остаётся
     * createdAt.
     */
    const byAccountingMonth = period === "month" || period === "year";
    const dateOf = (e: { createdAt: Date; month: Date;paymentDate?:Date|null }) => (byAccountingMonth ? e.month : e.paymentDate ?? e.createdAt);
    // Авто-строки «Зарплата из сделок» в расход не идут: приход здесь — уже
    // доля компании, без доли риелтора, и вычитать её второй раз значило 1-го
    // числа писать на пульте «Заработали сегодня −<вся зарплата>» (C2,
    // lib/companyProfit.ts — то же правило, что в «Финансах»).
    const sumExpenses = (a: Date, b: Date) =>
      expenses
        .filter((e) => !isDealSalaryExpense(e) && (byAccountingMonth || !isMonthlyAutoRow(e)) && dateOf(e) >= a && dateOf(e) < b)
        .reduce((acc, e) => acc + fromCents(expenseCentsToTjs(e, money)), 0);
    const autoDaily = (which: "cur" | "prev") => (byAccountingMonth ? 0 : daily.get(`${period}:${which}`) ?? 0);

    /**
     * ПРИХОД — ЭТО ДОЛЯ КОМПАНИИ, А НЕ ВСЯ КОМИССИЯ.
     *
     * У сделок со снапшотом так и было. А у старых, закрытых до появления
     * снапшота долей, в приход шла ВСЯ комиссия клиента — вместе с деньгами
     * агентов, которые компании не принадлежат. На одном экране получалось
     * «Приход 1 200 с.» и рядом «Доход компании 470 с.», и объяснить разницу
     * было нечем (найдено 03.09.2026 при сверке денег). Теперь у таких сделок
     * доля компании считается по процентам из Настроек — тем же делением, что в
     * «Финансах» и в отчётах.
     */
    const companyShareOf = (d: (typeof deals)[number]) => {
      if (d.commissionCompanyAmount !== null) return toTjs(d.commissionCompanyAmount, d.currency, money);
      const baseCents = toCents(toTjs(d.commissionAmount ?? 0, d.currency, money));
      return fromCents(splitCents(baseCents, [pRealtor, pCompany])[1]);
    };

    const sumIncome = (a: Date, b: Date) =>
      deals.filter((d) => d.closedAt && d.closedAt >= a && d.closedAt < b).reduce((acc, d) => acc + companyShareOf(d), 0);

    // Было Math.round до целых сомони: пульс расходился с разделом «Финансы»
    // на копейки, и объяснить разницу было нечем.
    const incomeTjs = roundMoney(sumIncome(from, to));
    const expenseTjs = roundMoney(sumExpenses(from, to) + autoDaily("cur"));
    const previousIncomeTjs = roundMoney(sumIncome(prevFrom, prevTo));
    const previousExpenseTjs = roundMoney(sumExpenses(prevFrom, prevTo) + autoDaily("prev"));

    return {
      period,
      label,
      incomeTjs,
      expenseTjs,
      balanceTjs: roundMoney(incomeTjs - expenseTjs),
      previousIncomeTjs,
      previousExpenseTjs,
      previousBalanceTjs: roundMoney(previousIncomeTjs - previousExpenseTjs),
    };
  });
}
