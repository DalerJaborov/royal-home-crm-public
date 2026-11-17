import { prisma } from "../db.js";
import { sendPushToAgent } from "../push.js";

/**
 * СИГНАЛ ЗАКРЕПЛЁННОМУ АГЕНТУ «С КЛИЕНТОМ НАДО СВЯЗАТЬСЯ» — ОДНА ДВЕРЬ (16.11.2026).
 *
 * Раньше жила внутри messengers/conversation.ts и срабатывала на одно: клиент прямо попросил
 * живого агента (looksLikeWantsHumanAgent). Аудит 16.11 (facts.md Ф4) нашёл второй повод с
 * тем же смыслом: старый бот ОБЕЩАЛ клиенту с номером «агент позвонит», а агенту не уходило
 * ничего, кроме обычного «новое сообщение» — обещание, которое никто не обязан выполнить.
 *
 * Механизм один на оба повода: метка `agentAttentionRequestedAt` (список сообщений поднимает
 * карточку первой и красным) плюс один заметный пуш агенту. Пока метка стоит — второго пуша
 * нет (её гасит ответ или дозвон агента, lib/conversationDelivery.ts), так что агента не
 * дёргаем на каждое сообщение («редко беспокоить», правило владельца 10.11.2026).
 * Без назначенного агента отмечать некого — заявку решит обычная раздача.
 */
export type AgentAttentionReason = "wants_human" | "call_promised";

const TEXTS: Record<AgentAttentionReason, { title: (name: string) => string; body: string }> = {
  wants_human: {
    title: (name) => `${name} хочет поговорить с вами`,
    body: "Клиент попросил живого агента — бот отвечает вместо вас, пока вы не свяжетесь сами.",
  },
  call_promised: {
    title: (name) => `${name}: бот пообещал ваш звонок`,
    body: "В переписке клиенту сказали, что агент позвонит. Позвоните или напишите ему сами.",
  },
};

/**
 * Поставить метку «агенту надо связаться» — единственное место записи (сторож:
 * tests/bot-old-core-facts-16-11.test.ts, «одна дверь метки»). Условная запись: из двух
 * одновременных ходов метку ставит один. true — метка поставлена сейчас.
 */
export async function markAgentAttention(clientId: string): Promise<boolean> {
  const marked = await prisma.client.updateMany({
    where: { id: clientId, agentAttentionRequestedAt: null },
    data: { agentAttentionRequestedAt: new Date() },
  });
  return marked.count > 0;
}

/**
 * Свежая заявка: агент только что получил пуш «новая заявка» (раздача) и сам позвонит.
 * Обещание звонка в ответе бота в первый час после приёма — то же самое событие, второй
 * CRITICAL-пуш по нему — шум (ревью #207, С1-б).
 */
export const FRESH_LEAD_QUIET_MS = 60 * 60 * 1000;

/** Не бросает: ход диалога важнее уведомления. "duplicate" — метка уже стоит. */
export async function requestAgentAttention(
  clientId: string,
  reason: AgentAttentionReason,
  now: Date = new Date()
): Promise<"sent" | "duplicate" | "no_agent" | "fresh_lead" | "failed"> {
  try {
    const card = await prisma.client.findUnique({
      where: { id: clientId },
      select: { shortId: true, fullName: true, assignedAgentId: true, agentAttentionRequestedAt: true, createdAt: true, acceptedAt: true },
    });
    if (!card?.assignedAgentId) return "no_agent";
    if (card.agentAttentionRequestedAt) return "duplicate";
    // Свежесть — от приёма заявки, а не от создания карточки: у старого клиента новая заявка (повторное ревью, С1-а′).
    const leadAt = card.acceptedAt ?? card.createdAt;
    if (reason === "call_promised" && now.getTime() - leadAt.getTime() < FRESH_LEAD_QUIET_MS) return "fresh_lead";
    if (!(await markAgentAttention(clientId))) return "duplicate";
    const text = TEXTS[reason];
    await sendPushToAgent(card.assignedAgentId, {
      kind: "message",
      level: "CRITICAL",
      title: text.title(card.fullName),
      body: text.body,
      url: `/clients/${card.shortId}`,
      tag: `agent-attention-${clientId}`,
    });
    return "sent";
  } catch (err) {
    console.error("[push] сигнал агенту:", err instanceof Error ? err.message : err);
    return "failed";
  }
}
