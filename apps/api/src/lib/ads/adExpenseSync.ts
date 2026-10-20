import type { AdPlatform, ClientSource } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { describeError } from "../describeError.js";
import { centsToTjs, fromCents, loadMoneyContext, toCents } from "../money.js";
import { dushanbeWallClock } from "../dushanbeTime.js";
import { logSystemError } from "../systemError.js";

/**
 * РЕКЛАМА И ИИ САМИ ПОПАДАЮТ В «ФИНАНСЫ → РАСХОДЫ».
 *
 * До этого расходы на рекламу вводились руками раз в месяц (Expense, категория
 * ADVERTISING) — и с появлением синхронизации кабинета возникла развилка: либо
 * бухгалтер продолжает вводить сумму вручную (и она расходится с кабинетом), либо
 * не вводит вовсе (и «Финансы» врут, а стоимость лида считается без рекламы).
 * Решение владельца 20.08.2026 — «всё должно стекаться в Расходы» — закрывает
 * развилку: строку ведёт сама CRM.
 *
 * КАК НЕ ПОДРАТЬСЯ С ЧЕЛОВЕКОМ. Автоматическая строка помечена ключом
 * (Expense.autoKey) и идемпотентна: сверка обновляет ЕЁ, а не заводит новую.
 * Строки без ключа — человеческие, автоматика их не видит в принципе. Удалённую
 * автоматическую строку (deletedAt) пересчёт не воскрешает: «этой строки быть не
 * должно» — решение человека, и оно сильнее.
 *
 * ВАЛЮТА. Сумма хранится как отдаёт источник (кабинет Meta — доллары, журнал ИИ —
 * доллары): пересчёт в сомони делают сами «Финансы» через lib/money.ts по единому
 * курсу CRM, как и для всех остальных денег.
 */

/** Расход какой рекламной системы к какому источнику лидов относится: по source
 *  Финансы считают стоимость лида. Реклама Meta крутится в Instagram — туда же. */
const PLATFORM_SOURCE: Record<AdPlatform, ClientSource | null> = {
  META: "INSTAGRAM",
  GOOGLE: "GOOGLE_ADS",
  YANDEX: "YANDEX_DIRECT",
  TIKTOK: "TIKTOK",
  MANUAL: null,
};

const PLATFORM_LABEL: Record<AdPlatform, string> = {
  META: "Meta (Instagram/Facebook)",
  GOOGLE: "Google Ads",
  YANDEX: "Яндекс Директ",
  TIKTOK: "TikTok",
  MANUAL: "прочие площадки",
};

/**
 * Системы, из которых расход РЕАЛЬНО приходит синхронизацией. Сейчас одна — Meta.
 *
 * Google Ads и Яндекс Директ уже есть в справочнике платформ (владелец 20.08.2026:
 * «скоро добавим»), но перечислять их здесь заранее нельзя: каждая сверка делала бы
 * лишние запросы к базе за расходом, которого нет. Появится синхронизатор — сюда
 * добавляется одна строка, всё остальное (своя строка в Финансах, свой источник
 * лидов, своя стоимость лида) заработает само.
 */
const SYNCED_PLATFORMS: AdPlatform[] = ["META"];

/** «2026-08» → первый день месяца (UTC) — так месяц хранит Expense (см. routes/expenses.ts). */
function monthToDate(month: string): Date {
  return new Date(`${month}-01T00:00:00.000Z`);
}

