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
 * Третье ревью 13.11.2026, №1–№2: память — запасной ответ, а не приказ.
 *  - Тема и объект ТЕКУЩЕГО сообщения сильнее запомненных («хочу продать свою квартиру, 93…» через
 *    три дня после поста объекта A — продавец, а не покупатель A). Это решают маршруты, память лишь
 *    подсказывает тему голому номеру или отказу.
 *  - Заявка оформлена — память стирается (acceptLead, одна дверь заявок из переписки); у диалога с
 *    карточкой память не читается вовсе (просьба номера бывает только без карточки, и привязка
 *    другим путём — оператором, мостом ядра — тоже её гасит).
 *  - Клиент сменил тему или объект, а номер бот больше не просит — память стирается ходом (`forget`).
 *  - Срок — трое суток: номер в ответ на «оставьте номер» приходит в пределах часов, реже на
 *    следующий день или после выходных; неделя держала чужой объект слишком долго.
 *
 * Хранится только id объекта и сценарий: ни слов, ни номера клиента.
 */
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { prisma, type TxClient } from "../db.js";
import type { LeadOnlyScenario } from "../ai/leadOnlyMode.js";

/** Трое суток (третье ревью 13.11): после этого номер — новый разговор, а не ответ на старую просьбу. */
export const LEAD_ONLY_PENDING_TTL_MS = 3 * 24 * 60 * 60_000;

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

/** Память из строки диалога: у диалога с карточкой её нет (номер у агента уже есть, просить было нечего). */
export function leadOnlyPendingOfRow(row: { clientId: string | null; leadOnlyPending: unknown } | null | undefined,
  now: Date = new Date()): LeadOnlyPending | null {
  return row && !row.clientId ? parseLeadOnlyPending(row.leadOnlyPending, now) : null;
}

/** Записать, о чём попросили номер. `db` — транзакция хода (ядро и старый путь пишут вместе с ответом). */
export async function rememberLeadOnlyAsk(db: TxClient | typeof prisma, conversationId: string, pending: LeadOnlyPending): Promise<void> {
  await db.botConversation.updateMany({ where: { id: conversationId }, data: { leadOnlyPending: pending } });
}

/** Стереть память: заявка оформлена или тема сменилась. Пустая колонка не трогается (нет лишней записи). */
export async function forgetLeadOnlyAsk(db: TxClient | typeof prisma, conversationId: string): Promise<void> {
  await db.botConversation.updateMany({ where: { id: conversationId, leadOnlyPending: { not: Prisma.DbNull } },
    data: { leadOnlyPending: Prisma.DbNull } });
}

/** Что сделать с памятью в конце хода режима: записать новую просьбу, стереть или не трогать. */
export async function applyLeadOnlyPending(db: TxClient | typeof prisma, conversationId: string,
  plan: { remember: LeadOnlyPending | null; forget?: boolean }): Promise<void> {
  if (plan.remember) await rememberLeadOnlyAsk(db, conversationId, plan.remember);
  else if (plan.forget) await forgetLeadOnlyAsk(db, conversationId);
}

export async function readLeadOnlyPending(conversationId: string, now: Date = new Date()): Promise<LeadOnlyPending | null> {
  const row = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { clientId: true, leadOnlyPending: true } })
    .catch(() => null);
  return leadOnlyPendingOfRow(row, now);
}
