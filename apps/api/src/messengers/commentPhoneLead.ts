import type { ConversationMessage } from "@royal-home/shared";
import type { ClientSource } from "@royal-home/shared";
import type { ChatMessage } from "../ai/client.js";
import { prisma } from "../db.js";
import { logSystemError } from "../lib/systemError.js";
import { extractAllPhones } from "../lib/shared/phoneText.js";
import { findPhoneOwners } from "../lib/clientPhones.js";
import { isWithinWorkingHours } from "../lib/workingHours.js";
import { watchdogLeadDraft } from "../lib/phoneLeadWatchdog.js";
import { looksLikeRentRequest } from "../ai/rentGuard.js";
import { mentionsJobSeeking } from "../ai/jobSeekerCall.js";
import { isPublicAgencyPhone, isRetiredPublicAgencyPhone } from "../lib/publicAgencyContact.js";
import { looksLikeMoneyRequest } from "../ai/moneyRequestGuard.js";
import { detectSpam } from "../lib/incomingSpam.js";
import { detectHate } from "../lib/commentHate.js";
import { detectAgencyAd, detectListingAd } from "../lib/listingAd.js";
import { findStaffPhone, StaffPhoneLeadError } from "../lib/staffPhoneGuard.js";
import { logTimeline } from "../lib/timeline.js";
import { randomUUID } from "node:crypto";
import { classifyInbound } from "../services/leads/intakePolicy.js";
import { createLeadFromChannel } from "../services/leads/intake.js";
import { loadCommentPhoneLead } from "../lib/botAnswersItself.js";

/**
 * НОМЕР ИЗ КОММЕНТАРИЯ: СНАЧАЛА РАЗГОВОР, ПОТОМ РАЗДАЧА (решения владельца и диспетчера 18.11.2026).
 *
 * РУБИЛЬНИКИ (ревью #283, 20.11.2026; одна дверь чтения — lib/botAnswersItself.ts). «Номер под постом: завести заявку
 * агенту» (botCommentPhoneLead) — по умолчанию ВЫКЛ: тогда ничего из описанного ниже не происходит, номер под постом
 * карточкой не становится (как до #283). Его проверяют все три двери этого файла. «Написать человеку и скрыть»
 * (botCommentPhoneConversation) — пункты 2–5 ниже, действует только при ВКЛ заявки; без него — только карточка с пометкой.
 *
 * Владелец: «неправильно, ИИ должен поговорить, чтобы узнать, что он хочет»; про комментарий с номером: «скрой, это
 * возможно спам». Порядок (messengers/comments.ts::handleCommentPhone):
 *  1. номер сразу в карточку (идемпотентно; номер чужой карточки или повтор — к ней, без новой и без второго личного);
 *  2. Instagram/Facebook: ОДИН личный ответ Meta (верхний уровень, не старше 7 суток, 1 на автора за 24 ч, аккаунт не
 *     заблокирован) — приветствие, «увидели ваш номер», один вопрос о цели (ai/botSelfAnswerText.ts::COMMENT_PHONE_DM);
 *  3. затем комментарий СКРЫТЬ. Личный ушёл — публичного ответа нет; личный невозможен — короткий публичный ответ без
 *     номера (по очереди из 4), скрыть, карточка СРАЗУ в раздачу с пометкой «боту не удалось написать в личные»;
 *  4. ответ клиента в личных (по recipient_id ответа Meta, иначе по автору) — та же карточка; ответ — в карточку, в раздачу;
 *  5. молчит — в раздачу через 20 минут (тик раздачи в рабочее окно, lib/commentPhoneHold.ts) с пометкой;
 *  6. YouTube: ответ под комментарием + заявка с пометкой + «на проверку» (heldForReview); Telegram-группа — заявка;
 *  7. на номер из комментария в WhatsApp не пишем.
 * Прежнее поведение #270 (17.11, «тихо в раздачу без разговора», журнал на каждую заявку) заменено этим.
 *
 * НОМЕР, ОСТАВЛЕННЫЙ В КОММЕНТАРИИ, НЕ ТЕРЯЕТСЯ (17.11.2026).
 *
 * Прежде карточку по номеру из комментария заводили только ветки «конкурент» и
 * «собственник» (createLeadFromCompetitorAd). Обычный человек, написавший под
 * публикацией «Нарх чанд? 900000001», получал её лишь если модель решала
 * ответить И личное сообщение уходило (recordPrivateReply кладёт реплику в
 * переписку, но карточку не заводит). Ответ внутри ветки, комментарий старше
 * семи суток, суточный предел личных, YouTube, решение модели `ignore`, отсечка
 * «не по теме», предел ходов ИИ, — во всех этих случаях номер оставался только в
 * ленте комментариев и терялся молча.
 *
 * ПУТЬ ПРИЁМА ОДИН. Для Instagram/Facebook/YouTube у автора комментария есть диалог
 * (досье, ensureConversationId), и номер уходит в ТОТ ЖЕ приём, что и номер из
 * личной переписки или сторожа лидов (acceptLead, messengers/conversation.ts, тихий
 * режим: без хода модели и без реплики). Отказы приёма (аренда, чужая страна,
 * номер сотрудника, номер уже у карточки) действуют те же, своих правил здесь нет.
 *
 * ИДЕМПОТЕНТНОСТЬ. Комментарий разбирается повторно (повтор после сбоя ИИ, застрявший
 * WORKING). Второй раз заявку не заводим: у диалога уже есть карточка, либо его
 * история уже содержит этот комментарий (ответ человека или прошлая попытка), а
 * сам acceptLead берёт захват атомарно.
 */

