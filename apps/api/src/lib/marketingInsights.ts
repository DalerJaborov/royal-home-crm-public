import { callAiText } from "../ai/client.js";
import { prisma } from "../db.js";
import { describeError } from "./describeError.js";
import { logSystemError } from "./systemError.js";
import { buildMarketingFunnel, type MarketingFunnelResult } from "./marketingFunnel.js";
import { countStuckConversationsByChannel } from "./stuckConversations.js";
import { CLIENT_SOURCE_LABELS, REFUSAL_REASON_LABELS, type RefusalReason } from "@royal-home/shared";
import { sendPushToAgents } from "../push.js";
import { findAgentsWithPermission } from "./recipients.js";
import { dushanbeWallClock } from "./dushanbeTime.js";
import { createNotifications } from "./notifications.js";

/**
 * ИИ-РАЗБОР МАРКЕТИНГА — «один экран маркетолога» (01.09.2026), тот же приём,
 * что уже год работает в lib/ads/adInsights.ts: читает готовые цифры (никаких
 * новых данных, никакого доступа к переписке целиком), отдаёт короткий текст
 * по-русски. Источники — три уже существующих на этом экране среза (воронка по
 * каналам, потери по каналам, диалоги, ждущие ответа) плюс дословные возражения
 * клиентов из CallAnalysis (свежие, месяц) — их НЕЛЬЗЯ агрегировать SQL-группировкой
 * (это произвольный текст, не категория), а модель может их прочитать и сама
 * выделить общие темы.
 *
 * КЭШ В ПАМЯТИ ПРОЦЕССА, БЕЗ НОВОГО ТУМБЛЕРА В НАСТРОЙКАХ — тот же выбор, что и
 * у соседнего /ads/insights: это не открытый диалог с моделью (как ИИ-ассистент,
 * у которого свой aiAssistantEnabled из-за произвольного доступа к данным CRM по
 * любому вопросу), а фиксированный разбор по заранее собранному отчёту — риск и
 * цена вызова тот же, что и у уже одобренной фичи, отдельного рубильника не
 * требует. Гейт — reports.view роутера, под которым живёт весь экран.
 */

const CACHE_MS = 6 * 60 * 60 * 1000;
const OBJECTIONS_LOOKBACK_DAYS = 30;
const OBJECTIONS_SAMPLE = 60;

interface CachedInsight {
  text: string;
  builtAt: number;
  month: string;
}

/**
 * ДВА КЭША, А НЕ ОДИН (ночная проверка 24.09.2026, круг «Сделки, деньги», №5).
 * seesMoney (право finance.view) идёт и в воронку, и в промпт: с деньгами в
 * тексте расход по каналам и цена лида, без — только счётчики. Ключ был лишь
 * по месяцу, и текст с суммами, построенный для директора, шесть часов
 * отдавался тем, у кого права на деньги нет (и наоборот — директор получал
 * разбор без денег). Теперь у каждого варианта свой кэш.
 */
type CacheKey = "money" | "plain";
const cache: Record<CacheKey, CachedInsight | null> = { money: null, plain: null };

export interface MarketingInsightsResult {
  text: string;
  builtAt: string;
  cached: boolean;
}

