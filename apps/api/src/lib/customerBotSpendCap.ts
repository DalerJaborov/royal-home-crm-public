import { BOT_DAILY_SPEND_CAP_DEFAULT_USD, dushanbeDayKey } from "@royal-home/shared";
import { prisma } from "../db.js";
import { OPERATOR_COMPOSE_ENDPOINT, OPERATOR_UNDERSTAND_ENDPOINT } from "../ai/operator/endpoints.js";
import { automationSwitchOn } from "./automationSwitches.js";
import { dushanbeStartOfToday } from "./dushanbeTime.js";
import { logSystemError } from "./systemError.js";
import { findAgentsWithPermission } from "./recipients.js";
import { sendPushToAgents } from "../push.js";

/**
 * СУТОЧНЫЙ ДЕНЕЖНЫЙ ПОТОЛОК БОТА КЛИЕНТОВ — ОДНА ДВЕРЬ (CRM-47, 26.11.2026; правки ревью #450 в тот же день).
 *
 * Было (ФАКТ, код main): у бота клиентов нет потолка в деньгах. Оператор заявок, комментарии и старый бот зовут модель
 * через общую дверь `callAiText` без учёта суток. Петли (07.09: ~19 000 вызовов по одной переписке; 30.10: месячный
 * лимит Google за ночь) останавливал только лимит проекта Google, а он кладёт ВСЮ CRM.
 *
 * Правило: считается и останавливается только то, что эта дверь умеет остановить без тишины клиенту.
 *  • ОСТАНАВЛИВАЮТСЯ (CUSTOMER_BOT_GATED_ENDPOINTS) — понимание и «своими словами» оператора заявок (живой путь
 *    WhatsApp/Instagram/Facebook). Без модели оператор отвечает правилами (understandFallback) и готовыми фразами.
 *  • СЧИТАЮТСЯ, НО НЕ ОСТАНАВЛИВАЮТСЯ — старый бот (`lead-qualify`: на «нет ответа» он ставит фоновый повтор, клиент
 *    ждал бы до полуночи; правило владельца «боты не молчат») и комментарии (там «нет ответа» = повтор до полуночи и
 *    неудалённые объявления продавцов), проверка ценности ответа.
 *  • НЕ ВХОДИТ — ядро свободной модели (`royal-customer-gemini`): эта дверь его не останавливает, его предел закреплён
 *    в версии бота (maxDailyUsd, отдельная задача). Иначе потолок глушил бы дешёвые пути, пока ядро тратит дальше; к тому
 *    же резерв неудачных попыток ядра не возвращается и считался бы «тратой».
 * Сумма — только фактическая стоимость (`AiLog.costUsd`, у вызовов callAiText резерва нет) за сутки по Душанбе.
 *
 * Рубильник `botDailySpendCapEnabled` по умолчанию ВЫКЛ: сумму (предложено 5 $) выбирает владелец и включает сам.
 * Сбой чтения — потолка нет: учёт не имеет права сделать бота немым. Руководству одна тревога в сутки.
 */
export const CUSTOMER_BOT_GATED_ENDPOINTS: ReadonlySet<string> = new Set([OPERATOR_UNDERSTAND_ENDPOINT, OPERATOR_COMPOSE_ENDPOINT]);
export const CUSTOMER_BOT_COUNTED_ENDPOINTS: ReadonlySet<string> = new Set([...CUSTOMER_BOT_GATED_ENDPOINTS,
  "lead-qualify", "instagram-comment", "telegram-comment", "reply-worth-check"]);
export const SPEND_CAP_ALARM_CHANNEL = "customer-bot-spend-cap";

const CACHE_MS = 60_000;
let cache: { at: number; day: string; reached: boolean } | null = null;
/** Только для тестов: сбросить запомненный ответ. */
export function resetCustomerBotSpendCapCache(): void { cache = null; }

/** Траты бота клиентов за сутки по Душанбе, в которые попадает `now`. */
export async function customerBotSpentTodayUsd(now: Date = new Date()): Promise<number> {
  const from = dushanbeStartOfToday(now);
  const logged = await prisma.aiLog.aggregate({ _sum: { costUsd: true }, where: {
    createdAt: { gte: from, lt: new Date(from.getTime() + 86_400_000) }, operationId: null,
    endpoint: { in: [...CUSTOMER_BOT_COUNTED_ENDPOINTS] } } });
  return Number(logged._sum.costUsd ?? 0);
}

/** Потолок достигнут — эту точку бота клиентов не зовём. Только для точек, которые умеют отвечать без модели. Сбой — false. */
export async function customerBotSpendCapReached(endpoint: string, now: Date = new Date()): Promise<boolean> {
  if (!CUSTOMER_BOT_GATED_ENDPOINTS.has(endpoint)) return false;
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
    "До полуночи по Душанбе в WhatsApp, Instagram и Facebook он отвечает готовыми фразами без ИИ, заявки заводятся как обычно. " +
    "Комментарии и чат сайта работают с ИИ, как раньше. Поднять потолок или выключить его: Настройки, Автоматика ИИ, Бот клиентов.";
  // Одна тревога на сутки на все процессы: отметка в ProcessedMessage (уникальная пара канал+id, уборка общая через 3 дня).
  const first = await prisma.processedMessage.create({ data: { channel: SPEND_CAP_ALARM_CHANNEL, messageId: day, completedAt: new Date() } })
    .then(() => true, () => false);
  if (!first) return;
  await logSystemError("ai", `[alarm] ${text}`, { dedupKey: `customer-bot-spend-cap:${day}` }).catch(() => {});
  const recipients = await findAgentsWithPermission("settings.manage").catch(() => [] as string[]);
  await sendPushToAgents(recipients, { title: "💸 Бот клиентов упёрся в суточный потолок трат", body: text,
    url: "/settings", tag: `customer-bot-spend-cap-${day}` }).catch(() => {});
}
