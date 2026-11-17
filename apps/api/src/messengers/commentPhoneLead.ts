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
import { StaffPhoneLeadError } from "../lib/staffPhoneGuard.js";
import { classifyInbound } from "../services/leads/intakePolicy.js";
import { createLeadFromChannel } from "../services/leads/intake.js";

/**
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
}

/**
 * Номер самой компании (публичный и снятый с использования, lib/publicAgencyContact.ts) — не клиент:
 * люди цитируют «звоните 44 650 14 14» под постом. Первый номер комментария, не принадлежащий компании.
 */
function clientPhonesOf(text: string): string[] {
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
  conversationId: string
): Promise<CommentPhoneResult> {
  // Дешёвая проверка текста — до любого запроса в базу: у большинства комментариев номера нет.
  const phone = clientPhonesOf(row.text)[0];
  if (!phone) return NOTHING;
  if (commentLeadBlocked(row.text)) return { outcome: "declined", recordedInHistory: false };
  try {
    const conversation = await prisma.botConversation.findUnique({
      where: { id: conversationId },
      select: { clientId: true, leadDraft: true, messages: true, name: true, spamFlaggedAt: true },
    });
    if (!conversation) return NOTHING;
    if (conversation.clientId) return { outcome: "already", recordedInHistory: false };
    // Помеченный как рассылка заявкой не становится (та же защита, что в captureLeadWhileSilent).
    if (conversation.spamFlaggedAt) return { outcome: "spam", recordedInHistory: false };

    const history = (conversation.messages as unknown as ConversationMessage[]) ?? [];
    const marked = `${COMMENT_HISTORY_PREFIX}${row.text}`;
    // Этот комментарий уже в переписке — разбирали раньше (или человек уже решил его судьбу).
    if (history.some((m) => m.role === "user" && m.content === marked)) {
      return { outcome: "already", recordedInHistory: true };
    }

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
        deferAssignment: !(await isWithinWorkingHours()),
        clientText: marked,
        extraPhones: clientPhonesOf(row.text).filter((p) => p !== phone),
        silent: true,
      }
    );
    if (!result.accepted) return { outcome: "declined", recordedInHistory: false };
    void logSystemError(
      "ai",
      `Номер из комментария под публикацией (${row.channel}, диалог ${conversationId}) оформлен заявкой без ` +
        `ответа клиенту: комментарий ${row.commentId}.`
    );
    return { outcome: "accepted", recordedInHistory: true };
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

/**
 * Комментарий без диалога (обсуждение Telegram-канала): карточка по номеру — тем же
 * приёмом createLeadFromChannel, что и все автоматические лиды, с теми же отсечками
 * по смыслу (аренда и вакансия карточкой клиента не становятся, номер сотрудника
 * отсекает сам createLeadFromChannel). Номер, который уже принадлежит карточке,
 * второй раз не обрабатывается: повтор разбора комментария дубля не даёт.
 */
export async function createLeadFromCommentPhone(
  row: CommentPhoneRow & { channel: "TELEGRAM" | "INSTAGRAM" | "FACEBOOK" | "YOUTUBE" }
): Promise<CommentPhoneOutcome> {
  const phones = clientPhonesOf(row.text);
  const phone = phones[0];
  if (!phone) return "no_phone";
  if (commentLeadBlocked(row.text)) return "declined";
  try {
    if (looksLikeRentRequest(row.text) || mentionsJobSeeking(row.text)) return "declined";
    const [known] = await findPhoneOwners(phones, { includeDeleted: true, limit: 1 });
    if (known) {
      // Карточка есть (в том числе в корзине): не дубль и не потеря, но след оставляем без тревоги.
      if (known.deletedAt) console.info(`[comment-phone] номер комментария ${row.commentId} принадлежит удалённой карточке, заявка не заводится`);
      return "already";
    }
    const decision = classifyInbound({ clientText: row.text, channel: "chat" });
    if (decision.reason === "работа") return "declined";
    // В ClientSource нет YOUTUBE: как у createLeadFromCompetitorAd — INSTAGRAM, а площадка видна в socialChannel.
    const source: ClientSource = row.channel === "FACEBOOK" ? "FACEBOOK" : row.channel === "TELEGRAM" ? "TELEGRAM" : "INSTAGRAM";
    await createLeadFromChannel({
      fullName: row.authorName ? `@${row.authorName}` : "Комментатор",
      phone,
      extraPhones: phones.filter((p) => p !== phone),
      source,
      kind: decision.kind,
      requirementsNotes: [decision.label, `Оставил номер в комментарии под нашим постом: «${row.text.slice(0, 500)}»`]
        .filter(Boolean)
        .join("\n"),
      socialUsername: row.authorName ?? undefined,
      socialChannel: row.channel,
      deferAssignment: !(await isWithinWorkingHours()),
    });
    return "accepted";
  } catch (err) {
    if (err instanceof StaffPhoneLeadError) return "declined";
    void logSystemError(
      "ai",
      `[alarm] Номер в комментарии ${row.commentId} (${row.channel}), но заявку оформить не удалось: ` +
        `${err instanceof Error ? err.message : String(err)}. Откройте комментарий и заведите карточку руками.`
    );
    return "failed";
  }
}
