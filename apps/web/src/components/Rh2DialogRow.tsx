import type { ConversationListItem } from "../hooks/useConversations";
import { channelMeta, initialsFromName } from "../lib/channelMeta";
import { senderPrefix } from "./MessageSenderBadge";
import { rh2AvatarTone } from "../lib/rh2Avatar";
import { exactDateTime, listTime } from "../lib/format";

/**
 * «БОТ НА ПАУЗЕ И ЗАБЫЛИ» (Пачка 17, 12.09.2026) — сколько часов диалог на
 * паузе ждёт живого человека. Тот же признак, что у крона
 * (apps/api/src/lib/botPauseWatch.ts): пауза действует, и последняя реплика —
 * от клиента (awaitingHumanSince). null — ждать некого, бот/агент уже ответили.
 */
function pauseWaitHours(c: ConversationListItem): number | null {
  if (!c.paused || !c.awaitingHumanSince) return null;
  const hours = (Date.now() - new Date(c.awaitingHumanSince).getTime()) / 3_600_000;
  return hours >= 1 ? Math.round(hours) : 0;
}

/**
 * Строка списка диалогов — `.dlg-row` эталона темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/messages.html, `#scr-list`): аватар с
 * инициалами, имя, превью последней реплики, справа время и пометки.
 *
 * Один компонент на десктоп (pages/Messages.tsx) и телефон
 * (components/mobile/MobileChatsList.tsx): эталон рисует ту же строку на обеих
 * ширинах, а две копии со временем разъезжаются — на экранах Oversight это уже
 * происходило дважды.
 *
 * 10.09.2026 (docs/mobile-ux-plan-10-09.md §2, «как в мессенджере»):
 * · значок канала переехал из строки имени в уголок аватара — имя получило всю
 *   ширину, а канал по-прежнему виден с одного взгляда;
 * · время справа короткое (`listTime`: «14:05», «вчера», «10 сент»), полная дата
 *   — в title строки;
 * · чип «Бот на паузе» убран (решение владельца 09.09, docs/theme-2026-missing.md:
 *   управление ботом у агентов забрано, в чатах строка мешает);
 * · метка нашего аккаунта — тихим текстом, а не чипом с фоном: это справка,
 *   а не статус.
 */
export function Rh2DialogRow({
  conversation,
  selected,
  showAccount,
  showPaused = true,
  onSelect,
}: {
  conversation: ConversationListItem;
  selected: boolean;
  /** Метку нашего аккаунта показываем, только когда аккаунтов больше одного И
   *  открыт срез «Все»: в срезе одного аккаунта она повторяет то, что уже
   *  выбрано лентой сверху, и отнимает ширину у имени собеседника. */
  showAccount: boolean;
  /** Чип «Бот на паузе». По умолчанию виден: на компьютере админ и директор
   *  ботом управляют, и это их рабочая подсказка, где он молчит. Телефон
   *  передаёт false — решение владельца 09.09 касалось мобильных чатов и
   *  среза-фильтра, не десктопа (уточнение чата «Оболочка новая» 10.09). */
  showPaused?: boolean;
  onSelect: (id: string) => void;
}) {
  const c = conversation;
  const meta = channelMeta(c.channel);
  const Icon = meta.icon;
  const accountLabel = showAccount ? c.accountTitle : null;
  // Возраст ожидания живого человека при паузе бота (Пачка 17, 12.09.2026):
  // >= 24 ч — тревожный вид, то же пороговое значение, что у крона по
  // умолчанию (botPauseAlertHours), просто как визуальная подсказка в списке.
  const pauseHours = pauseWaitHours(c);

  return (
    <button
      type="button"
      className="dlg-row"
      aria-current={selected ? "true" : undefined}
      data-unread={c.unread || undefined}
      // Клиент попросил живого агента (владелец 18.09.2026) — список уже
      // отсортировал такой диалог первым (см. routes/conversations.ts), здесь
      // только визуальная подсказка: красная обводка + чип ниже.
      data-attention={c.agentAttentionRequestedAt ? true : undefined}
      title={c.lastMessageAt ? exactDateTime(c.lastMessageAt) : undefined}
      onClick={() => onSelect(c.id)}
    >
      {/* Аватар это инициалы имени: фото профиля мессенджеры вебхуком не
          передают, значит это не заглушка, а единственный доступный вариант.
          Значок канала — в его уголке (см. theme-2026-mobile-chat.css). */}
      <span className="av" style={rh2AvatarTone(c.name)}>
        {initialsFromName(c.name)}
        <span className="src" data-channel-badge title={meta.label} aria-label={`Канал: ${meta.label}`}>
          <Icon className="i" />
        </span>
      </span>
      <span className="t">
        <b>{c.name ?? "Без имени"}</b>
        {c.lastMessage && (
          <span className="last">
            {c.lastMessage.role === "assistant" ? `${senderPrefix(c.lastMessage.by)}: ` : ""}
            {c.lastMessage.content}
          </span>
        )}
      </span>
      <span className="rt">
        <span className="meta">{listTime(c.lastMessageAt)}</span>
        {/* «Непрочитано» считает сервер: сбрасывается при открытии диалога
            (readAt) и появляется снова при новом входящем. С 12.09.2026 приходит
            ЧИСЛОМ (`unreadCount` — сколько раз клиент написал после последнего
            ответа), и рисуется капсула `.unread` артефакта. Точка `.dot` (7 px)
            осталась запасным видом для ответа старого сервера без этого поля:
            пустая капсула рисовалась бы чёрным кругом (кадр владельца 09.09,
            docs/mobile-review-09-09.md, пункт 6). */}
        {c.unread &&
          (c.unreadCount && c.unreadCount > 0 ? (
            <span className="unread" aria-label={`Непрочитанных сообщений: ${c.unreadCount}`}>
              {c.unreadCount > 99 ? "99+" : c.unreadCount}
            </span>
          ) : (
            <span className="dot" style={{ background: "var(--lav-ink)" }} aria-label="Есть непрочитанное сообщение" />
          ))}
        {c.agentAttentionRequestedAt && (
          <span className="chip crit" title="Клиент попросил живого агента — бот отвечает вместо вас">
            Просит агента
          </span>
        )}
        {showPaused && c.paused && (
          <span className={`chip ${pauseHours !== null && pauseHours >= 24 ? "crit" : "mute"}`}>
            Бот на паузе{pauseHours !== null && pauseHours > 0 ? ` · ${pauseHours} ч` : ""}
          </span>
        )}
        {/* В какой наш аккаунт написали, видно прямо в строке, чтобы не
            переключать фильтр ради вопроса «это кто кому». */}
        {accountLabel && <span className="acc">{accountLabel}</span>}
      </span>
    </button>
  );
}
