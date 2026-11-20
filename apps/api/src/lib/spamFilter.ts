/**
 * СПАМ — БЕЗ ОТВЕТА (владелец 20.11.2026). Когда отсев действует: режим «только заявки» в этом канале, выключатель
 * «Спам — без ответа» (реестр «Автоматика ИИ и напоминания», ВКЛ), у разговора нет карточки клиента и руководство не
 * нажимало «вернуть боту». Что считать спамом — одна дверь ai/customerSpamMute.ts::customerSpamTurn. Сбой чтения — «не
 * действует»: лишний обычный ответ дешевле, чем молчание настоящему клиенту.
 *
 * ОТСЕВ НЕ НЕВИДИМ (ревью #333): каждый отсеянный ход обновляет ОДНУ строку в колокольчике руководства за сутки
 * («Отсеяно как спам сегодня: N») со ссылкой на список (GET /api/v1/conversations/spam-filtered), где есть «вернуть боту».
 */
import { prisma } from "../db.js";
import { automationSwitchOn } from "./automationSwitches.js";
import { leadOnlyQuietBeforeLead } from "./leadOnlyConfig.js";
import { customerSpamMuteFrom } from "../ai/customerSpamMute.js";
import { createNotifications } from "./notifications.js";
import { dushanbeDayKey } from "@royal-home/shared";

export async function spamFilterApplies(conversationId: string, channel: string): Promise<boolean> {
  try {
    if (!(await leadOnlyQuietBeforeLead(channel))) return false;
    if (!(await automationSwitchOn("botSpamFilterEnabled"))) return false;
    const row = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { clientId: true, leadDraft: true } });
    if (!row || row.clientId) return false;
    const draft = row.leadDraft && typeof row.leadDraft === "object" && !Array.isArray(row.leadDraft) ? row.leadDraft as Record<string, unknown> : {};
    return customerSpamMuteFrom(draft.spamMute).exempt !== true;
  } catch {
    return false;
  }
}

/** Сколько ходов отсеяно сегодня (по отметкам spamMute.turns с датой Душанбе). */
export async function spamFilteredToday(now: Date = new Date()): Promise<number> {
  const day = dushanbeDayKey(now);
  const rows = await prisma.$queryRaw<Array<{ at: string }>>`SELECT t->>'at' AS "at" FROM "BotConversation" c,
      jsonb_array_elements(COALESCE(c."leadDraft"->'spamMute'->'turns', '[]'::jsonb)) t
    WHERE c."lastMessageAt" > ${new Date(now.getTime() - 2 * 86_400_000)}`;
  return rows.filter(row => row.at && dushanbeDayKey(new Date(row.at)) === day).length;
}

/** Одна накопительная строка в колокольчике руководства за сутки. Сбой — в журнал вызывающего, ход не роняет. */
export async function noteSpamFiltered(now: Date = new Date()): Promise<void> {
  const count = await spamFilteredToday(now);
  const leaders = (await prisma.agent.findMany({ where: { isActive: true, role: { in: ["HEAD_OF_SALES", "DIRECTOR", "ADMIN"] } }, select: { id: true } })).map(row => row.id);
  if (!leaders.length) return;
  await createNotifications(leaders, { kind: "message", title: "🧹 Отсеяно как спам", tag: `spam-filtered-${dushanbeDayKey(now)}`,
    body: `Сегодня бот не ответил на спам ${count} раз (лайки, подписки, просьбы денег, чужая реклама). Если там живой клиент — «Вернуть боту».`,
    url: "/settings?tab=bot#spam-filtered" });
}
