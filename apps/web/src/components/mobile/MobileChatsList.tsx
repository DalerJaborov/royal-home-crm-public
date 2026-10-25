import { formatWaiting } from "../../lib/formatWaiting";
import { useState } from "react";
import { Search, X } from "lucide-react";
import type { ChatSegment, ConversationFilters, ConversationListItem, ConversationsPage } from "../../hooks/useConversations";
import { channelMeta } from "../../lib/channelMeta";
import { avatarInitial, avatarToneClass } from "../../lib/avatarTone";
import { ChannelIcon, hasChannelGlyph } from "../ChannelIcon";
import { Pagination } from "../Pagination";
import { senderPrefix } from "../MessageSenderBadge";
import { useAuthStore } from "../../store/auth";
import { MhLane, MhListScreen, sinceLabel, type MhLaneChip } from "./mh/MhList";
import { ScreenTabs } from "../ScreenTabs";
import { InboxTabs } from "../SectionTabs";

/**
 * «ЧАТЫ» НА ТЕЛЕФОНЕ — третий артефакт владельца, дословно
 * (docs/pult/theme-2026/artifact-de2845f1-phone-after.html,
 * `<section class="screen" data-screen="chats">`): шапка «Чаты · N» 20 px с
 * круглой лупой, лента срезов `.lane`, список `.list` строками 64 px — аватар
 * с фирменным значком канала в уголке, последняя реплика ОДНОЙ строкой, справа
 * давность и признак непрочитанного.
 *
 * ЧТО ИЗМЕНИЛОСЬ ПРОТИВ ПРЕЖНЕЙ ВЕРСИИ (эталон пульта, `.rh2 .scr`):
 *   · карточка-обёртка `.card > .pane-scroll` вокруг списка убрана — список сам
 *     себе карточка (`.list`), это те же ~50 px структуры, что уже снимали с
 *     поиска и срезов 10.09;
 *   · срезы «Все / Без ответа / Мои / каналы» — одной лентой `.lane` вместо
 *     двух рядов `.seg`: два ряда занимали 88 px и повторяли слово «Все» дважды;
 *   · поиск — кружком в шапке, поле разворачивается по нажатию (постоянная
 *     пилюля отнимала строку);
 *   · значок канала — фирменный (components/ChannelIcon.tsx). Универсальные
 *     иконки lucide рисовали WhatsApp телефонной трубкой, а Telegram стрелкой,
 *     и с 11-пиксельного уголка ни один канал не узнавался.
 *
 * ДАННЫЕ ТЕ ЖЕ. Компонент по-прежнему без единого запроса: всё приходит
 * пропсами из pages/Messages.tsx, счётчики срезов — `counts` из
 * GET /conversations, предупреждения — `alerts` оттуда же.
 *
 * СЧЁТЧИК НЕПРОЧИТАННЫХ — ЧИСЛО (с 12.09.2026). Раньше сервер отдавал только
 * булево `unread`, и капсула артефакта была схлопнута в точку: выдумать «1»
 * было нельзя, а пустая капсула читалась чёрным кругом (кадр владельца 09.09).
 * Теперь API отдаёт `unreadCount` — сколько раз клиент написал после последнего
 * ответа, — и капсула снова с цифрой. Точка осталась запасным видом на случай
 * ответа старого сервера без этого поля.
 *
 * Строка вынесена сюда, а не берётся из components/Rh2DialogRow.tsx: та —
 * `.dlg-row` эталона пульта и остаётся на компьютере без изменений. Разметки
 * разные, области стилей разные (`.rh2 .scr` против `.rh2 .mh`), общий у них
 * только смысл — и он живёт в типе `ConversationListItem`, а не в разметке.
 */
