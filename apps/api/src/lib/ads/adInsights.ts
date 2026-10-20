import { callAiText } from "../../ai/client.js";
import { prisma } from "../../db.js";
import { describeError } from "../describeError.js";
import { logSystemError } from "../systemError.js";
import { buildAdSpendReport } from "./adSpendReport.js";
import { deliveryCounts } from "./adDelivery.js";
import { fromCents, toCents } from "../money.js";

/**
 * ИИ-РАЗБОР РЕКЛАМЫ — «что происходит с деньгами и что делать».
 *
 * Владелец смотрит на таблицу цифр; вопросы у него всегда одни: куда уходит
 * больше всего, что окупается, что жжёт бюджет впустую и что поменять. Ровно эти
 * четыре вопроса и задаём модели — по готовому отчёту, без доступа к кабинету.
 *
 * ПОСТАВЩИК — тот же, что у всей CRM (callAiText: по настройке aiTextProvider,
 * по умолчанию Gemini). Разбор не должен требовать отдельного ключа Anthropic:
 * агентство живёт на Gemini, и раздел, который работает «только если купите ещё
 * один ключ», не работает вовсе.
 *
 * КЭШ НА СУТКИ на месяц отчёта: расклад бюджета меняется медленно, а дёргать
 * модель на каждое открытие раздела — платить за одно и то же. Ручная сверка
 * кэш не сбивает; «Обновить разбор» — отдельная кнопка с force.
 */

interface CachedInsight {
  text: string;
  builtAt: number;
  month: string;
}

const CACHE_MS = 24 * 60 * 60 * 1000;
let cache: CachedInsight | null = null;

export interface AdInsightsResult {
  /** null — разбора нет; почему именно, говорит reason. */
  text: string | null;
  builtAt?: string;
  cached?: boolean;
  /** "empty" — расходов за месяц не было; "ai" — модель не ответила. */
  reason?: "empty" | "ai";
}