/** Метка комментария в переписке: её же пишет recordPrivateReply (messengers/comments.ts). */
export const COMMENT_HISTORY_PREFIX = "(комментарий под нашим постом) ";

export interface CommentPhoneRow {
  channel: string;
  commentId: string;
  authorId: string;
  authorName?: string | null;
  text: string;
}

export type CommentPhoneOutcome =
  /** Рубильник «Номер под постом: завести заявку агенту» выключен (Settings.botCommentPhoneLead): как до #283, ничего. */
  | "off"
  | "no_phone"
  | "already"
  | "spam"
  | "accepted"
  | "declined"
  | "failed";

export interface CommentPhoneResult {
  outcome: CommentPhoneOutcome;
  /** Комментарий уже лёг в переписку (приём записал реплику): повторно его дописывать нельзя. */
  recordedInHistory: boolean;
  /** Карточка диалога после приёма (accepted/already). */
  clientId?: string | null;
  /** Бот уже писал этому автору личное по номеру из комментария: второго не будет. */
  dmAlreadySent?: boolean;
}

/** Сколько карточка по номеру из комментария ждёт ответа клиента боту в личных, прежде чем уйти в раздачу. */
export const COMMENT_PHONE_HOLD_MS = 20 * 60_000;

/** Чистая: бот уже писал в этой переписке личное по номеру из комментария (любой язык). */
export function commentPhoneDmInHistory(history: readonly { role?: unknown; content?: unknown }[], dmTexts: readonly string[]): boolean {
  return history.some((m) => m.role === "assistant" && typeof m.content === "string" && dmTexts.includes(m.content.trim()));
}

/**
 * Номер самой компании (публичный и снятый с использования, lib/publicAgencyContact.ts) — не клиент:
 * люди цитируют «звоните 44 650 14 14» под постом. Первый номер комментария, не принадлежащий компании.
 */
export function clientPhonesOf(text: string): string[] {
  return extractAllPhones(text).filter((p) => {
    const digits = p.replace(/\D/g, "");
    return !isPublicAgencyPhone(digits) && !isRetiredPublicAgencyPhone(digits);
  });
}

/**
 * ЧЬИ НОМЕРА КЛИЕНТСКОЙ ЗАЯВКОЙ НЕ СТАНОВЯТСЯ — ПРОВЕРКА ЗДЕСЬ, В ОДНОЙ ДВЕРИ (ревью 17.11.2026), а не у каждого вызывающего:
 *  - просьба о материальной помощи: решение владельца, полное молчание и никаких заявок (как в личке, routes/webhooks.ts);
 *  - рассылка, мат, реклама агентства, объявление собственника: у них свои ветки (скрыть/удалить, карточка «Прочее»/«Продавец»),
 *    а клиентом конкурент не становится — важно для ветки managed ядра, которая их сама не разбирает.
 */