export function MobileChatsList({
  data,
  isLoading,
  error,
  onRetry,
  searchInput,
  onSearchChange,
  channel,
  onChannelChange,
  accountId,
  onAccountChange,
  segment,
  onSegmentChange,
  onSelect,
  onPageChange,
}: {
  data: ConversationsPage | undefined;
  isLoading: boolean;
  error?: unknown;
  onRetry?: () => void;
  searchInput: string;
  onSearchChange: (value: string) => void;
  channel: ConversationFilters["channel"];
  onChannelChange: (channel: ConversationFilters["channel"]) => void;
  accountId: ConversationFilters["accountId"];
  onAccountChange: (accountId: ConversationFilters["accountId"]) => void;
  segment: ChatSegment;
  onSegmentChange: (segment: ChatSegment) => void;
  onSelect: (id: string) => void;
  onPageChange: (page: number) => void;
}) {
  const [searchOpen, setSearchOpen] = useState(!!searchInput);
  // Полоса «Обращения» — тот же набор, что на компьютере (pages/Messages.tsx) и
  // на остальных трёх экранах группы (docs/archive/menu-wave2-brief-15-09.md).
  const conversations = data?.items ?? [];
  const accounts = data?.accounts ?? [];
  const showAccounts = accounts.length > 1;
  const noFilter = !channel && !accountId;
  const channels = [...new Set([...(data?.channels ?? []), ...(channel ? [channel] : [])])].sort();
  // Сервер сам ограничивает выдачу агента его клиентами — здесь только заголовок
  // приводим в соответствие тому, что человек видит.
  const isAgent = useAuthStore((s) => s.agent?.role) === "AGENT";

  /**
   * Одна лента вместо двух рядов: сперва срезы по состоянию диалога (их считает
   * сервер), затем наши аккаунты и каналы. «Все» сбрасывает и то и другое —
   * иначе после переключения среза оставался невидимый фильтр канала.
   */
  const chips: MhLaneChip[] = [
    {
      key: "all",
      label: "Все",
      count: data?.counts?.all ?? null,
      active: segment === "all" && noFilter,
      onSelect: () => {
        onSegmentChange("all");
        onAccountChange(undefined);
        onChannelChange(undefined);
      },
    },
    {
      key: "needsHuman",
      label: "Без ответа",
      count: data?.counts?.needsHuman ?? null,
      active: segment === "needsHuman",
      onSelect: () => onSegmentChange("needsHuman"),
    },
    {
      key: "mine",
      label: "Мои",
      count: data?.counts?.mine ?? null,
      active: segment === "mine",
      onSelect: () => onSegmentChange("mine"),
    },
    // «Бот на паузе» в артефакте не нарисован, но остаётся: на него ведёт
    // ссылка «Посмотреть» из предупреждения ниже, и без чипа выбранный срез
    // никак не показывался бы на экране.
    {
      key: "paused",
      label: "Бот на паузе",
      count: data?.counts?.paused ?? null,
      active: segment === "paused",
      onSelect: () => onSegmentChange("paused"),
    },
    ...(showAccounts
      ? accounts.map(
          (a): MhLaneChip => ({
            key: `acc-${a.id}`,
            label: a.title,
            active: accountId === a.id,
            onSelect: () => {
              onAccountChange(accountId === a.id ? undefined : a.id);
              onChannelChange(undefined);
            },
          })
        )
      : []),
    ...channels.map(
      (c): MhLaneChip => ({
        key: `ch-${c}`,
        label: channelMeta(c).label,
        active: channel === c,
        onSelect: () => {
          onChannelChange(channel === c ? undefined : c);
          onAccountChange(undefined);
        },
      })
    ),
  ];

  return (
    <MhListScreen
      title={isAgent ? "Мои чаты" : "Чаты"}
      count={data?.total ?? null}
      actions={
        <button
          type="button"
          className="ico card"
          aria-label={searchOpen ? "Закрыть поиск" : "Поиск по переписке"}
          aria-expanded={searchOpen}
          onClick={() => {
            setSearchOpen((v) => !v);
            if (searchOpen) onSearchChange("");
          }}
        >
          {searchOpen ? <X className="i" aria-hidden /> : <Search className="i" aria-hidden />}
        </button>
      }
    >
      <InboxTabs />

      {searchOpen && (
        <div className="srch" style={{ padding: "10px 0 0" }}>
          <div className="field">
            <Search className="i" aria-hidden />
            <input
              type="search"
              autoFocus
              value={searchInput}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Имя, номер, слово из переписки"
              aria-label="Поиск по чатам"
            />
          </div>
        </div>
      )}

      {data?.groupedIncomplete && (
        <p className="meta" role="status">Показана часть чатов: найдено больше историй, чем помещается в список. Уточните поиск.</p>
      )}

      <MhLane label="Срезы чатов" chips={chips} />

      {/* Предупреждения — те же, что на ПК (pages/Messages.tsx, 23.09.2026). До
          этого `alerts` приходил и на телефон, но не рисовался: с телефона было
          не видно, что клиент ждёт человека, и нечем «Взять на себя». */}
      {data && (data.alerts.longestWaitingHuman || data.alerts.pausedOverDay.count > 0) && (
        <div className="sec" style={{ marginTop: 10 }}>
          <div className="card-s">
            <div className="quiet" style={{ paddingTop: 14 }}>
              {data.alerts.longestWaitingHuman && (
                <div className="ln">
                  <i className="c" aria-hidden />
                  <span style={{ flex: 1 }}>
                    {data.alerts.longestWaitingHuman.name ?? "Диалог без имени"} ждёт человека{" "}
                    {formatWaiting(data.alerts.longestWaitingHuman.waitingMinutes)}.
                  </span>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => onSelect(data.alerts.longestWaitingHuman!.id)}
                  >
                    Взять на себя
                  </button>
                </div>
              )}
              {data.alerts.pausedOverDay.count > 0 && (
                <div className="ln">
                  <i className="w" aria-hidden />
                  <span style={{ flex: 1 }}>
                    {data.alerts.pausedOverDay.count === 1
                      ? "У одного бот стоит на паузе больше суток"
                      : `У ${data.alerts.pausedOverDay.count} бот стоит на паузе больше суток`}
                  </span>
                  <button type="button" className="btn ghost sm" onClick={() => onSegmentChange("paused")}>
                    Посмотреть
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="sec" style={{ marginTop: 14 }}>
        {/*
          ОШИБКА НЕ СТИРАЕТ УЖЕ ЗАГРУЖЕННЫЙ СПИСОК (19.09.2026, жалоба владельца
          «то дашборд не грузится, то чаты»).

          Раньше здесь стояло `error ? <ошибка> : ...` первым условием, и это
          била не первая загрузка, а ЛЮБОЙ фоновый перезапрос: react-query при
          неудаче ставит статус "error", но ДАННЫЕ в кэше оставляет. То есть
          полностью загруженный список чатов подменялся надписью «Диалоги не
          загрузились» из-за одного неудачного опроса по таймеру — например,
          пока прод на 20-40 секунд пересоздаёт контейнеры при выкате. И висела
          эта надпись до следующего удачного запроса, а не мгновение.

          Теперь ошибка во весь экран — только когда показывать действительно
          нечего; поверх живого списка она остаётся полоской, а текст берётся от
          сервера (иначе «слишком много запросов» не отличить от «сеть легла»).
        */}
        {error && conversations.length > 0 ? (
          <div className="state err" style={{ marginBottom: 8 }}>
            {error instanceof Error ? error.message : "Список не обновился"} — показан прошлый список.{" "}
            <button type="button" className="lnk" onClick={() => onRetry?.()}>
              Обновить
            </button>
          </div>
        ) : null}
        <div className="list">
          {error && conversations.length === 0 ? (
            <div className="state err">
              {error instanceof Error ? error.message : "Диалоги не загрузились."}
              <button type="button" className="lnk" onClick={() => onRetry?.()}>
                Повторить
              </button>
            </div>
          ) : isLoading ? (
            <div className="state">Загружаем диалоги</div>
          ) : conversations.length === 0 ? (
            <div className="state">
              {searchInput
                ? "Никого не нашли, проверьте написание."
                : accountId
                  ? `У аккаунта «${accounts.find((a) => a.id === accountId)?.title ?? ""}» пока нет переписки.`
                  : channel
                    ? `Нет переписки в канале «${channelMeta(channel).label}».`
                    : segment === "needsHuman"
                      ? "Сейчас никто не ждёт ответа — бот отвечает сам."
                      : segment === "paused"
                        ? "Ни один диалог не стоит на паузе."
                        : segment === "mine"
                          ? "У вас пока нет диалогов."
                          : "Как только клиент напишет боту, переписка появится здесь."}
            </div>
          ) : (
            conversations.map((c) => (
              <MhChatRow
                key={c.id}
                conversation={c}
                /* Метка нашего аккаунта — только в срезе «Все»: в любом другом
                   аккаунт уже выбран лентой сверху, и повторение его в КАЖДОЙ
                   строке отнимает ширину у имени (кадр владельца 09.09). */
                showAccount={showAccounts && noFilter}
                onSelect={onSelect}
              />
            ))
          )}
        </div>
      </div>

      {/* «Показать ещё» вместо страниц (решение владельца 15.09.2026): список
          уже накоплен родителем (pages/Messages.tsx, useAccumulatedPages),
          здесь только кнопка, дописывающая следующую страницу в хвост. */}
      {/* Без обёртки «total > pageSize» (02.10.2026): Pagination сама прячется
          на одной странице и сама возвращает страницу за краем выдачи; условие
          ниже только не рисует пустой отступ, а со второй страницы держит её на месте. */}
      {data?.total != null && (data.total > data.pageSize || data.page > 1) && (
        <div className="sec">
          <Pagination variant="loadMore" page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={onPageChange} />
        </div>
      )}
    </MhListScreen>
  );
}

/**
 * Строка диалога артефакта. Аватар — инициал имени в пастельном тоне (фото
 * профиля мессенджеры вебхуком не передают, это не заглушка, а единственное
 * доступное), в его уголке фирменный значок канала.
 */
function MhChatRow({
  conversation: c,
  showAccount,
  onSelect,
}: {
  conversation: ConversationListItem;
  showAccount: boolean;
  onSelect: (id: string) => void;
}) {
  const name = c.name ?? "Без имени";
  const tone = avatarToneClass(name);
  // Красное время — у тех, кто ждёт живого человека: ровно то, что в артефакте
  // помечено `.tm.hot` (там это «41 мин» и «12 мин» у неотвеченных).
  const waiting = !!c.awaitingHumanSince;

  return (
    <button
      type="button"
      className="row"
      // Клиент попросил живого агента (владелец 18.09.2026) — сервер уже
      // поставил такой диалог первым (routes/conversations.ts), здесь только
      // красная полоса + подпись, та же логика, что в Rh2DialogRow.tsx.
      data-attention={c.agentAttentionRequestedAt ? true : undefined}
      onClick={() => onSelect(c.id)}
    >
      <span className={`av ${tone}`} aria-hidden="true">
        {avatarInitial(name)}
        {/* Уголок канала — только когда канал известен. У роли без права
            `clients.viewOrigin` сервер обнуляет `channel` (решение владельца
            17.08), и пустой белый кружок в углу аватара выглядел бы браком. */}
        {hasChannelGlyph(c.channel) && (
          <span className="ch">
            <ChannelIcon channel={c.channel} size={11} />
          </span>
        )}
      </span>
      <span className="b">
        <span className="n">
          <span className="nm">{name}</span>
        </span>
        <span className="s">
          {c.agentAttentionRequestedAt ? (
            <span className="tx" style={{ color: "var(--crit)", fontWeight: 600 }}>
              Просит агента
            </span>
          ) : (
            <span className="tx">
              {c.lastMessage
                ? `${c.lastMessage.role === "assistant" ? `${senderPrefix(c.lastMessage.by)}: ` : ""}${c.lastMessage.content}`
                : "Переписка пуста"}
            </span>
          )}
          {showAccount && c.accountTitle && <span className="tx">· {c.accountTitle}</span>}
        </span>
      </span>
      <span className="r">
        <span className={`tm${waiting ? " hot" : ""}`}>{sinceLabel(c.lastMessageAt)}</span>
        {/* Число непрочитанных сервер считает с 12.09.2026 (`unreadCount` —
            хвост реплик клиента после последнего ответа). Капсула с цифрой, как
            в артефакте; точка `.dot` остаётся запасным видом для ответа старого
            сервера, где числа нет. */}
        {c.unread &&
          (c.unreadCount && c.unreadCount > 0 ? (
            <span className="unread" aria-label={`Непрочитанных сообщений: ${c.unreadCount}`}>
              {c.unreadCount > 99 ? "99+" : c.unreadCount}
            </span>
          ) : (
            <span className="unread dot" aria-label="Есть непрочитанное сообщение" />
          ))}
      </span>
    </button>
  );
}
