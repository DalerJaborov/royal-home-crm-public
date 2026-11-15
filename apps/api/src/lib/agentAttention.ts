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

/** Не бросает: ход диалога важнее уведомления. "duplicate" — метка уже стоит. */
export async function requestAgentAttention(
  clientId: string,
  reason: AgentAttentionReason
): Promise<"sent" | "duplicate" | "no_agent" | "failed"> {
  try {
    const card = await prisma.client.findUnique({
      where: { id: clientId },
      select: { shortId: true, fullName: true, assignedAgentId: true, agentAttentionRequestedAt: true },
    });
    if (!card?.assignedAgentId) return "no_agent";
    if (card.agentAttentionRequestedAt) return "duplicate";
    // Условная запись — гонка двух ходов не даёт двух пушей.
    const marked = await prisma.client.updateMany({
      where: { id: clientId, agentAttentionRequestedAt: null },
      data: { agentAttentionRequestedAt: new Date() },
    });
    if (marked.count === 0) return "duplicate";
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
