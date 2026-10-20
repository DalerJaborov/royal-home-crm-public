import { prisma } from "../db.js";
import { DUSHANBE_OFFSET_MS, dushanbeWallClock } from "./dushanbeTime.js";
import { isDealSalaryExpense } from "./companyProfit.js";
import { fromCents, loadMoneyContext, roundMoney, splitCents, toCents, toTjs } from "./money.js";
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
export async function buildFinancePulse(): Promise<PulseBucket[]> {
  const money = await loadMoneyContext();
  const earliest = bounds("year").prevFrom;
  // Проценты деления комиссии — ими считается доля компании у СТАРЫХ сделок,
  // закрытых до появления снапшота долей (см. sumIncome ниже). 0,5% «за приём
  // объекта» отменены 11.09.2026: Settings.commissionIntakePercent остаётся в
  // схеме как история, но доля, которую оно отводило, теперь всегда прибавляется
  // к доле компании.
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { commissionIntakePercent: true, commissionRealtorPercent: true, commissionCompanyPercent: true },
  });
  const pRealtor = Number(settings?.commissionRealtorPercent ?? 0.5);
  const pCompany = Number(settings?.commissionCompanyPercent ?? 1) + Number(settings?.commissionIntakePercent ?? 0.5);

  // Две выборки на всё: расходы и закрытые сделки от начала прошлого года.
  // Дальше режем по периодам в памяти — строк за два года сотни, не миллионы.
  const [expenses, deals] = await Promise.all([
    prisma.expense.findMany({
      // По createdAt ИЛИ по месяцу учёта: строка «зарплата декабря», заведённая
      // 1 января, нужна и январскому окну выборки, и декабрьскому срезу.
      where: { deletedAt: null,status:"PAID", OR: [{ paymentDate:{gte:earliest} },{ createdAt: { gte: earliest } }, { month: { gte: earliest } }] },
      select: { amount: true, currency: true, createdAt: true, month: true, autoKey: true,paymentDate:true,exchangeRate:true },
    }),
    prisma.deal.findMany({
      where: { stage: "COMPLETED", closedAt: { gte: earliest } },
      select: { commissionCompanyAmount: true, commissionAmount: true, currency: true, closedAt: true },
    }),
  ]);

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
        .filter((e) => !isDealSalaryExpense(e) && dateOf(e) >= a && dateOf(e) < b)
        .reduce((acc, e) => acc + fromCents(expenseCentsToTjs(e, money)), 0);

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
      return fromCents(splitCents(baseCents, [pCompany, pRealtor])[0]);
    };

    const sumIncome = (a: Date, b: Date) =>
      deals.filter((d) => d.closedAt && d.closedAt >= a && d.closedAt < b).reduce((acc, d) => acc + companyShareOf(d), 0);

    // Было Math.round до целых сомони: пульс расходился с разделом «Финансы»
    // на копейки, и объяснить разницу было нечем.
    const incomeTjs = roundMoney(sumIncome(from, to));
    const expenseTjs = roundMoney(sumExpenses(from, to));
    const previousIncomeTjs = roundMoney(sumIncome(prevFrom, prevTo));
    const previousExpenseTjs = roundMoney(sumExpenses(prevFrom, prevTo));

    return {
      period,
      label,
      incomeTjs,
      expenseTjs,
      balanceTjs: incomeTjs - expenseTjs,
      previousIncomeTjs,
      previousExpenseTjs,
      previousBalanceTjs: previousIncomeTjs - previousExpenseTjs,
    };
  });
}
