import { clientDisplayName, type ClientSource } from "@royal-home/shared";
import type { ConversationMessage } from "../../../types";
import { senderPrefix } from "../../MessageSenderBadge";
import { dushanbeDayLabel, dushanbeTime } from "../../../lib/date";

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
 * КАНАЛ ОТВЕТА ПО УМОЛЧАНИЮ в общем чате клиента: тот, где клиент писал
 * последним (так отвечают в любом мессенджере — туда, откуда спросили). Нет
 * входящих из доступного канала — последний канал, куда вообще можно ответить.
 * Ручной выбор остаётся в «⋯» и всегда важнее этого.
 */
export function autoReplySourceId(messages: readonly ConversationMessage[], sources: readonly ReplySource[] | undefined): string {
  const replyable = (sources ?? []).filter((source) => source.canReply);
  if (replyable.length === 0) return "";
  const ids = new Set(replyable.map((source) => source.id));
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && m.sourceConversationId && ids.has(m.sourceConversationId)) return m.sourceConversationId;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const id = messages[i].sourceConversationId;
    if (id && ids.has(id)) return id;
  }
  return replyable[replyable.length - 1].id;
}

/**
 * Последняя реплика группы подряд идущих реплик одной стороны — у неё «хвостик»
 * пузыря. Бот и сотрудник — одна сторона (наши, справа): кто именно ответил,
 * видно только в «Сведениях о сообщении», как у бизнес-аккаунта WhatsApp.
 */
export function isGroupTail(current: ConversationMessage, next: ConversationMessage | undefined, sameDay: (a: string, b: string) => boolean): boolean {
  if (!next) return true;
  if (next.role !== current.role) return true;
  if (current.at && next.at && !sameDay(current.at, next.at)) return true;
  return false;
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
