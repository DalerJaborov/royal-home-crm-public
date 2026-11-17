import type { AdPlatform, ClientSource } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { describeError } from "../describeError.js";
import { centsToTjs, fromCents, loadMoneyContext, toCents } from "../money.js";
import { dushanbeMonthRange, dushanbeWallClock } from "../dushanbeTime.js";
import { logSystemError } from "../systemError.js";
import { warnManualOverlapsForAuto } from "../expenseAutoOverlap.js";
import { AI_ESTIMATE_VENDORS, aiEstimateNote, splitAiEstimate } from "@royal-home/shared";

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
 * Строка «расходы на ИИ за месяц» — ОЦЕНКА из журнала обращений (AiLog.costUsd ведётся по
 * каждому вызову по прайсу). Вызывается суточным кроном и сразу после записи счёта поставщика ИИ.
 *
 * Счёт поставщика сильнее оценки (17.11.2026, splitAiEstimate в packages/shared): если за месяц
 * есть настоящий счёт или подписка Gemini (Expense.vendor), обращения к Gemini в оценку не идут —
 * иначе Gemini учтён дважды (октябрь 2026: оценка ≈ 33 $ и «ОПЛАТА ИИ» 2 000 с.).
 */
export async function upsertAiExpenses(months: string[]): Promise<number> {
  let touched = 0;
  for (const month of months) {
    const from = monthToDate(month);
    // Обращения месяца — по Душанбе (аудит денег 17.11): по UTC последние 5 часов месяца уходили в
    // следующий, а после 1-го числа прошлый месяц не пересчитывается — хвост терялся навсегда.
    const range = dushanbeMonthRange(month);

    const [groups, bills] = await Promise.all([
      prisma.aiLog.groupBy({
        by: ["provider", "model"],
        where: { createdAt: { gte: range.from, lt: range.to }, costUsd: { not: null } },
        _sum: { costUsd: true },
      }),
      // Настоящие счета и подписки поставщиков ИИ за месяц: ручные и из шаблонов, не в корзине.
      // У самой строки оценки ai:<месяц> поставщика нет — она сюда не попадает. Фильтр по autoKey
      // здесь нельзя: NOT по пустому autoKey в SQL даёт «неизвестно» и прячет ручные счета.
      prisma.expense.findMany({
        // Только оплаченный счёт за ИИ самой CRM (ревью 17.11): план и подписка на чат оценку не снимают.
        where: { month: from, deletedAt: null, status: "PAID", coversAiUsage: true, vendor: { in: [...AI_ESTIMATE_VENDORS] } },
        select: { vendor: true },
        distinct: ["vendor"],
      }),
    ]);
    const split = splitAiEstimate(
      groups.map((g) => ({ provider: g.provider, model: g.model, costUsd: g._sum.costUsd })),
      bills.flatMap((b) => (b.vendor ? [b.vendor] : [])),
    );
    // Расход на ИИ приходит долями цента (costUsd за один вызов), поэтому
    // округляем один раз на месяц, а не на каждом слагаемом.
    const spend = fromCents(split.countedCents);
    const changed = await upsertAutoExpense({
      autoKey: `ai:${month}`,
      month: from,
      amount: spend,
      currency: "USD",
      category: "OTHER",
      source: null,
      note: aiEstimateNote(split),
    });
    if (changed) touched++;
  }
  return touched;
}

/** Сумма для записи в базу — ровно два знака строкой (аудит денег 17.11: в базе 76.65000000000001). */
const moneyString = (amount: number) => (toCents(amount) / 100).toFixed(2);

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
      select: { id: true, deletedAt: true, amount: true, currency: true, note: true, manualEditedAt: true },
    });

    // Человек удалил строку — не воскрешаем и не трогаем. Человек поправил сумму — тоже (аудит №4:
    // ночной пересчёт откатывал правку директора; найдено ревью 17.11 рядом). Расхождение ручной
    // суммы с источником — в журнал ошибок раз в неделю: директор видит, что кабинет насчитал другое.
    if (existing?.deletedAt) return false;
    if (existing?.manualEditedAt) {
      if (toCents(existing.amount) !== toCents(row.amount)) {
        void logSystemError("ads", `Строка ${row.autoKey} правлена вручную: по источнику ${fromCents(toCents(row.amount))} ${row.currency}, в строке оставлена ручная сумма ${Number(existing.amount)} ${existing.currency}`, {
          dedupKey: `auto-vs-manual:${row.autoKey}`, dedupWindowMs: 7 * 86_400_000,
        });
      }
      return false;
    }

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
      // Текст строки ИИ говорит, какой поставщик не посчитан (счёт есть) — обновляется вместе с суммой.
      const noteChanged = row.autoKey.startsWith("ai:") && existing.note !== row.note;
      if (toCents(existing.amount) === toCents(row.amount) && existing.currency === currency && !noteChanged) return false;
      await prisma.expense.update({ where: { id: existing.id }, data: { amount: moneyString(row.amount), currency, ...(noteChanged ? { note: row.note } : {}) } });
      return true;
    }
    await prisma.expense.create({
      data: {
        autoKey: row.autoKey,
        month: row.month,
        amount: moneyString(row.amount),
        currency: row.currency === "TJS" ? "TJS" : "USD",
        category: row.category,
        source: row.source,
        note: row.note,
      },
    });
    // Обратная сторона правила «расход дважды» (14.11.2026): ручная строка того же вида за этот
    // месяц уже была — тревога директору, какую из двух убрать, решает человек.
    await warnManualOverlapsForAuto(row.autoKey, row.month.toISOString().slice(0, 7));
    return true;
  } catch (err) {
    void logSystemError("ads", `Автоматическая строка расхода ${row.autoKey} не записана: ${describeError(err)}`);
    return false;
  }
}