export async function buildAdInsights(month: string, force = false): Promise<AdInsightsResult> {
  if (!force && cache && cache.month === month && Date.now() - cache.builtAt < CACHE_MS) {
    return { text: cache.text, builtAt: new Date(cache.builtAt).toISOString(), cached: true };
  }

  const report = await buildAdSpendReport(month);
  // Разбирать нечего — это не то же самое, что «модель не ответила»: экран
  // печатал одну и ту же фразу на оба случая, и отказ ИИ читался как «рекламы в
  // этом месяце не было» (тот же класс вранья, что чинили на вкладках раздела).
  if (report.rows.length === 0) return { text: null, reason: "empty" as const };

  // Компактная выжимка — модели не нужны сырые строки, только факты.
  const lines = report.rows.slice(0, 25).map((r) => {
    const name = r.property ? `№${r.property.shortId} (${r.property.status})` : "Без объекта";
    const perConv = r.conversations > 0 ? (r.spendTjs / r.conversations).toFixed(2) : null;
    const profit = r.profitTjs != null ? `, прибыль ${r.profitTjs.toFixed(2)} с.` : "";
    const comments = r.comments != null ? `, комментариев ${r.comments}` : "";
    return (
      `${name}: потрачено ${r.spendTjs.toFixed(2)} с., показов ${r.impressions}, кликов ${r.clicks}, ` +
      `обращений ${r.conversations}${perConv != null ? ` (по ${perConv} с.)` : ""}${comments}${profit}; ` +
      `кампании: ${r.campaigns.slice(0, 2).join(", ") || "—"}`
    );
  });

  // Состояние и сроки: без них модель не отличит «остановлено месяц назад» от
  // «работает и не даёт результата», а это разные советы. Считаем по факту трат
  // (lib/ads/adDelivery.ts), а не по статусу Meta: у неё завершённое объявление
  // навсегда остаётся ACTIVE, и модель получала «идёт 33» вместо честных шести.
  const delivery = await deliveryCounts();
  const running = delivery.RUNNING;
  const stalled = delivery.STALLED;
  const idle = delivery.FINISHED + delivery.PAUSED + delivery.REVIEW + delivery.REJECTED + delivery.NEVER;
  // Реклама агентства в отчёте по объектам не видна, а деньги ест: без этой
  // строки модель считает, что весь бюджет ушёл на квартиры, и советует не то.
  const brandCount = await prisma.ad.count({ where: { excluded: false, brand: true } });

  /**
   * Объявления, не привязанные к объекту, — поимённо, а не одной строкой «Без
   * объекта». В первом же разборе модель сама сказала, чего ей не хватает: «для
   * полного анализа не хватает статистики по остальным 16 объявлениям». И была
   * права — половина бюджета агентства уходит именно туда, а отчёт по объектам
   * их не различает. Даём заголовок публикации и деньги: этого достаточно, чтобы
   * отличить рекламу услуг от квартиры, которую забыли привязать.
   */
  const loose = await prisma.ad.findMany({
    where: { excluded: false, propertyId: null, properties: { none: {} } },
    select: { caption: true, brand: true, status: true, spend: { select: { spend: true, conversations: true } } },
    take: 20,
  });
  const looseLines = loose
    .map((ad) => {
      const spend = fromCents(ad.spend.reduce((acc, s) => acc + toCents(s.spend), 0));
      const conversations = ad.spend.reduce((acc, s) => acc + s.conversations, 0);
      const title = firstMeaningfulLine(ad.caption) ?? "без подписи";
      const kind = ad.brand ? "реклама агентства" : "квартира без привязки";
      return {
        spend,
        text: `«${title}» (${kind}): ${spend.toFixed(2)} ${report.totals.currency ?? "в валюте кабинета"}, обращений ${conversations}`,
      };
    })
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10)
    .map((x) => x.text);

  const totals = report.totals;
  const summary =
    `Месяц ${month}. Всего: ${totals.spendTjs.toFixed(2)} с.` +
    // Исходная сумма есть только когда кабинет один: доллары с сомони не
    // складываются, и придумывать «общую сумму в валюте кабинета» нельзя.
    (totals.spendOriginal != null ? ` (${totals.spendOriginal.toFixed(2)} ${totals.currency})` : "") +
    `, ` +
    `показов ${totals.impressions}, кликов ${totals.clicks}, обращений ${totals.conversations}.\n` +
    `Объявлений реально тратит деньги ${running}, включено но без трат ${stalled}, остановлено или завершено ${idle}; ` +
    `из них ${brandCount} рекламируют само агентство, ` +
    `а не квартиру (их расход в строках ниже не показан).\n` +
    lines.join("\n") +
    (looseLines.length > 0 ? `\n\nОбъявления без объекта, по убыванию расхода:\n${looseLines.join("\n")}` : "");

  try {
    const data = await callAiText<{ analysis: string }>({
      endpoint: "ads-insights",
      system:
        "Ты таргетолог с опытом в недвижимости Душанбе. Клиент — агентство Royal Home: " +
        "продаёт и сдаёт квартиры и дома, реклама идёт в Instagram и Facebook, цель — переписки в Direct. " +
        "Средняя комиссия со сделки — десятки тысяч сомони, поэтому даже дорогое обращение окупается, " +
        "если приводит к показу; но деньги, потраченные без единого обращения, — чистый убыток.\n\n" +
        "Разбери данные ниже и ответь коротко, как разбирают с владельцем за чаем:\n" +
        "1) ЧТО РАБОТАЕТ: какие объекты и креативы дают обращения дешевле остальных и чем они отличаются;\n" +
        "2) ЧТО ЖЖЁТ ДЕНЬГИ: где потрачено заметно, а обращений нет или они втрое дороже средних;\n" +
        "3) ПОЧЕМУ так может быть — по цифрам, а не догадками: выгоревший креатив (много показов, мало кликов), " +
        "узкая аудитория (мало показов при живом бюджете), слабое первое касание (клики есть, переписок нет);\n" +
        "4) ЧТО СДЕЛАТЬ НА ЭТОЙ НЕДЕЛЕ: 2–3 действия — что выключить, куда перекинуть бюджет, какой пост " +
        "переснять (первый кадр, цена в подписи, номер объекта).\n\n" +
        "Правила: по-русски, простыми словами, без англицизмов и общих фраз вроде «оптимизировать креативы». " +
        "Числа округляй, суммы в сомони. Не выдумывай данных, которых нет; если чего-то не хватает для вывода — " +
        "так и скажи одной строкой. " +
        'Ответ строго JSON: {"analysis": "текст с абзацами через \\n"}.\n\nДанные:\n' +
        summary,
      user: "Сделай разбор.",
      maxTokens: 1200,
    });
    if (!data?.analysis) return { text: null, reason: "ai" as const };
    cache = { text: data.analysis, builtAt: Date.now(), month };
    return { text: data.analysis, builtAt: new Date().toISOString(), cached: false };
  } catch (err) {
    void logSystemError("ads", `ИИ-разбор рекламы не построен: ${describeError(err)}`);
    return { text: null, reason: "ai" as const };
  }
}

/** Первая содержательная строка подписи — заголовок публикации без эмодзи-шапки. */
function firstMeaningfulLine(caption: string | null): string | null {
  if (!caption) return null;
  for (const raw of caption.split(/\n+/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length >= 6 && /[a-zа-яё]/i.test(line)) return line.slice(0, 70);
  }
  return null;
}

/** Прогрев не нужен: разбор строится по первому запросу. Экспорт для тестов. */
export function _clearInsightsCache(): void {
  cache = null;
}

/** Есть ли вообще данные, по которым можно что-то разбирать. */
export async function hasAdData(): Promise<boolean> {
  return (await prisma.adSpendDaily.count({ take: 1 })) > 0;
}
