/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ»: О ЧЁМ БОТ ПОПРОСИЛ НОМЕР (второе ревью 13.11.2026, находка №1).
 *
 * Сценарий 2 в Instagram/Facebook: клиент присылает пост объекта, бот отвечает «Это объект №N…
 * оставьте номер», следующим сообщением приходит ОДИН номер. Сам номер темы не несёт, объект
 * этого хода не пришёл, и заявка уходила в общую очередь (а ночью ждала утра) вместо агента
 * объекта. Поэтому в момент просьбы номера оба маршрута бота (ядро — lib/customerLeadOnlyCore.ts,
 * старый путь — messengers/leadOnlyLegacy.ts) записывают сюда сценарий и объект, а ход с номером
 * читает их отсюда. Одна дверь записи и чтения, колонка BotConversation.leadOnlyPending.
 *
 * Хранится только id объекта и сценарий: ни слов, ни номера клиента.
 */
import { z } from "zod";
import { prisma, type TxClient } from "../db.js";
import type { LeadOnlyScenario } from "../ai/leadOnlyMode.js";

/** Дольше недели просьба номера не живёт: тема могла смениться, а номер через месяц — новый разговор. */
export const LEAD_ONLY_PENDING_TTL_MS = 7 * 24 * 60 * 60_000;

const pendingSchema = z.object({
  version: z.literal(1),
  scenario: z.enum(["hot", "property", "seller", "buyer"]),
  propertyId: z.string().uuid().nullable(),
  askedAt: z.string().datetime(),
}).strict();
export type LeadOnlyPending = z.infer<typeof pendingSchema>;

export function leadOnlyPendingOf(scenario: LeadOnlyScenario, propertyId: string | null, now: Date = new Date()): LeadOnlyPending {
  // Объект храним только для разговора о нём: покупатель «ищу в Сино» не должен уехать агенту старого объекта.
  return { version: 1, scenario, propertyId: scenario === "property" || scenario === "hot" ? propertyId : null, askedAt: now.toISOString() };
}

/** Разбор сохранённого: битое или просроченное — как будто ничего не просили. */
export function parseLeadOnlyPending(raw: unknown, now: Date = new Date()): LeadOnlyPending | null {
  const parsed = pendingSchema.safeParse(raw);
  if (!parsed.success) return null;
  const age = now.getTime() - Date.parse(parsed.data.askedAt);
  return age >= 0 && age <= LEAD_ONLY_PENDING_TTL_MS ? parsed.data : null;
}

/** Записать, о чём попросили номер. `db` — транзакция хода ядра или общий клиент старого пути. */
export async function rememberLeadOnlyAsk(db: TxClient | typeof prisma, conversationId: string, pending: LeadOnlyPending): Promise<void> {
  await db.botConversation.updateMany({ where: { id: conversationId }, data: { leadOnlyPending: pending } });
}

export async function readLeadOnlyPending(conversationId: string, now: Date = new Date()): Promise<LeadOnlyPending | null> {
  const row = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { leadOnlyPending: true } }).catch(() => null);
  return parseLeadOnlyPending(row?.leadOnlyPending, now);
}