/** Месяцы, которых касаются последние N дней по Душанбе, — обычно один, на стыке два. */
export function recentMonths(days: number): string[] {
  const out = new Set<string>();
  for (let i = 0; i < days; i++) {
    const wall = dushanbeWallClock();
    wall.setUTCDate(wall.getUTCDate() - i);
    out.add(`${wall.getUTCFullYear()}-${String(wall.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return Array.from(out);
}

/**
 * Строки «реклама за месяц» по каждой системе. Вызывается в конце каждой сверки
 * кабинета — сумма в Финансах не отстаёт от отчёта по объектам больше чем на час.
 */
export async function upsertAdExpenses(months: string[]): Promise<number> {
  let touched = 0;
  for (const month of months) {
    const from = monthToDate(month);
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0));

    // По каждой системе — своя строка: смешивать Meta и Google в одной «рекламе»
    // значит потерять ответ на вопрос «какая площадка сколько съела».
    for (const platform of SYNCED_PLATFORMS) {
      const byCurrency = await prisma.adSpendDaily.groupBy({
        by: ["currency"],
        where: { date: { gte: from, lte: to }, ad: { excluded: false, platform } },
        _sum: { spend: true },
      });

      /**
       * ВАЛЮТЫ НЕ СКЛАДЫВАЮТСЯ. Раньше здесь суммы всех валют складывались одна
       * к одной, а получившемуся числу приписывалась валюта ПЕРВОЙ строки: у
       * агентства с долларовым и сомонёвым кабинетами расход в Финансах
       * оказывался завышен в разы, и стоимость лида — вместе с ним.
       *
       * Пока валюта одна (сегодня это доллар) — пишем как есть, до цента.
       * Разошлись — приводим всё к сомони по курсу CRM: отчётная валюта одна на
       * всю компанию, и лучше честный пересчёт, чем сложение разного.
       */
      const currencies = byCurrency.filter((r) => toCents(r._sum.spend ?? 0) !== 0);
      const single = currencies.length <= 1 ? currencies[0]?.currency ?? "USD" : null;
      let spend: number;
      let currency: string;
      if (single) {
        spend = fromCents(toCents(currencies[0]?._sum.spend ?? 0));
        currency = single;
      } else {
        const money = await loadMoneyContext();
        spend = fromCents(currencies.reduce((acc, r) => acc + centsToTjs(toCents(r._sum.spend ?? 0), r.currency, money), 0));
        currency = "TJS";
      }

      const changed = await upsertAutoExpense({
        autoKey: `ads:${platform}:${month}`,
        month: from,
        amount: spend,
        currency,
        category: "ADVERTISING",
        source: PLATFORM_SOURCE[platform],
        note: `Реклама ${PLATFORM_LABEL[platform]} — автоматически из рекламного кабинета. Сумма обновляется при каждой сверке; править её вручную не нужно.`,
      });
      if (changed) touched++;
    }
  }
  return touched;
}

/**
 * Строка «расходы на ИИ за месяц» — из журнала обращений (AiLog.costUsd ведётся
 * по каждому вызову). Вызывается суточным кроном.
 */
export async function upsertAiExpenses(months: string[]): Promise<number> {
  let touched = 0;
  for (const month of months) {
    const from = monthToDate(month);
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));

    const sum = await prisma.aiLog.aggregate({
      where: { createdAt: { gte: from, lt: to }, costUsd: { not: null } },
      _sum: { costUsd: true },
    });
    // Расход на ИИ приходит долями цента (costUsd за один вызов), поэтому
    // округляем один раз на месяц, а не на каждом слагаемом.
    const spend = fromCents(toCents(sum._sum.costUsd ?? 0));
    const changed = await upsertAutoExpense({
      autoKey: `ai:${month}`,
      month: from,
      amount: spend,
      currency: "USD",
      category: "OTHER",
      source: null,
      note: `Искусственный интеллект (Claude, Gemini) — автоматически из журнала обращений. Сумма обновляется раз в сутки.`,
    });
    if (changed) touched++;
  }
  return touched;
}

async function upsertAutoExpense(row: {
  autoKey: string;
  month: Date;
  amount: number;
  currency: string;
  category: "ADVERTISING" | "OTHER";
  source: ClientSource | null;
  note: string;
}): Promise<boolean> {
  try {
    const existing = await prisma.expense.findUnique({
      where: { autoKey: row.autoKey },
      select: { id: true, deletedAt: true, amount: true, currency: true },
    });

    // Человек удалил строку — не воскрешаем и не трогаем.
    if (existing?.deletedAt) return false;

    // Нулевой расход не заводим: пустая строка «0 с.» в Финансах — шум. Но если
    // строка уже есть (расход был, потом Meta пересчитала в ноль) — обновляем.
    if (!existing && row.amount <= 0) return false;

    if (existing) {
      // Сравнение целыми сотыми: 341.6 и 341.60 — одна и та же сумма, и
      // переписывать строку (а с ней и «изменено») из-за двоичного хвоста нельзя.
      // Сумма и валюта идут парой (04.10.2026): месяц, заведённый как 10 USD, после
      // появления сомонёвого кабинета пересчитывается в 120 TJS, и сумма без новой
      // валюты превращала сомони в доллары (в Финансах в десять раз больше).
      const currency = row.currency === "TJS" ? "TJS" : "USD";
      if (toCents(existing.amount) === toCents(row.amount) && existing.currency === currency) return false;
      await prisma.expense.update({ where: { id: existing.id }, data: { amount: row.amount, currency } });
      return true;
    }
    await prisma.expense.create({
      data: {
        autoKey: row.autoKey,
        month: row.month,
        amount: row.amount,
        currency: row.currency === "TJS" ? "TJS" : "USD",
        category: row.category,
        source: row.source,
        note: row.note,
      },
    });
    return true;
  } catch (err) {
    void logSystemError("ads", `Автоматическая строка расхода ${row.autoKey} не записана: ${describeError(err)}`);
    return false;
  }
}