export function commentLeadBlocked(text: string): string | null {
  if (looksLikeMoneyRequest(text)) return "money_request";
  if (detectSpam(text, { comment: true })) return "spam";
  if (detectHate(text)) return "hate";
  if (detectAgencyAd(text)) return "agency_ad";
  if (detectListingAd(text)) return "listing_ad";
  return null;
}

const NOTHING: CommentPhoneResult = { outcome: "no_phone", recordedInHistory: false };

/**
 * Номер из комментария — в тот же тихий приём, что и номер из личной переписки.
 * Не бросает: разбор комментария из-за этого оборваться не должен.
 */
export async function captureCommentPhoneIntoConversation(
  row: CommentPhoneRow,
  conversationId: string,
  /** Новая карточка ждёт ответа в личных до этого срока (только если личное будет отправлено). */
  opts: { holdUntil?: Date; dmTexts?: readonly string[] } = {}
): Promise<CommentPhoneResult> {
  // Дешёвая проверка текста — до любого запроса в базу: у большинства комментариев номера нет.
  const phone = clientPhonesOf(row.text)[0];
  if (!phone) return NOTHING;
  // Рубильник заявки (ревью #283, 20.11): ВЫКЛ — как до #283. Проверка после дешёвой проверки текста: без номера — без чтения.
  if (!(await loadCommentPhoneLead())) return { outcome: "off", recordedInHistory: false };
  if (commentLeadBlocked(row.text)) return { outcome: "declined", recordedInHistory: false };
  try {
    const conversation = await prisma.botConversation.findUnique({
      where: { id: conversationId },
      select: { clientId: true, leadDraft: true, messages: true, name: true, spamFlaggedAt: true },
    });
    if (!conversation) return NOTHING;
    const history = (conversation.messages as unknown as ConversationMessage[]) ?? [];
    const dmAlreadySent = commentPhoneDmInHistory(history as unknown as { role?: unknown; content?: unknown }[], opts.dmTexts ?? []);
    const marked = `${COMMENT_HISTORY_PREFIX}${row.text}`;
    const recorded = history.some((m) => m.role === "user" && m.content === marked);
    if (conversation.clientId) {
      // Постоянный клиент оставил номер под постом (ревью 1b, №3): новый номер — в карточку, след с номером — в хронологию.
      if (!recorded) await attachCommentPhonesToCard(conversation.clientId, clientPhonesOf(row.text), row);
      return { outcome: "already", recordedInHistory: recorded, clientId: conversation.clientId, dmAlreadySent };
    }
    // Помеченный как рассылка заявкой не становится (та же защита, что в captureLeadWhileSilent).
    if (conversation.spamFlaggedAt) return { outcome: "spam", recordedInHistory: false };
    // Этот комментарий уже в переписке — разбирали раньше (или человек уже решил его судьбу).
    if (recorded) return { outcome: "already", recordedInHistory: true, clientId: null, dmAlreadySent };

    const { acceptLead } = await import("./conversation.js");
    const result = await acceptLead(
      conversationId,
      row.channel,
      conversation.name ?? row.authorName ?? undefined,
      phone,
      watchdogLeadDraft({
        draft: conversation.leadDraft,
        coreTopic: null,
        history: [...history, { role: "user", content: row.text } as ConversationMessage],
      }),
      history as unknown as ChatMessage[],
      {
        // Карточка ждёт ответа в личных — назначение откладывается до ответа или срока (lib/commentPhoneHold.ts).
        deferAssignment: opts.holdUntil ? true : !(await isWithinWorkingHours()),
        ...(opts.holdUntil ? { commentPhoneHoldUntil: opts.holdUntil } : {}),
        clientText: marked,
        extraPhones: clientPhonesOf(row.text).filter((p) => p !== phone),
        silent: true,
      }
    );
    if (!result.accepted) return { outcome: "declined", recordedInHistory: false };
    // Заявка — штатное событие, не ошибка: след в логе контейнера, без строки «Здоровья системы» (18.11.2026).
    console.info(`[comment-phone] номер из комментария ${row.commentId} (${row.channel}) → заявка, диалог ${conversationId}`);
    const linked = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { clientId: true } });
    return { outcome: "accepted", recordedInHistory: true, clientId: linked?.clientId ?? null, dmAlreadySent };
  } catch (err) {
    // Номер сотрудника — не потеря, а отказ по правилу: тревоги «заведите карточку руками» нет.
    if (err instanceof StaffPhoneLeadError) return { outcome: "declined", recordedInHistory: false };
    // Номер в ленте комментариев есть, карточки нет: случай обязан стать видимым.
    void logSystemError(
      "ai",
      `[alarm] Номер в комментарии ${row.commentId} (${row.channel}, диалог ${conversationId}), но заявку оформить ` +
        `не удалось: ${err instanceof Error ? err.message : String(err)}. Откройте комментарий и заведите карточку руками.`
    );
    return { outcome: "failed", recordedInHistory: false };
  }
}

