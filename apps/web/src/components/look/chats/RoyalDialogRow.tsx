import { memo } from "react";
import { Bot, Flame } from "lucide-react";
import type { ConversationListItem } from "../../../hooks/useConversations";
import { exactDateTime, listTime } from "../../../lib/format";
import { senderPrefix } from "../../MessageSenderBadge";
import { RhAvatar } from "../ui";
import { RoyalChannelBadge } from "./RoyalChannelBadge";

/**
 * Сколько ждёт живого человека и насколько это срочно (тот же порог, что в
 * макете: от часа — срочно, больше 15 минут — внимание). null — не ждёт.
 * Чистая функция: проверяется тестом без экрана.
 */
export function chatWaiting(awaitingHumanSince: string | null, now = Date.now()): { label: string; tone: "crit" | "warn" | "calm" } | null {
  if (!awaitingHumanSince) return null;
  const since = new Date(awaitingHumanSince).getTime();
  if (!Number.isFinite(since)) return null;
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  const label = minutes < 1 ? "сейчас" : minutes < 60 ? `${minutes} мин` : minutes < 24 * 60 ? `${Math.floor(minutes / 60)} ч` : `${Math.floor(minutes / 1440)} дн`;
  return { label, tone: minutes >= 60 ? "crit" : minutes > 15 ? "warn" : "calm" };
}

/** Часы паузы бота при ждущем клиенте (то же правило, что у прежней строки и крона botPauseWatch). */
function pauseWaitHours(c: ConversationListItem, now: number): number | null {
  if (!c.paused || !c.awaitingHumanSince) return null;
  const hours = (now - new Date(c.awaitingHumanSince).getTime()) / 3_600_000;
  return hours >= 1 ? Math.round(hours) : 0;
}

/**
 * СТРОКА РАЗГОВОРА НОВОГО ВИДА (18.11.2026): аватар с меткой канала в родном
 * цвете, имя, ОДНА строка текста, справа время ожидания (или время последнего
 * сообщения) и пометки. Данные — ровно те же, что у прежней строки
 * (Rh2DialogRow): «Просит агента», непрочитанные числом, «бот на паузе» с
 * часами ожидания, метка нашего аккаунта. Аватара ведущего агента нет: список
 * его не присылает, а выдумывать нельзя.
 *
 * memo: строка перерисовывается, только когда пришли новые данные этого
 * разговора или сменился выбор, а не при каждом вводе в поиск/ответ.
 */
export const RoyalDialogRow = memo(function RoyalDialogRow({ conversation: c, selected, showAccount, onSelect }: {
  conversation: ConversationListItem;
  selected: boolean;
  showAccount: boolean;
  onSelect: (id: string) => void;
}) {
  const now = Date.now();
  const waiting = chatWaiting(c.awaitingHumanSince, now);
  const pauseHours = pauseWaitHours(c, now);
  const unread = c.unread ? (c.unreadCount && c.unreadCount > 0 ? (c.unreadCount > 99 ? "99+" : String(c.unreadCount)) : "") : null;
  const accountLabel = showAccount ? c.accountTitle : null;
  const attention = !!c.agentAttentionRequestedAt;
  const last = c.lastMessage
    ? `${c.lastMessage.role === "assistant" ? `${senderPrefix(c.lastMessage.by)}: ` : ""}${c.lastMessage.content}`
    : "";
  return (
    <button
      type="button"
      className="ry-chat-row"
      aria-current={selected ? "true" : undefined}
      data-attention={attention || undefined}
      data-waiting={waiting ? waiting.tone : undefined}
      title={c.lastMessageAt ? exactDateTime(c.lastMessageAt) : undefined}
      onClick={() => onSelect(c.id)}
    >
      <span className="ry-chat-av">
        <RhAvatar name={c.name ?? "?"} size={48} />
        <RoyalChannelBadge channel={c.channel} />
      </span>
      <span className="ry-chat-tx">
        <span className="ry-chat-name">{c.name ?? "Без имени"}</span>
        <span className="ry-chat-last">
          {attention && <b className="ry-chat-flag"><Flame aria-hidden="true" />Просит агента · </b>}
          {accountLabel && <span className="ry-chat-acc">{accountLabel} · </span>}
          {last}
        </span>
      </span>
      <span className="ry-chat-rt">
        {waiting
          ? <b className="ry-chat-wait" data-tone={waiting.tone} aria-label={`Ждёт ответа ${waiting.label}`}>{waiting.label}</b>
          : <span className="ry-chat-time">{listTime(c.lastMessageAt)}</span>}
        <span className="ry-chat-marks">
          {c.paused && (
            <span
              className="ry-chat-paused"
              data-tone={pauseHours !== null && pauseHours >= 24 ? "crit" : undefined}
              role="img"
              aria-label={`Бот на паузе${pauseHours ? ` · ${pauseHours} ч` : ""}`}
              title={`Бот на паузе${pauseHours ? ` · ${pauseHours} ч` : ""}`}
            >
              <Bot aria-hidden="true" />
            </span>
          )}
          {unread !== null && (
            <span className="ry-chat-unread" aria-label={unread ? `Непрочитанных сообщений: ${unread}` : "Есть непрочитанное сообщение"}>{unread}</span>
          )}
        </span>
      </span>
    </button>
  );
});
