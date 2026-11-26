import { memo } from "react";
import { MESSAGE_PHONE_MASK, describeServiceMarker } from "@royal-home/shared";
import { Bot, Flame, Tag } from "lucide-react";
import type { ConversationListItem } from "../../../hooks/useConversations";
import { exactDateTime, listTime } from "../../../lib/format";
import { RhAvatar } from "../ui";
import { RoyalChannelBadge } from "./RoyalChannelBadge";
import { useAuthStore } from "../../../store/auth";
import { pillTone } from "../tileTone";

/**
 * Сколько ждёт живого человека и насколько это срочно (тот же порог, что в
 * макете: от часа — срочно, больше 15 минут — внимание). null — не ждёт.
 * Чистая функция: проверяется тестом без экрана.
 */
export function chatWaiting(awaitingHumanSince: string | null, now = Date.now()): { label: string; tone: "crit" | "warn" | "calm"; minutes: number } | null {
  if (!awaitingHumanSince) return null;
  const since = new Date(awaitingHumanSince).getTime();
  if (!Number.isFinite(since)) return null;
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  const label = minutes < 1 ? "сейчас" : minutes < 60 ? `${minutes} мин` : minutes < 24 * 60 ? `${Math.floor(minutes / 60)} ч` : `${Math.floor(minutes / 1440)} дн`;
  return { label, tone: minutes >= 60 ? "crit" : minutes > 15 ? "warn" : "calm", minutes };
}

/**
 * Показывать ли ожидание красной/янтарной меткой (решение координатора 18.11):
 * только пока ожидание моложе суток ИЛИ бот на паузе (тогда клиент правда ждёт
 * человека). Давно брошенный разговор без паузы — обычная дата спокойным цветом:
 * серверные плашки «ждёт человека» тоже ограничены сутками.
 */
export function rowWaiting(c: Pick<ConversationListItem, "awaitingHumanSince" | "paused">, now: number) {
  const waiting = chatWaiting(c.awaitingHumanSince, now);
  return waiting && (waiting.minutes < 24 * 60 || c.paused) ? waiting : null;
}

/** Часы паузы бота при ждущем клиенте (то же правило, что у прежней строки и крона botPauseWatch). */
function pauseWaitHours(c: ConversationListItem, now: number): number | null {
  if (!c.paused || !c.awaitingHumanSince) return null;
  const hours = (now - new Date(c.awaitingHumanSince).getTime()) / 3_600_000;
  return hours >= 1 ? Math.round(hours) : 0;
}

/**
 * Текст последней реплики для превью: скрытый номер — словами «номер скрыт», а не «****»
 * (тот же смысл, что в самой переписке; кадр владельца 20.11). Цифр здесь нет и не было.
 * Отдельно от подписи отправителя, чтобы её можно было менять, не трогая текст.
 */
export function previewText(content: string, channel?: string | null): string {
  // Служебная пометка бота — словами (одна функция на все места: @royal-home/shared/serviceMarkers).
  const marker = describeServiceMarker(content, { channel, attachmentsUnknown: true });
  return (marker ?? content).split(MESSAGE_PHONE_MASK).join("номер скрыт");
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
export const RoyalDialogRow = memo(function RoyalDialogRow({ conversation: c, selected, showAccount, onSelect, now, showBotState = false }: {
  conversation: ConversationListItem;
  selected: boolean;
  showAccount: boolean;
  onSelect: (id: string) => void;
  /** Текущая минута от списка (useMinuteClock): строка в memo, и без этого пропа
   *  время ожидания и «вчера» застывали бы до прихода новых данных. */
  now: number;
  /** Значок «бот на паузе» — только руководству (право messages.view): агенту про
   *  бота в чатах ничего не показываем (владелец 20.11.2026, «Эстафета»). */
  showBotState?: boolean;
}) {
  const waiting = rowWaiting(c, now);
  const pauseHours = pauseWaitHours(c, now);
  const unread = c.unread ? (c.unreadCount && c.unreadCount > 0 ? (c.unreadCount > 99 ? "99+" : String(c.unreadCount)) : "") : null;
  const accountLabel = showAccount ? c.accountTitle : null;
  const attention = !!c.agentAttentionRequestedAt;
  const viewerAgentId = useAuthStore((state) => state.agent?.id);
  const last = c.lastMessage
    // «Вы:» — только своё сообщение того, кто смотрит (ревью #332). Ответ бота или
    // коллеги — просто текст, без подписи: как у бизнес-аккаунта WhatsApp, кто
    // именно ответил — в «Сведениях о сообщении» в переписке. Текст — через общий
    // previewText (#328: скрытый номер словами).
    ? `${c.lastMessage.role === "assistant" && c.lastMessage.by?.kind === "agent" && !!viewerAgentId && c.lastMessage.by.agentId === viewerAgentId ? "Вы: " : ""}${previewText(c.lastMessage.content, c.channel)}`
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
        {/* Фото из профиля канала, иначе кружок с буквой; у безымянного: метка интереса («2к») вместо буквы.
            Цвет закреплён за человеком (avatarSeed), а не за именем, которое может смениться. */}
        <RhAvatar name={c.name ?? "?"} src={c.avatarUrl} seed={c.avatarSeed} label={c.unnamed ? c.interest?.badge ?? undefined : undefined} size={48} />
        {c.unnamed && c.interest?.kind === "sell" && <span className="ry-chat-kind" role="img" aria-label="Продаёт"><Tag aria-hidden="true" /></span>}
        <RoyalChannelBadge channel={c.channel} />
      </span>
      <span className="ry-chat-tx">
        <span className="ry-chat-name" title={c.name ?? undefined}>{c.name ?? "Без имени"}</span>
        <span className="ry-chat-last">
          {attention && <b className="ry-chat-flag"><Flame aria-hidden="true" />Просит агента · </b>}
          {accountLabel && <span className="ry-chat-acc">{accountLabel} · </span>}
          {c.unnamed && c.interest?.budget && <span className="ry-chat-acc">{c.interest.budget}{last ? " · " : ""}</span>}
          {last}
        </span>
      </span>
      <span className="ry-chat-rt">
        {waiting
          ? <b className="ry-chat-wait" data-tone={waiting.tone} aria-label={`Ждёт ответа ${waiting.label}`}>{waiting.label}</b>
          : <span className="ry-chat-time">{listTime(c.lastMessageAt)}</span>}
        <span className="ry-chat-marks">
          {c.paused && showBotState && (
            <span
              className="ry-chat-paused"
              data-tone={pauseHours !== null && pauseHours >= 24 ? pillTone("overdue") : undefined}
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
