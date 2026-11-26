import { prisma } from "../db.js";
import { isAiAssistantEnabled } from "../ai/assistant.js";
import { assistantLanguage, repliesInTajik } from "../ai/assistant/languageRouting.js";
import { automationSwitchOn } from "../lib/automationSwitches.js";
import { describeError } from "../lib/describeError.js";
import { logSystemError } from "../lib/systemError.js";
import { findAgentByTelegramUserId, staffLinkDeepLink } from "../lib/telegramAgentLink.js";
import { sendMessage, sendMessageWithButtons, type TelegramIncomingMessage } from "./api.js";
import { publicAppUrl } from "../lib/crmPublicUrl.js";
import { ASSISTANT_COLLEAGUE_GREETING, NEWCOMER_HINT_BUTTON, asksToBeLinked, bothLanguages, newcomerLinkHint } from "./assistantGroupPhrases.js";

/**
 * ЧЕЛОВЕК В РАБОЧЕЙ ГРУППЕ, КОТОРОГО CRM НЕ УЗНАЁТ — ОДНА ДВЕРЬ (24.11.2026, переписано 26.11.2026).
 *
 * Живая жалоба владельца 26.11 (группы «Royal Home» и «CRM FIX»): непривязанному коллеге Шабнам на
 * каждое сообщение отвечала огромным двуязычным блоком «Пока я вас не узнаю…» — четыре раза за пять
 * минут одному человеку, в том числе на открытку. Правила теперь:
 *  - отвечаем ТОЛЬКО на обращение: имя в тексте или подписи, @упоминание, /ai, ответ на её сообщение,
 *    /start (вызывающий решает, было ли обращение, и зовёт с mode "addressed" или "start");
 *  - фото, стикер, открытка, голосовое без подписи, пересылка, «от имени канала» — тишина, даже ответом
 *    на её сообщение: слов, на которые отвечать, нет;
 *  - не чаще раза в NEWCOMER_HINT_COOLDOWN_MS на пару «человек + группа» (таблица AssistantGroupPerson,
 *    атомарно), в остальное время полная тишина; повтор после паузы — другой фразой;
 *  - одна короткая фраза ОДНИМ языком (языком его сообщения), с именем, кнопка тем же языком.
 * Неподключённая группа, группа комментариев канала, боты, привязанные сотрудники — мимо.
 */
export type LinkOfferMode = "addressed" | "start";

/** Пауза между подсказками одному человеку в одной группе. */
export const NEWCOMER_HINT_COOLDOWN_MS = 6 * 60 * 60_000;

/**
 * Срок хранения отметок: строки AssistantTelegramLinkOffer (окно привязки в личке) и AssistantGroupPerson
 * (подсказка и приветствие) держим 90 дней. Потом человеку, так и не привязавшемуся, Шабнам может
 * подсказать ещё раз, а вернувшегося через три месяца поприветствовать снова: это не беда.
 */
export const LINK_OFFER_RETENTION_MS = 90 * 24 * 60 * 60_000;

export async function cleanupTelegramLinkOffers(now = new Date()): Promise<number> {
  const edge = new Date(now.getTime() - LINK_OFFER_RETENTION_MS);
  const offers = await prisma.assistantTelegramLinkOffer.deleteMany({ where: { offeredAt: { lt: edge } } });
  const people = await prisma.assistantGroupPerson.deleteMany({
    where: {
      AND: [
        { OR: [{ linkHintAt: null }, { linkHintAt: { lt: edge } }] },
        { OR: [{ welcomedAt: null }, { welcomedAt: { lt: edge } }] },
      ],
    },
  });
  return offers.count + people.count;
}

/** Имя из Telegram для обращения: без служебных знаков, коротко. */
function displayName(msg: TelegramIncomingMessage): string {
  return (msg.from?.first_name ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 32);
}

/**
 * Занять подсказку для пары «человек + группа»: первый раз или прошло 6 часов. Возвращает номер
 * подсказки (1, 2, …) или null, если сейчас нельзя. Победитель гонки один: первичный ключ и условие.
 */
async function claimHint(chatId: string, telegramUserId: string, now: Date): Promise<number | null> {
  const created = await prisma.assistantGroupPerson.createMany({
    data: { chatId, telegramUserId, linkHintAt: now, linkHintCount: 1 },
    skipDuplicates: true,
  });
  if (created.count === 1) return 1;
  const edge = new Date(now.getTime() - NEWCOMER_HINT_COOLDOWN_MS);
  const updated = await prisma.assistantGroupPerson.updateMany({
    where: { chatId, telegramUserId, OR: [{ linkHintAt: null }, { linkHintAt: { lte: edge } }] },
    data: { linkHintAt: now, linkHintCount: { increment: 1 } },
  });
  if (updated.count !== 1) return null;
  const row = await prisma.assistantGroupPerson.findUnique({
    where: { chatId_telegramUserId: { chatId, telegramUserId } }, select: { linkHintCount: true },
  });
  return row?.linkHintCount ?? 1;
}