const digits9 = (value: string | null | undefined): string => (value ?? "").replace(/\D/g, "").slice(-9);

/**
 * ОДИН КОММЕНТАРИЙ — ОДИН ПРИЁМ: атомарный захват по id комментария, общий для обеих дверей (карточка уже есть —
 * attachCommentPhonesToCard; карточки нет и диалога нет — createLeadFromCommentPhone). Повторный вебхук того же комментария
 * второй записи в хронологию и второго приёма из корзины не даёт (HANDOFF #283, 19.11). Сбой приёма захват снимает.
 */
const COMMENT_PHONE_CLAIM_CHANNEL = "comment-phone-lead";
async function claimCommentPhone(row: Pick<CommentPhoneRow, "channel" | "commentId">): Promise<boolean> {
  const claimed = await prisma.$executeRaw`INSERT INTO "ProcessedMessage" ("id","channel","messageId","createdAt","completedAt")
    VALUES (${randomUUID()},${COMMENT_PHONE_CLAIM_CHANNEL},${`${row.channel}:${row.commentId}`},now(),now()) ON CONFLICT ("channel","messageId") DO NOTHING`;
  return claimed === 1;
}
async function releaseCommentPhoneClaim(row: Pick<CommentPhoneRow, "channel" | "commentId">): Promise<void> {
  await prisma.processedMessage.deleteMany({ where: { channel: COMMENT_PHONE_CLAIM_CHANNEL, messageId: `${row.channel}:${row.commentId}` } })
    .catch(() => undefined);
}

/**
 * Номер из комментария клиента, у которого карточка уже есть: новые номера — запасными (не чужие и не сотрудника), запись
 * в хронологию с номером. Не бросает: сбой виден в журнале, разбор комментария идёт дальше.
 */
export async function attachCommentPhonesToCard(clientId: string, phones: readonly string[], row: Pick<CommentPhoneRow, "commentId" | "channel" | "text">): Promise<string[]> {
  if (!(await loadCommentPhoneLead())) return []; // рубильник заявки ВЫКЛ — как до #283
  let claimed = false;
  try {
    claimed = await claimCommentPhone(row);
    if (!claimed) return []; // этот комментарий уже разобран (повторный вебхук)
    const card = await prisma.client.findUnique({ where: { id: clientId },
      select: { phone: true, whatsappPhone: true, extraPhones: true, deletedAt: true, assignedAgentId: true, fullName: true, kind: true } });
    if (!card) return [];
    if (card.deletedAt) {
      // Карточка в корзине (второе ревью 1b, №2): штатный приём по её номеру — resumeExistingChannelLead вернёт её по
      // правилам раздачи и уведомит агента; номера из комментария — запасными. Номер не теряется.
      const source: ClientSource = row.channel === "FACEBOOK" ? "FACEBOOK" : row.channel === "TELEGRAM" ? "TELEGRAM" : "INSTAGRAM";
      await createLeadFromChannel({ fullName: card.fullName, phone: card.phone, extraPhones: [...phones], source,
        ...(card.kind !== "OTHER" ? { kind: card.kind } : {}),
        requirementsNotes: `Клиент снова оставил номер в комментарии под нашим постом: ${phones.join(", ")} — «${row.text.slice(0, 300)}»`,
        socialChannel: row.channel, deferAssignment: !(await isWithinWorkingHours()) });
      return [...phones];
    }
    const own = new Set([card.phone, card.whatsappPhone, ...card.extraPhones].map(digits9).filter(Boolean));
    const added: string[] = [];
    for (const phone of phones) {
      if (own.has(digits9(phone))) continue;
      if (await findStaffPhone([phone])) continue;
      const [owner] = await findPhoneOwners([phone], { limit: 1 });
      if (owner && owner.id !== clientId) continue;
      added.push(phone); own.add(digits9(phone));
    }
    if (added.length) await prisma.client.update({ where: { id: clientId }, data: { extraPhones: [...card.extraPhones, ...added] } });
    await logTimeline({ clientId, type: "SYSTEM", actor: { kind: "client", source: "comment-phone", ...(card.assignedAgentId ? { subjectAgentId: card.assignedAgentId } : {}) },
      notes: `Клиент оставил номер в комментарии под нашим постом: ${phones.join(", ")}` +
        `${added.length ? ` (новый номер добавлен в карточку: ${added.join(", ")})` : ""} — «${row.text.slice(0, 300)}»` });
    return added;
  } catch (err) {
    if (claimed) await releaseCommentPhoneClaim(row);
    void logSystemError("ai", `Номер из комментария ${row.commentId} (${row.channel}) не добавлен в карточку клиента: ` +
      `${err instanceof Error ? err.message : String(err)}`, { silent: true });
    return [];
  }
}

