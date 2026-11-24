import { prisma } from "../db.js";
import { isAiAssistantEnabled } from "../ai/assistant.js";
import { automationSwitchOn } from "../lib/automationSwitches.js";
import { describeError } from "../lib/describeError.js";
import { logSystemError } from "../lib/systemError.js";
import { findAgentByTelegramUserId, staffLinkDeepLink } from "../lib/telegramAgentLink.js";
import { sendMessageWithButtons, type TelegramIncomingMessage } from "./api.js";
import { ASSISTANT_LINK_OFFER, ASSISTANT_LINK_OFFER_BUTTON, bothLanguages } from "./assistantGroupPhrases.js";

/**
 * НОВИЧОК В РАБОЧЕЙ ГРУППЕ, КОТОРОГО CRM НЕ УЗНАЁТ (24.11.2026, жалоба владельца: «новички пишут,
 * она не отвечает»). Шабнам видит только сотрудников с привязанным Telegram; остальных молча
 * пропускала. Теперь один раз на Telegram-аккаунт (таблица AssistantTelegramLinkOffer) отвечает
 * коротко на двух языках и даёт кнопку в личку, где привязка идёт по номеру телефона
 * (lib/telegramAgentLink.ts → tryLinkAgentByContact).
 *
 * Когда:
 *  - "ambient" — новичок просто написал в подключённой группе. Только если Шабнам не попросили
 *    помолчать и включён рубильник «Шабнам отвечает в группах без обращения»;
 *  - "start" — нажал /start в подключённой группе (явная просьба: рубильник и «помолчи» не мешают);
 *  - "addressed" — позвал Шабнам по имени: отвечаем всегда (вместо прежнего «Я вас не знаю…»),
 *    без лимита «один раз».
 * Неподключённая группа, группа комментариев канала, боты, пересылки, «от имени канала» — мимо.
 */
export type LinkOfferMode = "ambient" | "start" | "addressed";

/** Уже предложено или уже привязан: память процесса, чтобы не ходить в базу на каждую реплику. */
const settled = new Set<string>();
function remember(telegramUserId: string): void {
  settled.add(telegramUserId);
  if (settled.size > 4096) {
    const oldest = settled.values().next().value;
    if (oldest) settled.delete(oldest);
  }
}

/** Только для тестов: забыть память процесса между сценариями. */
export function resetNewcomerMemoryForTests(): void {
  settled.clear();
}

/** true — предложение отправлено (сообщение разобрано). */
export async function offerTelegramLinkToNewcomer(msg: TelegramIncomingMessage, mode: LinkOfferMode, now = new Date()): Promise<boolean> {
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") return false;
  const from = msg.from;
  if (!from?.id || from.is_bot || msg.sender_chat || msg.forward_origin || msg.forward_from_message_id) return false;
  if (msg.new_chat_members || msg.left_chat_member || msg.migrate_to_chat_id || msg.migrate_from_chat_id) return false;
  const telegramUserId = String(from.id);
  const chatId = String(msg.chat.id);
  if (mode !== "addressed" && settled.has(telegramUserId)) return false;

  const [settings, group] = await Promise.all([
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { telegramDiscussionGroupId: true } }),
    prisma.assistantTelegramGroup.findUnique({ where: { chatId }, select: { proactiveMutedUntil: true } }),
  ]);
  if (!group || settings?.telegramDiscussionGroupId === chatId) return false;
  if (!(await isAiAssistantEnabled())) return false;
  if (mode === "ambient") {
    if (group.proactiveMutedUntil && group.proactiveMutedUntil > now) return false;
    if (!(await automationSwitchOn("shabnamGroupUnaddressedEnabled"))) return false;
  }
  if (await findAgentByTelegramUserId(telegramUserId)) {
    remember(telegramUserId);
    return false;
  }
  const link = await staffLinkDeepLink();
  if (!link) return false;

  // Один раз на аккаунт: победитель гонки один (первичный ключ), дубль апдейта второй раз не пишет.
  const claim = await prisma.assistantTelegramLinkOffer.createMany({
    data: { telegramUserId, chatId, offeredAt: now },
    skipDuplicates: true,
  });
  remember(telegramUserId);
  if (claim.count !== 1 && mode !== "addressed") return false;

  try {
    await sendMessageWithButtons(chatId, bothLanguages(ASSISTANT_LINK_OFFER), [[{ text: ASSISTANT_LINK_OFFER_BUTTON, url: link }]],
      msg.message_id, msg.message_thread_id);
    return true;
  } catch (err) {
    // Не дошло — не считаем предложенным: следующая реплика попробует снова.
    if (claim.count === 1) {
      await prisma.assistantTelegramLinkOffer.deleteMany({ where: { telegramUserId, contactRequestedAt: null } }).catch(() => {});
      settled.delete(telegramUserId);
    }
    await logSystemError("telegram", `Шабнам: предложение привязки новичку в группе не ушло: ${describeError(err)}`, {
      dedupKey: "assistant-group-link-offer",
    });
    return false;
  }
}