/** true — подсказка отправлена. */
export async function offerTelegramLinkToNewcomer(msg: TelegramIncomingMessage, mode: LinkOfferMode, now = new Date()): Promise<boolean> {
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") return false;
  const from = msg.from;
  if (!from?.id || from.is_bot || msg.sender_chat || msg.forward_origin || msg.forward_from_message_id) return false;
  if (msg.new_chat_members || msg.left_chat_member || msg.migrate_to_chat_id || msg.migrate_from_chat_id) return false;
  // Фото, стикер, открытка, голосовое без подписи: отвечать не на что, даже если это ответ на её сообщение.
  const words = (msg.text ?? msg.caption ?? "").trim();
  if (!words) return false;
  const telegramUserId = String(from.id);
  const chatId = String(msg.chat.id);

  const [settings, group] = await Promise.all([
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { telegramDiscussionGroupId: true } }),
    prisma.assistantTelegramGroup.findUnique({ where: { chatId }, select: { chatId: true } }),
  ]);
  if (!group || settings?.telegramDiscussionGroupId === chatId) return false;
  if (!(await isAiAssistantEnabled())) return false;
  if (await findAgentByTelegramUserId(telegramUserId)) return false;

  // «Привязка Telegram по номеру» выключена (по умолчанию, ревью 25.11.2026): путь только через профиль CRM,
  // кнопка — сама страница профиля, если у CRM настоящий https-адрес.
  const byPhone = await automationSwitchOn("telegramPhoneLinkEnabled");
  const link = byPhone ? await staffLinkDeepLink() : null;
  if (byPhone && !link) return false;

  const attempt = await claimHint(chatId, telegramUserId, now);
  if (attempt === null) return false;

  const language = mode === "start" ? "ru" : repliesInTajik(assistantLanguage([{ role: "user", content: words }])) ? "tg" : "ru";
  const text = newcomerLinkHint({ language, name: displayName(msg), byPhone, asksToLink: asksToBeLinked(words), attempt });
  const profileUrl = `${publicAppUrl().replace(/\/+$/, "")}/profile`;
  const buttons = link
    ? [[{ text: NEWCOMER_HINT_BUTTON.dm[language], url: link }]]
    : profileUrl.startsWith("https://") ? [[{ text: NEWCOMER_HINT_BUTTON.profile[language], url: profileUrl }]] : [];

  try {
    await sendMessageWithButtons(chatId, text, buttons, msg.message_id, msg.message_thread_id);
    return true;
  } catch (err) {
    // Не дошло — не считаем подсказанным: следующее обращение попробует снова.
    await prisma.assistantGroupPerson.updateMany({ where: { chatId, telegramUserId }, data: { linkHintAt: null } }).catch(() => {});
    await logSystemError("telegram", `Шабнам: подсказка непривязанному в группе не ушла: ${describeError(err)}`, {
      dedupKey: "assistant-group-link-offer",
    });
    return false;
  }
}

/**
 * ПРИВЕТСТВИЕ НОВОГО УЧАСТНИКА — ОДИН РАЗ НА ЧЕЛОВЕКА В ГРУППЕ (26.11.2026: одного и того же пригласили
 * повторно и приветствовали заново). Отмечает людей (не ботов) из new_chat_members; возвращает, скольких
 * отметили впервые. 0 — все уже приветствованы, молчим.
 */
export async function claimNewMemberWelcome(chatId: string, members: unknown, now = new Date()): Promise<number> {
  const ids = (Array.isArray(members) ? members : [])
    .filter((m): m is { id: number; is_bot?: boolean } => Boolean(m) && typeof (m as { id?: unknown }).id === "number" && (m as { is_bot?: unknown }).is_bot !== true)
    .map((m) => String(m.id));
  if (!ids.length) return 0;
  const created = await prisma.assistantGroupPerson.createMany({
    data: ids.map((telegramUserId) => ({ chatId, telegramUserId, welcomedAt: now })),
    skipDuplicates: true,
  });
  // Строка уже была (Шабнам подсказывала ему привязку), а приветствия не было.
  const updated = await prisma.assistantGroupPerson.updateMany({
    where: { chatId, telegramUserId: { in: ids }, welcomedAt: null },
    data: { welcomedAt: now },
  });
  return created.count + updated.count;
}

/** Приветствие одним текстовым сообщением: русский и таджикский вместе, без голоса (26.11.2026). */
export async function sendColleagueWelcome(chatId: string): Promise<void> {
  await sendMessage(chatId, bothLanguages(ASSISTANT_COLLEAGUE_GREETING)).catch((err) => logSystemError("telegram",
    `Шабнам: приветствие нового участника не ушло: ${describeError(err)}`, { dedupKey: "assistant-group-greeting-text" }));
}