/**
 * Комментарий без диалога (обсуждение Telegram-канала): карточка по номеру — тем же
 * приёмом createLeadFromChannel, что и все автоматические лиды, с теми же отсечками
 * по смыслу (аренда и вакансия карточкой клиента не становятся, номер сотрудника
 * отсекает сам createLeadFromChannel). Номер, который уже принадлежит карточке,
 * второй раз не обрабатывается: повтор разбора комментария дубля не даёт.
 */
export async function createLeadFromCommentPhone(
  row: CommentPhoneRow & { channel: "TELEGRAM" | "INSTAGRAM" | "FACEBOOK" | "YOUTUBE" },
  /** Пометка для агента (почему без разговора): «личных сообщений нет», «боту не удалось написать в личные». */
  note?: string
): Promise<CommentPhoneOutcome> {
  const phones = clientPhonesOf(row.text);
  const phone = phones[0];
  if (!phone) return "no_phone";
  if (!(await loadCommentPhoneLead())) return "off"; // рубильник заявки ВЫКЛ — как до #283
  if (commentLeadBlocked(row.text)) return "declined";
  if (looksLikeRentRequest(row.text) || mentionsJobSeeking(row.text)) return "declined";
  const decision = classifyInbound({ clientText: row.text, channel: "chat" });
  if (decision.reason === "работа") return "declined";
  /**
   * ОДИН КОММЕНТАРИЙ — ОДИН ПРИЁМ (ревью 1b, №3). Номер уже у карточки (в том числе в корзине) больше НЕ отбрасывается:
   * штатный приём createLeadFromChannel сам ведёт его в resumeExistingChannelLead (запись в хронологию, уведомление агенту,
   * возврат из корзины по правилам раздачи). Повтор разбора того же комментария второй раз приём не зовёт — захват по id
   * комментария атомарный; сбой приёма захват снимает.
   */
  if (!await claimCommentPhone(row)) return "already";
  try {
    // В ClientSource нет YOUTUBE: как у createLeadFromCompetitorAd — INSTAGRAM, а площадка видна в socialChannel.
    const source: ClientSource = row.channel === "FACEBOOK" ? "FACEBOOK" : row.channel === "TELEGRAM" ? "TELEGRAM" : "INSTAGRAM";
    const lead = await createLeadFromChannel({
      fullName: row.authorName ? `@${row.authorName}` : "Комментатор",
      phone,
      extraPhones: phones.filter((p) => p !== phone),
      source,
      kind: decision.kind,
      requirementsNotes: [decision.label, `Оставил номер в комментарии под нашим постом: «${row.text.slice(0, 500)}»`, note]
        .filter(Boolean)
        .join("\n"),
      socialUsername: row.authorName ?? undefined,
      socialChannel: row.channel,
      deferAssignment: !(await isWithinWorkingHours()),
    });
    return lead.created ? "accepted" : "already";
  } catch (err) {
    await releaseCommentPhoneClaim(row);
    if (err instanceof StaffPhoneLeadError) return "declined";
    void logSystemError(
      "ai",
      `[alarm] Номер в комментарии ${row.commentId} (${row.channel}), но заявку оформить не удалось: ` +
        `${err instanceof Error ? err.message : String(err)}. Откройте комментарий и заведите карточку руками.`
    );
    return "failed";
  }
}
