import { BOT_DAILY_SPEND_CAP_DEFAULT_USD, dushanbeDayKey } from "@royal-home/shared";
import { prisma } from "../db.js";
import { providerDayKey } from "../ai/providerContract.js";
import { automationSwitchOn } from "./automationSwitches.js";
import { dushanbeStartOfToday } from "./dushanbeTime.js";
import { logSystemError } from "./systemError.js";
import { findAgentsWithPermission } from "./recipients.js";
import { sendPushToAgents } from "../push.js";

/**
 * СУТОЧНЫЙ ДЕНЕЖНЫЙ ПОТОЛОК БОТА КЛИЕНТОВ — ОДНА ДВЕРЬ (CRM-47, 26.11.2026).
 *
 * Было (ФАКТ, код main): у бота клиентов нет потолка в деньгах. Ядро свободной модели пишет траты в
 * `AiProviderDailyBudget` с политикой `royal-customer-gemini`, но суточный предел там `null` и закреплён в
 * неизменяемой версии бота; оператор заявок и комментарии зовут модель через общую дверь `callAiText` вовсе без
 * учёта суток. Петля (07.09: ~19 000 вызовов по одной переписке; 30.10: месячный лимит Google выбран за ночь) ничем
 * не останавливалась, кроме лимита проекта Google, а он кладёт ВЕСЬ прод (звонки, Шабнам, расшифровки).
 *
 * Теперь: сумма за сутки по Душанбе = траты ядра (`AiProviderDailyBudget`, списано + резерв) + вызовы бота клиентов
 * через `callAiText` (`AiLog.costUsd` по точкам из CUSTOMER_BOT_AI_ENDPOINTS, без ядра, чтобы не считать дважды).
 * Достигла потолка из Настроек — новые вызовы этих точек модель не зовут (возвращают «нет ответа»): оператор
 * заявок отвечает своими правилами и готовыми фразами (understandFallback, шаблон вместо «своими словами»), клиент
 * без ответа не остаётся. Руководству — одна тревога в сутки. Ядро свободной модели этой дверью не останавливается
 * (его предел закреплён в версии бота, менять его можно только новой версией): оно учитывается в сумме.
 *
 * Рубильник `botDailySpendCapEnabled` (ВКЛ), сумма `botDailySpendCapUsd` (умолчание 5 $, решение владельца —
 * утром). Сбой чтения — потолка нет: учёт не имеет права сделать бота немым.
 */
export const CUSTOMER_BOT_AI_ENDPOINTS: ReadonlySet<string> = new Set([
  "lead-only-intent", "lead-only-operator-compose", "operator-showing-detect", "lead-qualify",
  "instagram-comment", "telegram-comment", "reply-worth-check",
]);
export const CUSTOMER_CORE_POLICY_KEY = "royal-customer-gemini";
export const SPEND_CAP_ALARM_CHANNEL = "customer-bot-spend-cap";

const CACHE_MS = 60_000;
let cache: { at: number; day: string; reached: boolean } | null = null;
/** Только для тестов: сбросить запомненный ответ. */
export function resetCustomerBotSpendCapCache(): void { cache = null; }

export async function customerBotSpentTodayUsd(now: Date = new Date()): Promise<number> {
  // Сутки ядра — ровно тот ключ, которым пишет его бухгалтерия (ai/providerContract.ts), иначе сумма разъедется на стыке.
  const day = providerDayKey(now);
  const [core] = await prisma.$queryRaw<Array<{ total: string | null }>>`SELECT ("settledUsd"+"reservedUsd")::text AS total
    FROM "AiProviderDailyBudget" WHERE "policyKey"=${CUSTOMER_CORE_POLICY_KEY} AND "dayKey"=${day}`;
  const logged = await prisma.aiLog.aggregate({ _sum: { costUsd: true }, where: {
    createdAt: { gte: dushanbeStartOfToday(now) }, operationId: null, endpoint: { in: [...CUSTOMER_BOT_AI_ENDPOINTS] } } });
  return Number(core?.total ?? 0) + Number(logged._sum.costUsd ?? 0);
}

/** Потолок достигнут — точку бота клиентов не зовём. Сбой — false (не немой бот). */
export async function customerBotSpendCapReached(endpoint: string, now: Date = new Date()): Promise<boolean> {
  if (!CUSTOMER_BOT_AI_ENDPOINTS.has(endpoint)) return false;
  const day = dushanbeDayKey(now);
  if (cache && cache.day === day && now.getTime() - cache.at < CACHE_MS) return cache.reached;
  try {
    if (!await automationSwitchOn("botDailySpendCapEnabled")) { cache = { at: now.getTime(), day, reached: false }; return false; }
    const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { botDailySpendCapUsd: true } });
    const cap = settings?.botDailySpendCapUsd == null ? BOT_DAILY_SPEND_CAP_DEFAULT_USD : Number(settings.botDailySpendCapUsd);
    const spent = await customerBotSpentTodayUsd(now);
    const reached = cap > 0 && spent >= cap;
    cache = { at: now.getTime(), day, reached };
    if (reached) void alarmCapReached(day, spent, cap);
    return reached;
  } catch (error) {
    void logSystemError("ai", `Потолок трат бота клиентов не проверен: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400),
      { dedupKey: "customer-bot-spend-cap-read" });
    return false;
  }
}

async function alarmCapReached(day: string, spent: number, cap: number): Promise<void> {
  const text = `Бот клиентов потратил на ИИ за сегодня ${spent.toFixed(2)} $ при потолке ${cap.toFixed(2)} $. ` +
    "До полуночи по Душанбе он отвечает готовыми фразами без ИИ, заявки заводятся как обычно. " +
    "Поднять потолок или выключить его: Настройки → Автоматика ИИ → Бот клиентов.";
  // Одна тревога на сутки на все процессы: отметка в ProcessedMessage (уникальная пара канал+id, уборка общая через 3 дня).
  const first = await prisma.processedMessage.create({ data: { channel: SPEND_CAP_ALARM_CHANNEL, messageId: day, completedAt: new Date() } })
    .then(() => true, () => false);
  if (!first) return;
  await logSystemError("ai", `[alarm] ${text}`, { dedupKey: `customer-bot-spend-cap:${day}` }).catch(() => {});
  const recipients = await findAgentsWithPermission("settings.manage").catch(() => [] as string[]);
  await sendPushToAgents(recipients, { title: "💸 Бот клиентов упёрся в суточный потолок трат", body: text,
    url: "/settings", tag: `customer-bot-spend-cap-${day}` }).catch(() => {});
}