async function loadRecentObjections(): Promise<string[]> {
  const since = new Date(Date.now() - OBJECTIONS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.callAnalysis.findMany({
    where: { interaction: { createdAt: { gte: since } } },
    orderBy: { interaction: { createdAt: "desc" } },
    take: OBJECTIONS_SAMPLE,
    select: { objections: true },
  });
  return rows.flatMap((r) => r.objections).filter((o) => o.trim().length > 0);
}

function summarizeFunnel(funnel: MarketingFunnelResult): string {
  return funnel.channels
    .map((c) => {
      const money = c.spendMonthTjs != null ? `, расход ${Math.round(c.spendMonthTjs)} с., цена лида ${c.costPerLeadTjs ?? "—"} с.` : "";
      const anomaly = c.anomalyLeadsDown ? " [СЕГОДНЯ ЗАМЕТНЫЙ СПАД]" : "";
      return `${c.label}: лидов за месяц ${c.leadsMonth}, показов ${c.showingsMonth}, сделок ${c.dealsClosedMonth}${money}${anomaly}`;
    })
    .join("\n");
}

function summarizeLost(rows: { label: string; lost: number; totalLeads: number; lostShare: number | null; topReason: string | null }[]): string {
  if (rows.length === 0) return "За 90 дней потерянных клиентов не было ни по одному каналу.";
  return rows
    .map(
      (r) =>
        `${r.label}: потеряно ${r.lost} из ${r.totalLeads} лидов${r.lostShare != null ? ` (${r.lostShare}%)` : ""}` +
        (r.topReason ? `, чаще всего: ${r.topReason}` : "")
    )
    .join("\n");
}

async function summarizeWaiting(): Promise<string> {
  // Подсчёт, а не длина выборки на 200 строк (02.10.2026) — то же число, что
  // на плитке «Сейчас ждут ответа» (/reports/waiting-now).
  const counts = await countStuckConversationsByChannel();
  const total = counts.reduce((sum, c) => sum + c.count, 0);
  if (total === 0) return "Сейчас нет диалогов, ждущих ответа.";
  const lines = counts
    .map((c) => `${CLIENT_SOURCE_LABELS[c.channel as keyof typeof CLIENT_SOURCE_LABELS] ?? c.channel}: ${c.count}`)
    .join(", ");
  return `Сейчас ждут ответа ${total} диалогов: ${lines}.`;
}

export async function buildMarketingInsights(seesMoney: boolean, force = false): Promise<MarketingInsightsResult | null> {
  // Месяц ключа кэша — ПО ДУШАНБЕ: сама воронка (buildMarketingFunnel) считает
  // месяц через dushanbeStartOfMonth, а ключ шёл по UTC. В окно 00:00-05:00
  // первого числа ключ был ещё старый при уже новых данных, и отдавался кэш
  // прошлого месяца до истечения CACHE_MS.
  const month = dushanbeWallClock().toISOString().slice(0, 7);
  const cacheKey: CacheKey = seesMoney ? "money" : "plain";
  const hit = cache[cacheKey];
  if (!force && hit && hit.month === month && Date.now() - hit.builtAt < CACHE_MS) {
    return { text: hit.text, builtAt: new Date(hit.builtAt).toISOString(), cached: true };
  }

  const [funnel, lostRaw, waitingSummary, objections] = await Promise.all([
    buildMarketingFunnel(seesMoney, new Date()),
    prisma.$transaction(async (tx) => {
      const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const [lostRows, totalRows] = await Promise.all([
        tx.client.groupBy({
          by: ["source", "refusalReason"],
          where: { status: "LOST", deletedAt: null, escalatedAt: { gte: since } },
          _count: { _all: true },
        }),
        tx.client.groupBy({
          by: ["source"],
          where: { deletedAt: null, createdAt: { gte: since } },
          _count: { _all: true },
        }),
      ]);
      const totalBySource = new Map<string, number>(totalRows.map((r) => [r.source as string, r._count._all]));
      const bySource = new Map<string, { lost: number; reasons: Map<string, number> }>();
      for (const row of lostRows) {
        const entry = bySource.get(row.source) ?? { lost: 0, reasons: new Map<string, number>() };
        entry.lost += row._count._all;
        if (row.refusalReason) entry.reasons.set(row.refusalReason, (entry.reasons.get(row.refusalReason) ?? 0) + row._count._all);
        bySource.set(row.source, entry);
      }
      return [...bySource.entries()].map(([source, entry]) => {
        const topReason = [...entry.reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        const totalLeads = totalBySource.get(source) ?? 0;
        return {
          label: CLIENT_SOURCE_LABELS[source as keyof typeof CLIENT_SOURCE_LABELS] ?? source,
          lost: entry.lost,
          totalLeads,
          lostShare: totalLeads > 0 ? Math.round((entry.lost / totalLeads) * 100) : null,
          topReason: topReason ? (REFUSAL_REASON_LABELS[topReason as RefusalReason] ?? topReason) : null,
        };
      });
    }),
    summarizeWaiting(),
    loadRecentObjections(),
  ]);

  if (funnel.channels.length === 0) return null;

  const summary =
    `ВОРОНКА ПО КАНАЛАМ (текущий месяц):\n${summarizeFunnel(funnel)}\n\n` +
    `ПОТЕРИ ПО КАНАЛАМ (90 дней):\n${summarizeLost(lostRaw)}\n\n` +
    `${waitingSummary}\n\n` +
    (objections.length > 0
      ? `ВОЗРАЖЕНИЯ КЛИЕНТОВ ЗА ${OBJECTIONS_LOOKBACK_DAYS} ДНЕЙ (дословно, из разборов звонков, до ${OBJECTIONS_SAMPLE} шт.):\n${objections.map((o) => `— ${o}`).join("\n")}`
      : "Возражений за период не разобрано.");

  try {
    const data = await callAiText<{ headline: string; insights: string[] }>({
      endpoint: "marketing-insights",
      system:
        "Ты маркетинговый директор агентства недвижимости Royal Home в Душанбе. Тебе присылают уже готовый срез " +
        "цифр за период — воронку по каналам, где теряют клиентов, где сейчас копится очередь без ответа, и " +
        "дословные возражения клиентов из разговоров. Твоя работа — увидеть связь между этими кусками, которую " +
        "человек не увидит, глядя на каждый отдельно (например: канал даёт много лидов, но именно на нём больше " +
        "всего потерь с одной и той же причиной — значит дело не в канале, а в том, как его обрабатывают).\n\n" +
        "Ответь:\n" +
        "1) headline — одна фраза, самое важное за период, что нужно увидеть в первую секунду;\n" +
        "2) insights — 3-5 конкретных наблюдений и что с ними делать, каждое — отдельная строка, без нумерации " +
        "внутри строки. Свяжи разные срезы между собой, если видишь связь; если данных мало для вывода — так и " +
        "скажи прямо, не дотягивай до вывода искусственно.\n\n" +
        "Правила: по-русски, простыми словами, без англицизмов и общих фраз вроде «усильте присутствие в соцсетях». " +
        "Числа только те, что даны — не выдумывай и не досчитывай. " +
        'Ответ строго JSON: {"headline": "...", "insights": ["...", "..."]}.\n\nДанные:\n' +
        summary,
      user: "Сделай разбор.",
      maxTokens: 1200,
    });
    if (!data?.headline || !data.insights?.length) return null;
    const text = JSON.stringify(data);
    cache[cacheKey] = { text, builtAt: Date.now(), month };
    return { text, builtAt: new Date().toISOString(), cached: false };
  } catch (err) {
    void logSystemError("ai", `ИИ-разбор маркетинга не построен: ${describeError(err)}`);
    return null;
  }
}

/** Прогрев не нужен: разбор строится по первому запросу. Экспорт для тестов. */
export function _clearMarketingInsightsCache(): void {
  cache.money = null;
  cache.plain = null;
}

/**
 * ПУШ, А НЕ ТОЛЬКО ЭКРАН (05.09.2026, docs/ai-proactivity-audit-05-09-2026.md п.1).
 *
 * До этой правки разбор строился ТОЛЬКО когда кто-то сам открывал экран отчётов —
 * единственный из соседних ИИ-разборов (insightDigest, problemReport) без кром-пуша.
 * Раз в неделю сам присылает заголовок тем, у кого есть право видеть отчёты, —
 * не нужно вспоминать зайти и посмотреть.
 *
 * seesMoney=false НАРОЧНО: получатели — все с правом reports.view, а деньги видит
 * не каждый из них (отдельный гейт seesMoney, как в dashboardMissionControl.ts).
 * Пуш даёт безопасный для всех текст; у кого есть право на суммы — увидит их,
 * открыв сам экран, где право проверяется заново.
 *
 * Дедуп — по ISO-неделе Душанбе в tag, тот же приём, что у lib/buyerNoCallAlarm.ts:
 * повторный тик той же недели не шлёт второй пуш, только обновляет счётчик записи.
 */
function dushanbeIsoWeekKey(): string {
  const wall = dushanbeWallClock();
  const d = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-w${week}`;
}

export async function notifyReportsAboutMarketingInsights(): Promise<void> {
  const built = await buildMarketingInsights(false, true);
  if (!built) return;

  const recipients = await findAgentsWithPermission("reports.view");
  if (recipients.length === 0) return;

  let headline: string;
  try {
    headline = (JSON.parse(built.text) as { headline: string }).headline;
  } catch {
    return;
  }
  if (!headline) return;

  const payload = {
    kind: "oversight" as const,
    tag: `marketing-insights-${dushanbeIsoWeekKey()}`,
    title: "📈 Разбор маркетинга готов",
    body: headline,
    url: "/reports",
  };
  // Лента — AWAIT (тот же приём, что в lib/buyerNoCallAlarm.ts): sendPushToAgents
  // внутри пишет её через void createNotifications (fire-and-forget), и без
  // отдельного await запись не гарантированно завершается к моменту возврата —
  // ни для теста, проверяющего Notification сразу после вызова, ни для колокольчика
  // в шапке, который должен наполниться независимо от того, дошёл ли сам push.
  await createNotifications(recipients, payload);
  // Push отдельно — он эфемерен и не должен блокировать возврат результата.
  void sendPushToAgents(recipients, payload).catch((err) =>
    console.error("[marketing-insights] push:", err)
  );
}
