/**
 * СПАМ — БЕЗ ОТВЕТА (владелец 20.11.2026). Когда отсев действует: режим «только заявки» в этом канале, выключатель
 * «Спам — без ответа» (реестр «Автоматика ИИ и напоминания», ВКЛ), и у разговора нет карточки клиента (клиент с карточкой
 * — никогда не спам). Что считать спамом — одна дверь ai/customerSpamMute.ts::customerSpamTurn. Сбой чтения — «не
 * действует»: лишний обычный ответ дешевле, чем молчание настоящему клиенту.
 */
import { prisma } from "../db.js";
import { automationSwitchOn } from "./automationSwitches.js";
import { leadOnlyQuietBeforeLead } from "./leadOnlyConfig.js";

export async function spamFilterApplies(conversationId: string, channel: string): Promise<boolean> {
  try {
    if (!(await leadOnlyQuietBeforeLead(channel))) return false;
    if (!(await automationSwitchOn("botSpamFilterEnabled"))) return false;
    const row = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { clientId: true } });
    return !!row && !row.clientId;
  } catch {
    return false;
  }
}
