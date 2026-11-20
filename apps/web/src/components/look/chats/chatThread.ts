import { clientDisplayName, type ClientSource } from "@royal-home/shared";
import type { ConversationMessage } from "../../../types";
import { senderPrefix } from "../../MessageSenderBadge";
import { dushanbeDayLabel, dushanbeTime } from "../../../lib/date";
import { isMessagingWindowClosed } from "../../../lib/messagingWindow";

/**
 * ПЕРЕПИСКА «КАК В МЕССЕНДЖЕРЕ» (новый вид, владелец 20.11.2026: «всё как в
 * WhatsApp, красивенько»). Чистые функции окна разговора — без React, чтобы
 * правило жило в одном месте и проверялось тестом, а не глазами.
 */

/** Код карточки в имени-заглушке: «Продавец ПР-000894» → «ПР-000894». */
const CARD_CODE = /(?:^|\s)((?:ПР|ПК|КЛ|ПО|ОБ|PR|PK|KL|PO|OB)[-\s]?\d+)\s*$/iu;
const STUB_KIND: Record<string, "SELLER" | "BUYER" | "OTHER"> = {
  продавец: "SELLER",
  покупатель: "BUYER",
};
const CHANNEL_SOURCE: Record<string, ClientSource> = {
  WHATSAPP: "WHATSAPP",
  INSTAGRAM: "INSTAGRAM",
  FACEBOOK: "FACEBOOK",
  TELEGRAM: "TELEGRAM",
  TELEGRAM_DIRECT: "TELEGRAM",
};

/**
 * Имя в шапке переписки — без служебного кода карточки. Заглушку «Продавец
 * ПР-000894» сервер в списке уже подменяет на «Продавец из WhatsApp», а в
 * ответе одного разговора — нет; здесь та же общая функция
 * (`clientDisplayName` из @royal-home/shared), а не своя копия правила. Код
 * карточки не теряется: его показывают «Сведения о контакте».
 */
export function chatTitle(name: string | null | undefined, channel: string | null | undefined): { title: string; code: string | null } {
  const raw = (name ?? "").trim();
  if (!raw) return { title: "Без имени", code: null };
  const code = raw.match(CARD_CODE)?.[1]?.toUpperCase().replace(/\s/g, "-") ?? null;
  if (!code) return { title: raw, code: null };
  const role = raw.slice(0, raw.length - raw.match(CARD_CODE)![0].length).trim().toLowerCase();
  const kind = STUB_KIND[role] ?? "OTHER";
  const source = channel ? CHANNEL_SOURCE[channel] : undefined;
  return { title: clientDisplayName({ fullName: raw, kind, source }), code };
}

type ReplySource = { id: string; channel: string | null; canReply: boolean };

/**
 * КАНАЛ ОТВЕТА ПО УМОЛЧАНИЮ в общем чате клиента — так отвечают в любом
 * мессенджере: туда, откуда спросили. Порядок (ревью #332):
 *  1) только каналы, куда CRM вообще умеет отвечать (`canReply`);
 *  2) среди них — где клиент писал последним И окно ответа ещё открыто
 *     (WhatsApp/Instagram/Messenger не пропускают свободный текст позже суток);
 *  3) открытых нет — где клиент писал последним (строка о закрытом окне
 *     объяснит, что делать), затем — последний канал вообще.
 * Ручной выбор в «⋯» всегда важнее; во время набора выбор не меняется (Messages.tsx).
 */
export function autoReplySourceId(
  messages: readonly ConversationMessage[],
  sources: readonly ReplySource[] | undefined,
  now: Date = new Date(),
): string {
  const replyable = (sources ?? []).filter((source) => source.canReply);
  if (replyable.length === 0) return "";
  const channelOf = new Map(replyable.map((source) => [source.id, source.channel]));
  const lastInbound = new Map<string, string | null>();
  const inboundOrder: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user" || !m.sourceConversationId || !channelOf.has(m.sourceConversationId)) continue;
    if (lastInbound.has(m.sourceConversationId)) continue;
    lastInbound.set(m.sourceConversationId, m.at ?? null);
    inboundOrder.push(m.sourceConversationId);
  }
  const open = inboundOrder.find((id) => !isMessagingWindowClosed(channelOf.get(id), lastInbound.get(id) ?? null, now));
  if (open) return open;
  if (inboundOrder.length) return inboundOrder[0];
  for (let i = messages.length - 1; i >= 0; i--) {
    const id = messages[i].sourceConversationId;
    if (id && channelOf.has(id)) return id;
  }
  return replyable[replyable.length - 1].id;
}

/** Одна сторона разговора в один день: бот и сотрудник — одна сторона («мы»). */
export function sameSide(a: ConversationMessage | undefined, b: ConversationMessage | undefined, sameDay: (x: string, y: string) => boolean): boolean {
  if (!a || !b || a.role !== b.role) return false;
  return !(a.at && b.at && !sameDay(a.at, b.at));
}

/**
 * Последняя реплика группы подряд идущих реплик одной стороны — у неё «хвостик»
 * пузыря. Бот и сотрудник — одна сторона (наши, справа): кто именно ответил,
 * видно только в «Сведениях о сообщении», как у бизнес-аккаунта WhatsApp.
 */
export function isGroupTail(current: ConversationMessage, next: ConversationMessage | undefined, sameDay: (a: string, b: string) => boolean): boolean {
  return !sameSide(current, next, sameDay);
}

const DELIVERY_WORDS: Record<NonNullable<ConversationMessage["deliveryStatus"]>, string> = {
  sent: "Отправлено",
  delivered: "Доставлено",
  read: "Прочитано",
  failed: "Не доставлено",
};

/** «Сведения о сообщении» — строки для шторки по долгому нажатию. Пустых строк нет. */
export function messageInfoRows(message: ConversationMessage): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  if (message.at) rows.push({ label: "Время", value: `${dushanbeDayLabel(message.at)}, ${dushanbeTime(message.at)}` });
  if (message.role === "user") rows.push({ label: "Отправил", value: "Клиент" });
  else {
    const who = senderPrefix(message.by);
    rows.push({ label: "Отправил", value: who === "Бот" ? "Бот" : who === "CRM" ? "Автоматическая рассылка CRM" : who === "Вручную" ? "Вручную из мессенджера" : who });
    if (message.deliveryStatus) rows.push({ label: "Статус", value: DELIVERY_WORDS[message.deliveryStatus] });
  }
  return rows;
}
