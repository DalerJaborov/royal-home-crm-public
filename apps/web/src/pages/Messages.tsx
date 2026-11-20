import { messageTimeText } from "../lib/messageTime";
import { clearIfUnchanged } from "../lib/clearSentText";
import { formatWaiting } from "../lib/formatWaiting";
import { inboxClientConversationId } from "../lib/inboxLink";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type MutableRefObject } from "react";
import { hasMaskablePhone } from "@royal-home/shared";
import { useCan, useIsReadOnly } from "../lib/permissions";
import { useAuthStore } from "../store/auth";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  MessageSquare,
  Paperclip,
  RotateCw,
  Search,
  Video,
} from "lucide-react";
import {
  isWindowClosedError,
  segmentFromFilters,
  useConversation,
  useGroupedConversation,
  useConversations,
  usePauseConversationBot,
  useReplyToConversation,
  useResumeConversationBot,
  useSendVoiceMessage,
  useUploadConversationMediaWithProgress,
  type ChatSegment,
  type ConversationFilters,
  type ConversationsPage,
} from "../hooks/useConversations";
import type { ConversationMessage } from "../types";
import { usePendingMediaUploads } from "../store/mediaUploads";
import { validateOutgoingMediaPick } from "../lib/mediaUpload";
import { useMarkSectionSeen } from "../hooks/useCounters";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { CallClientButton } from "../components/CallClientButton";
import { Pagination } from "../components/Pagination";
import { MessageAttachments } from "../components/MessageAttachments";
import { DeliveryTicks } from "../components/DeliveryTicks";
import { hasVoiceAttachment } from "../lib/voiceAttachment";
import { MessageSenderBadge, senderPrefix } from "../components/MessageSenderBadge";
import { MessageQuote, quotedMessage } from "../components/MessageQuote";
import { VoiceRecordButton } from "../components/VoiceRecordButton";
import { ChatPropertySend } from "../components/ChatPropertySend";
import { BotReplyFeedback } from "../components/BotReplyFeedback";
import { ContactProfilePanel } from "../components/ContactProfilePanel";
import { ConversationClientLink } from "../components/ConversationClientLink";
import { relativeTime } from "../lib/format";
import { dushanbeDate, dushanbeDayLabel, dushanbeTime } from "../lib/date";
import { stripBotHints, humanizeAttachmentTags } from "../lib/botMessages";
import { TranslatableMessageText } from "../components/MessageTranslateToggle";
import { PAUSE_OPTIONS, pausedUntilIso } from "../lib/botPauseOptions";
import { conversationBotState } from "../lib/conversationBotState";
import { useDismissableMenu } from "../hooks/useDismissableMenu";
// Метаданные каналов и инициалы вынесены в lib/channelMeta.ts (мобильный
// редизайн 17.08.2026): их делят десктопный инбокс и мобильный список чатов.
import { channelMeta, initialsFromName } from "../lib/channelMeta";
import { isMessagingWindowClosed, lastInboundMessageAt } from "../lib/messagingWindow";
import { rh2AvatarTone } from "../lib/rh2Avatar";
import { Rh2DialogRow } from "../components/Rh2DialogRow";
import { useNarrowScreen } from "../hooks/useNarrowScreen";
import { useScrollLock } from "../hooks/useScrollLock";
import { useConversationSearch } from "../hooks/useConversationSearch";
import { useCleanChatDraft } from "../hooks/useCleanChatDraft";
import { useChatReadingPosition } from "../hooks/useChatReadingPosition";
import { highlightText } from "../lib/highlightText";
import { MobileChatsList } from "../components/mobile/MobileChatsList";
import { MobileChatView } from "../components/mobile/MobileChatView";
import { useAccumulatedPages } from "../hooks/useAccumulatedPages";
import { ScreenTabs } from "../components/ScreenTabs";
import { InboxTabs } from "../components/SectionTabs";
import { useSellerObject } from "../hooks/useSellerObject";
import { SellerObjectStrip } from "../components/chat/SellerObjectStrip";
import { ChatPhotoViewer } from "../components/chat/ChatPhotoViewer";
import { callbackRequestConversationIds, CustomerRequestsPanel } from "../components/chat/CustomerRequestsPanel";
import { buildChatPhotoList, chatPhotoOffsetForMessage } from "../lib/chatPhotos";
import { useCleanShell } from "../hooks/useCleanShell";
import { CleanInboxFilters } from "../components/chat/CleanInboxFilters";
import { useRoyalLook } from "../hooks/useRoyalLook";
import { RoyalInboxSwitch } from "../components/look/chats/RoyalInboxSwitch";
import { RoyalInboxFilters } from "../components/look/chats/RoyalInboxFilters";
import { RoyalDialogRow } from "../components/look/chats/RoyalDialogRow";
import { useMinuteClock } from "../components/look/chats/useMinuteClock";
import { RoyalSection } from "../components/look/clients/RoyalSection";
import { RoyalChannelBadge } from "../components/look/chats/RoyalChannelBadge";
import { RhAvatar } from "../components/look/ui";
import { RoyalIcon } from "../components/look/RoyalIcon";
import { chatQuickReplies } from "../lib/chatQuickReplies";
import { Bot, Building2, Check, Flame, Info, MoreHorizontal } from "lucide-react";
import { autoReplySourceId, chatTitle, isGroupTail, sameSide } from "../components/look/chats/chatThread";
import { isLongPressTarget, RoyalMessageInfo, RoyalTicks, useLongPress } from "../components/look/chats/RoyalMessageInfo";

/** Сколько последних сообщений рендерим сразу; более ранние — по кнопке сверху,
 *  чтобы диалог на тысячи реплик не подвешивал страницу. История хранится целиком. */
const MESSAGES_CHUNK = 60;

export function replySourceLabels(channels: Array<string | null>): string[] {
  return channels.map((channel, index) => {
    if (!channel) return `Чат ${index + 1}`;
    const label = channelMeta(channel).label;
    return channels.filter((candidate) => candidate === channel).length > 1 ? `${label} ${index + 1}` : label;
  });
}

// Одно правило на три экрана чата — lib/messageTime.ts (пачка D1).
export { messageTimeText };

export function messageRenderKey(message: ConversationMessage, index: number): string {
  const localKey = message.mid ?? `idx:${message.sourceMessageIndex ?? index}`;
  return message.sourceConversationId ? `${message.sourceConversationId}:${localKey}` : message.mid ?? `msg-${index}`;
}

// Scope readable desktop typography to this inbox; shared mobile rows stay intact.
const CLEAN_DESKTOP_INBOX = [
  "rh2 screens clean-messages",
  "[&_.pane-h]:!gap-3 min-[820px]:[&_.pane-h]:!p-5 [&_.pane-h_.t_b]:!text-base [&_.pane-h_.t_span]:!text-sm [&_.pane-b]:!p-4",
  "[&_.dlg-row]:!min-h-[84px] [&_.dlg-row]:!p-4 [&_.dlg-row_.t_b]:!text-base [&_.dlg-row_.last]:!text-sm [&_.dlg-row_.meta]:!text-sm",
  "[&_.bub]:!text-base [&_.bub_.who]:!text-sm [&_.bub_.tm]:!text-sm [&_.compose_textarea]:!text-base",
  "[&_.two]:!gap-5 min-[1180px]:[&_.two]:!grid-cols-[360px_minmax(0,1fr)]",
  "[&_.dlg-row[aria-current=true]]:!border-transparent [&_.dlg-row[aria-current=true]]:!bg-[rgb(var(--rgb-accent)/0.08)]",
].join(" ");




// Подпись разделителя дня («Сегодня»/«Вчера»/дата) — теперь общая
// dushanbeDayLabel из lib/date.ts: её же используют мобильные чаты и звонки.

export function Messages() {
  const can = useCan();
  useMarkSectionSeen("messages");
  // Полоса «Обращения» — тот же набор, что на Комментариях/Звонках/Телефонии
  // (docs/archive/menu-wave2-brief-15-09.md). Хук зовём до ранних return (правило хуков).

  // < lg — мобильный экран «Чаты» по прототипу design_handoff; тот же порог, что
  // делит список и переписку на панели ниже (`hidden md:flex`).
  const narrow = useNarrowScreen();
  const clean = useCleanShell();
  // «Новый вид» (18.11.2026): только поверх чистой оболочки и только по признаку
  // с сервера. Меняет разметку, а не данные: те же запросы, права и действия.
  const royalLook = useRoyalLook();
  const royal = clean && royalLook;
  // 07.09.2026: раздел открыт и по messages.viewOwn — агент видит его суженным до
  // своих клиентов (сужение делает сервер, routes/conversations.ts).
  const noAccess = !can("messages.view") && !can("messages.viewOwn");
  const [filters, setFilters] = useState<ConversationFilters>({ page: 1 });
  // Срез чатов — тот же объект filters, отдельного стейта не заводим: needsHuman/
  // paused/mine уходят в GET /conversations рядом с channel/accountId/q.
  const setSegment = useCallback((segment: ChatSegment) => {
    setFilters((f) => ({
      ...f,
      needsHuman: segment === "needsHuman" ? true : undefined,
      paused: segment === "paused" ? true : undefined,
      mine: segment === "mine" ? true : undefined,
      page: 1,
    }));
  }, []);
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebouncedValue(searchInput, 350);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const locationKey = location.key;
  const navigate = useNavigate();
  const [legacySelectedId, setLegacySelectedId] = useState<string | null>(null);
  // Clean uses the address as its sole selection source: system Back restores
  // the inbox, Forward restores the conversation, and notification links agree.
  const selectedId = clean ? searchParams.get("open") || null : legacySelectedId;
  const selectConversation = (id: string | null) => {
    if (!clean) { setLegacySelectedId(id); return; }
    if (id === selectedId) return;
    const params = new URLSearchParams(searchParams);
    if (id) params.set("open", id);
    else params.delete("open");
    const fromInbox = narrow && !!id && !selectedId;
    setSearchParams(params, {
      replace: !fromInbox,
      state: fromInbox ? { cleanConversationFromInbox: id } : null,
    });
  };
  const closeConversation = () => {
    if (clean && selectedId && location.state?.cleanConversationFromInbox === selectedId) {
      navigate(-1);
      return;
    }
    // A direct notification/deep link has no inbox history entry to return to.
    selectConversation(null);
  };

  // Поиск дебаунсим отдельно от filters, чтобы не дёргать API на каждое нажатие,
  // и сбрасываем на первую страницу при каждом новом запросе.
  useEffect(() => {
    setFilters((f) => ({ ...f, q: debouncedSearch || undefined, page: 1 }));
  }, [debouncedSearch]);

  // enabled: агенту этот эндпоинт отвечает 403 — не ходим за ним вовсе, иначе
  // журнал ошибок засоряется отказами при каждом заходе по прямой ссылке.
  const { data, isLoading, error, refetch } = useConversations({ ...filters, grouped: true }, { enabled: !noAccess });
  const conversations = data?.items;

  // Копим страницы поверх обычной пагинации (решение владельца 15.09.2026):
  // «Показать ещё» дописывает страницу в хвост, а не заменяет список. Один
  // и тот же накопитель — на мобильную ленту и на широкий список, они делят
  // один и тот же запрос выше. Сброс — по всему, что меняет выдачу, кроме
  // самой страницы.
  // Свежая первая страница, пока пролистано дальше неё (аудит №38, useAccumulatedPages).
  const { data: headPage } = useConversations(
    { ...filters, page: 1, grouped: true },
    { enabled: !noAccess && (filters.page ?? 1) > 1 }
  );
  const feedItems = useAccumulatedPages(
    data?.items,
    filters.page ?? 1,
    JSON.stringify({ ...filters, page: undefined }),
    headPage?.items
  );
  const feedData = data ? { ...data, items: feedItems } : data;

  // Взведён, когда стартовый выбор диалога (по ссылке ?open= или автовыбор первого
  // в списке ниже) уже случился — оба места используют один и тот же флаг, чтобы
  // не перезаписывать друг друга (см. оба эффекта ниже).
  const autoSelectedRef = useRef(false);

  /**
   * ГЛУБОКАЯ ССЫЛКА `?open=<id>` (02.09.2026). Пуш о брошенном диалоге (нужен
   * живой сотрудник — MAX_PHONE_ASKS в conversation.ts) и ссылка в «Здоровье
   * системы» раньше вели просто на /health: чтобы найти сам диалог, приходилось
   * искать его руками среди 600+ переписок по GUID из текста ошибки — то есть
   * ровно то ручное каждодневное открытие каждого чата, которого хотели избежать.
   *
   * useConversation(id) тянет диалог по id независимо от того, попал ли он в
   * текущую страницу списка — поэтому достаточно выставить selectedId, грузить
   * отдельно ничего не нужно. Работает и на мобильном (без проверки ширины
   * экрана ниже — директор может открыть пуш и с телефона).
   *
   * autoSelectedRef взводим здесь же, чтобы следующий эффект (автовыбор первого
   * диалога) не перезаписал выбор по ссылке.
   */
  useEffect(() => {
    if (clean) return;
    const openId = searchParams.get("open");
    if (openId) {
      autoSelectedRef.current = true;
      setLegacySelectedId(openId);
    }
    // A second push can open another conversation while Chats is already open.
    // The navigation key also handles reopening the same link after mobile Back.
  }, [searchParams, locationKey, clean]);

  // На первом заходе на десктопе открываем самый свежий диалог. Только один раз —
  // иначе на мобильном кнопка «Назад» (обнуляет selectedId) тут же ловила этот же
  // эффект и мгновенно открывала диалог обратно, кнопка выглядела полностью мёртвой.
  useEffect(() => {
    if (autoSelectedRef.current) return;
    /**
     * ТОЛЬКО НА ШИРОКОМ ЭКРАНЕ (≥820px, порог совпадает с `md:` ниже, который
     * решает — список и чат рядом двумя колонками или по одной панели за раз).
     * Комментарий выше говорил «на первом заходе на десктопе», но проверки
     * ширины не было, и автовыбор срабатывал везде. На узком экране список
     * диалогов при выбранном разговоре скрывается (`hidden md:flex` ниже),
     * поэтому раздел «Сообщения» открывался сразу ВНУТРИ последней переписки:
     * чтобы увидеть список, поиск и фильтр по каналу, нужно было сначала нажать
     * «← Назад».
     */
    if (!window.matchMedia("(min-width: 820px)").matches) return;
    if (!selectedId && conversations && conversations.length > 0) {
      autoSelectedRef.current = true;
      if (clean) {
        setSearchParams((current) => {
          const params = new URLSearchParams(current);
          params.set("open", conversations[0].id);
          return params;
        }, { replace: true });
      } else setLegacySelectedId(conversations[0].id);
    }
  }, [conversations, selectedId, clean, setSearchParams]);

  /**
   * ПОЛНАЯ ЗАГЛУШКА «ПОКА НЕТ ДИАЛОГОВ» — только когда диалогов нет ВООБЩЕ, без
   * единого активного фильтра (16.08.2026, найдено по жалобе владельца: «нажал
   * на аккаунт — всё пропало»).
   *
   * Было: проверялся только текстовый поиск (`filters.q`), а `accountId` и
   * `channel` — нет. Стоило выбрать «Royal Home Info» (или канал без сообщений),
   * список закономерно пустел, и вся заглушка вместе с поиском, переключателем
   * аккаунтов и списком каналов ПОДМЕНЯЛА собой весь экран — не было даже кнопки
   * вернуться к «Все аккаунты». Владелец решил, что переписка исчезла, хотя её
   * просто не было у выбранного фильтра.
   *
   * Теперь при активном фильтре с нулевым результатом рисуется обычный список
   * (см. ниже) — он сам показывает «Диалогов нет» ВНУТРИ своей рамки, не убирая
   * ни поиск, ни переключатели.
   */
  const noFiltersActive =
    !filters.q && !filters.accountId && !filters.channel && !filters.needsHuman && !filters.paused && !filters.mine;
  const isEmptyOverall = !isLoading && !error && noFiltersActive && (!conversations || conversations.length === 0) && filters.page === 1;

  // Проверка роли стоит ПОСЛЕ всех хуков намеренно. Раньше здесь был ранний return
  // до useState/useEffect: стоило директору сменить сотруднику роль, как ближайшее
  // обновление токена (refreshAccessToken → updateAgent) перерисовывало компонент с
  // другим числом хуков, React бросал «Rendered fewer hooks than expected», и без
  // ErrorBoundary это давало белый экран всего приложения.
  // Ссылка в сайдбаре агенту не показывается, но защищаемся и от прямого перехода
  // по URL — сервер всё равно откажет (403), это честное сообщение вместо ошибок.
  if (noAccess) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Чаты</h1>
              {/* 07.09.2026: агенту раздел уже открыт (messages.viewOwn) — этот экран видят
                  только роли без ЛЮБОГО из двух прав (маркетолог, монтажёр и т.п.). */}
              <p className="sub">
                Раздел доступен руководству и агентам по их клиентам. У вашей роли этого права нет.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /**
   * МОБИЛЬНАЯ ВЕТКА (< lg) — точная копия экранов `isChats`/`vChat` прототипа
   * design_handoff (хендофф мобильного редизайна 17.08.2026): один экран за раз,
   * список чатов карточками или переписка на всю высоту. Ветка выбирается в JS,
   * а не парой скрытых панелей: иначе обе версии ходили бы в сеть и рендерили
   * DOM одновременно, а спрятанная переписка продолжала бы поллинг раз в 8с.
   * Десктоп ≥820px ниже не тронут — те же две панели, что и раньше.
   */
  if (narrow && !clean) {
    return selectedId ? (
      <MobileChatView key={selectedId} id={selectedId} onBack={closeConversation} onPromoteToClient={(clientId) => selectConversation(inboxClientConversationId(clientId))} />
    ) : (
      <MobileChatsList
        data={feedData}
        isLoading={isLoading}
        error={error}
        onRetry={() => refetch()}
        searchInput={searchInput}
        onSearchChange={setSearchInput}
        channel={filters.channel}
        onChannelChange={(channel) => setFilters((f) => ({ ...f, channel, page: 1 }))}
        accountId={filters.accountId}
        onAccountChange={(accountId) => setFilters((f) => ({ ...f, accountId, page: 1 }))}
        segment={segmentFromFilters(filters)}
        onSegmentChange={setSegment}
        onSelect={setLegacySelectedId}
        onPageChange={(page) => setFilters((f) => ({ ...f, page }))}
      />
    );
  }

  return (
    // Метка раздела «Нового вида» (общий механизм RoyalSection): слой
    // theme-look-royal-chats.css действует только под [data-ry-section="chats"];
    // шторки и окна, открытые из чатов через Rh2Portal, получают ту же метку.
    <RoyalSection name={royal ? "chats" : undefined}>
    <div className={royal ? "rh2 screens clean-messages ry-chats" : clean ? CLEAN_DESKTOP_INBOX : "rh2 screens"} data-chat-active={selectedId ? "thread" : "list"} data-ry-section={royal ? "chats" : undefined}>
      <div className="scr">
        {royal ? <RoyalInboxSwitch title="Чаты" /> : <>
        <div className={clean ? "sr-only" : "pg-h"}>
          <div>
            <h1>Чаты</h1>
            <p className="sub">
              {data?.total != null ? `${data.total} диалогов. ` : data?.groupedIncomplete ? "Показана часть чатов. " : ""}
              {clean ? "Все каналы в одном месте. Откройте диалог, чтобы увидеть историю и ответить клиенту." : "Переписка ИИ-бота с клиентами из мессенджеров. Можно вмешаться, бот встанет на паузу."}
            </p>
          </div>
        </div>

        <div className="clean-inbox-workspaces"><InboxTabs /></div>
        </>}

      {/* Предупреждения сверху (эталон, messages.html, `.quiet.crit`/`.quiet.warn`) —
          шаг 5 переноса, 10.09.2026: GET /conversations теперь отдаёт `alerts`
          (apps/api/src/routes/conversations.ts, loadInboxAlerts) — самый долго
          ждущий диалог и число диалогов на паузе больше суток. */}
      {!clean && !error && !isEmptyOverall && data && (data.alerts.longestWaitingHuman || data.alerts.pausedOverDay.count > 0) && (
        <div className="card tight clean-inbox-alerts">
          {data.alerts.longestWaitingHuman && (
            <div className="quiet crit">
              <span className="dot crit"></span>
              <span className="txt">
                {data.alerts.longestWaitingHuman.name ?? "Диалог без имени"} ждёт человека{" "}
                {formatWaiting(data.alerts.longestWaitingHuman.waitingMinutes)}.
              </span>
              <button
                type="button"
                className="pill ghost sm"
                onClick={() => setLegacySelectedId(data.alerts.longestWaitingHuman!.id)}
              >
                Взять на себя
              </button>
            </div>
          )}
          {data.alerts.pausedOverDay.count > 0 && (
            <div className="quiet warn">
              <span className="dot warn"></span>
              <span className="txt">
                {data.alerts.pausedOverDay.count === 1
                  ? "У одного бот стоит на паузе больше суток"
                  : `У ${data.alerts.pausedOverDay.count} бот стоит на паузе больше суток`}
                {data.alerts.pausedOverDay.names.length > 0 && `: ${data.alerts.pausedOverDay.names.join(", ")}`}
              </span>
              <button type="button" className="lnk" onClick={() => setSegment("paused")}>
                Посмотреть
              </button>
            </div>
          )}
        </div>
      )}

      {/*
        ОШИБКА ВО ВЕСЬ ЭКРАН — ТОЛЬКО КОГДА ПОКАЗЫВАТЬ НЕЧЕГО (19.09.2026).
        react-query при неудачном ФОНОВОМ перезапросе ставит статус "error", но
        данные в кэше оставляет: с прежним `error ?` первым условием один
        неудачный опрос по таймеру (например, пока прод пересоздаёт контейнеры
        на выкате) стирал уже открытую переписку и оставлял «не загрузилось»
        до следующего удачного запроса. Разбор — жалоба владельца «то дашборд
        не грузится, то чаты».
      */}
      {error && !conversations?.length ? (
        /* Состояние ошибки — строкой эталона (`.state.err`), а не плашкой:
           срочное в этой теме подаётся тихой строкой (договор §6.1, §6.12). */
        <div className="card tight">
          <div className="state err">
            <span className="dot crit"></span>
            {error instanceof Error ? error.message : "Переписка не загрузилась."}
            <button
              type="button"
              className="lnk"
              style={{ color: "inherit", textDecoration: "underline" }}
              onClick={() => refetch()}
            >
              Повторить
            </button>
          </div>
        </div>
      ) : isEmptyOverall ? (
        <div className="card tight">
          <div className="empty">
            <span className="ic">
              <MessageSquare className="i" />
            </span>
            <p>{royal ? "Переписок пока нет" : "Пока нет диалогов. Как только клиент напишет боту в Instagram или WhatsApp, переписка появится здесь."}</p>
          </div>
        </div>
      ) : (
        /**
         * ОДНА ПАНЕЛЬ ЗА РАЗ НА УЗКОМ ЭКРАНЕ (< lg, хендофф мобильного редизайна
         * 17.08.2026). Список диалогов и открытый диалог — это два самостоятельных
         * «экрана» в терминах телефона: на 375px они не сжимаются в две колонки
         * (список нечитаем, чат остаётся без места на пузыри), а показываются по
         * очереди — как в любом мессенджере. Переключатель — `selectedId`: пусто —
         * виден список, что-то выбрано — виден диалог на всю ширину с кнопкой
         * «← Назад» в его шапке (см. ConversationView). На ≥820px (`md:`) обе
         * панели видны одновременно, как раньше — это порог, с которого хватает
         * места на список 320px и читаемый диалог рядом.
         */
        <div className="two" data-conversation-selected={!!selectedId || undefined}>
          <ConversationList
            clean={clean}
            royal={royal}
            data={feedData}
            isLoading={isLoading}
            error={error}
            onRetry={() => refetch()}
            searchInput={searchInput}
            onSearchChange={setSearchInput}
            channel={filters.channel}
            onChannelChange={(channel) => setFilters((f) => ({ ...f, channel, page: 1 }))}
            accountId={filters.accountId}
            onAccountChange={(accountId) => setFilters((f) => ({ ...f, accountId, page: 1 }))}
            segment={segmentFromFilters(filters)}
            onSegmentChange={setSegment}
            selectedId={selectedId}
            onSelect={(id) => { autoSelectedRef.current = true; selectConversation(id); }}
            onPageChange={(page) => setFilters((f) => ({ ...f, page }))}
          />
          {/* key=id — принудительный ремонт при смене диалога: без него состояние ошибки
              неудачной отправки (useReplyToConversation) переживало переключение и
              показывало «не удалось отправить» под совсем другим, ещё не тронутым диалогом. */}
          {selectedId && <ConversationView key={selectedId} id={selectedId} clean={clean} royal={royal} onBack={closeConversation} onPromoteToClient={(clientId) => selectConversation(inboxClientConversationId(clientId))} />}
          {clean && !selectedId && <section className="card clean-conversation clean-conversation-placeholder" aria-label="Переписка">
            {royal
              ? <div className="ry-chat-empty"><span className="ry-circle" data-tone="a1" aria-hidden="true"><RoyalIcon name="messages-square" /></span><h2>Выберите переписку</h2></div>
              : <div className="clean-chat-empty"><MessageSquare className="i" aria-hidden="true" /><h2>Выберите диалог</h2><p>Сообщения, вложения и данные клиента откроются здесь. Черновик сохраняется отдельно для каждого диалога.</p></div>}
          </section>}
        </div>
      )}
      </div>
    </div>
    </RoyalSection>
  );
}

/**
 * ЛЕВАЯ ПАНЕЛЬ СПИСКА ДИАЛОГОВ — разметка эталона темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/messages.html, секция `#scr-list`): карточка
 * `.card` внутри сетки `.two`, шапка `.pane-h`, поиск и срезы в `.pane-b`,
 * строки `.dlg-row` в прокручиваемом `.pane-scroll`, пагинация внизу.
 *
 * Имена классов прототипные, свои не выдумываются: стили приходят из
 * theme-2026-proto.css, ограниченного областью `.rh2`. Данные, фильтры и
 * запросы те же, что были: изменилась только одежда.
 */

function ConversationList({
  clean = false,
  royal = false,
  data,
  isLoading,
  error,
  onRetry,
  searchInput,
  onSearchChange,
  channel,
  accountId,
  onAccountChange,
  onChannelChange,
  segment,
  onSegmentChange,
  selectedId,
  onSelect,
  onPageChange,
}: {
  clean?: boolean;
  /** «Новый вид»: та же выдача и те же фильтры, другая разметка (18.11.2026). */
  royal?: boolean;
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
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPageChange: (page: number) => void;
}) {
  const conversations = data?.items ?? [];
  const accounts = data?.accounts ?? [];
  const showAccounts = accounts.length > 1;
  const noFilter = !channel && !accountId;
  const channels = [...new Set([...(data?.channels ?? []), ...(channel ? [channel] : [])])].sort();
  // Стабильный обработчик выбора для строк нового вида (memo): ввод в поиск
  // перерисовывает родителя, но не каждую строку списка (замер — в журнале 18.11.2026).
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const selectStable = useCallback((id: string) => onSelectRef.current(id), []);
  const alerts = royal ? data?.alerts : undefined;
  // Минутные часы для строк нового вида (ожидание, «вчера»); в прежнем виде не тикают.
  const now = useMinuteClock(royal);
  // Состояние бота в строках списка — только руководству (как и управление ботом).
  const canSeeBotState = useCan()("messages.view");

  return (
    <section className="card" aria-label="Диалоги">
      {!royal && <div className="pane-h">
        <div className="t">
          <b>{clean ? "Входящие" : "Диалоги"}</b>
          <span>{data?.total != null ? `${data.total} всего` : data?.groupedIncomplete ? "Чатов много" : "загружаем"}</span>
        </div>
      </div>}

      <div className="pane-b">
        <input
          className="inp"
          style={{ width: "100%", maxWidth: "none" }}
          type="search"
          value={searchInput}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Имя, номер, слово из переписки"
          aria-label="Поиск по чатам"
        />
        {data?.groupedIncomplete && (
          <p className="meta" role="status" style={{ marginTop: 8 }}>
            Показана часть чатов: найдено больше историй, чем помещается в список. Уточните поиск.
          </p>
        )}
        {/* Срез «Все / Ждут человека / Бот на паузе / Мои» (эталон `#tpl-messages`,
            шаг 5 переноса, 10.09.2026) — счётчики из GET /conversations `counts`
            (apps/api/src/routes/conversations.ts, loadSegmentCounts), а не
            выдуманные числа. Отдельная лента `.seg` от фильтра по каналу/аккаунту
            ниже: срезы взаимоисключающие сами по себе, но независимы от канала. */}
        {royal ? (data && (
          <RoyalInboxFilters
            segment={segment}
            counts={data.counts}
            onSegmentChange={onSegmentChange}
            moreActive={segment === "paused" || !!channel || !!accountId}
          >
            <button
              type="button"
              className="ry-chats-chip"
              aria-pressed={segment === "paused"}
              onClick={() => onSegmentChange(segment === "paused" ? "all" : "paused")}
            >
              <Bot aria-hidden="true" />Бот на паузе<b className="ry-num">{data.counts?.paused ?? "—"}</b>
            </button>
            <CleanInboxFilters open channels={channels} accounts={accounts} channel={channel} accountId={accountId} onChannelChange={onChannelChange} onAccountChange={onAccountChange} />
          </RoyalInboxFilters>
        )) : <>
        {data && (
          <div style={{ marginTop: 12 }}>
            <div className={clean ? "seg !flex-wrap [&_button]:!min-h-11 [&_button]:!text-sm" : "seg"} role="tablist" aria-label="Срезы диалогов">
              <button type="button" role="tab" aria-selected={segment === "all"} onClick={() => onSegmentChange("all")}>
                Все <span className="n">{data.counts?.all ?? "—"}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={segment === "needsHuman"}
                onClick={() => onSegmentChange("needsHuman")}
              >
                Ждут человека <span className="n">{data.counts?.needsHuman ?? "—"}</span>
              </button>
              <button type="button" role="tab" aria-selected={segment === "paused"} onClick={() => onSegmentChange("paused")}>
                Бот на паузе <span className="n">{data.counts?.paused ?? "—"}</span>
              </button>
              <button type="button" role="tab" aria-selected={segment === "mine"} onClick={() => onSegmentChange("mine")}>
                Мои <span className="n">{data.counts?.mine ?? "—"}</span>
              </button>
            </div>
          </div>
        )}
        {/*
          СРЕЗЫ ВМЕСТО ВЫПАДАЮЩЕГО СПИСКА (эталон, `.seg` в `#scr-list`). Раньше
          канал и наш аккаунт выбирались одним `select`; фильтры остались ровно те
          же (взаимоисключающие: аккаунт уже подразумевает свой канал), поменялась
          только их подача, кнопками, как в прототипе.
        */}
        {clean ? <CleanInboxFilters channels={channels} accounts={accounts} channel={channel} accountId={accountId} onChannelChange={onChannelChange} onAccountChange={onAccountChange} /> : <><div style={{ marginTop: 12 }}>
          <div className="sec-t" style={{ marginBottom: 6 }}>Канал</div>
          <div className="seg" role="tablist" aria-label="Канал">
            <button
              type="button"
              role="tab"
              aria-selected={noFilter}
              onClick={() => {
                onAccountChange(undefined);
                onChannelChange(undefined);
              }}
            >
              Все каналы
            </button>
            {/* Список каналов приходит с сервера и строится из данных: новый канал
                появляется здесь сам, без правки кода. */}
            {channels.map((c) => (
              <button
                key={c}
                type="button"
                role="tab"
                aria-selected={channel === c}
                onClick={() => {
                  onChannelChange(channel === c ? undefined : c);
                  onAccountChange(undefined);
                }}
              >
                {channelMeta(c).label}
              </button>
            ))}
          </div>
        </div>
        {/* Наши аккаунты (Royal Home / Royal Home Info) — отдельной строкой и
            только когда их больше одного: с единственным выбирать не из чего.
            Повторный клик снимает выбор. */}
        {showAccounts && (
          <div style={{ marginTop: 12 }}>
            <div className="sec-t" style={{ marginBottom: 6 }}>Наш аккаунт</div>
            <div className="seg" role="tablist" aria-label="Наш аккаунт">
              {accounts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="tab"
                  aria-selected={accountId === a.id}
                  onClick={() => {
                    onAccountChange(accountId === a.id ? undefined : a.id);
                    onChannelChange(undefined);
                  }}
                >
                  {a.title}
                </button>
              ))}
            </div>
          </div>
        )}
        </>}
        </>}
      </div>

      {/* «Ждёт человека» и «пауза больше суток» — те же поля ответа списка, что у
          прежней плашки над инбоксом; в новом виде — двумя тихими строками в
          колонке списка, со своими действиями («Взять на себя», «Посмотреть»). */}
      {alerts && (alerts.longestWaitingHuman || alerts.pausedOverDay.count > 0) && (
        <div className="ry-chats-alerts">
          {alerts.longestWaitingHuman && (
            <div className="ry-chats-alert" data-tone="crit">
              <span className="ry-chats-alert-ic" aria-hidden="true"><Flame /></span>
              <span className="ry-chats-alert-tx">
                <b>{alerts.longestWaitingHuman.name ?? "Диалог без имени"}</b> ждёт человека {formatWaiting(alerts.longestWaitingHuman.waitingMinutes)}
              </span>
              <button type="button" onClick={() => selectStable(alerts.longestWaitingHuman!.id)}>Взять на себя</button>
            </div>
          )}
          {alerts.pausedOverDay.count > 0 && (
            <div className="ry-chats-alert" data-tone="warn">
              <span className="ry-chats-alert-ic" aria-hidden="true"><Bot /></span>
              <span className="ry-chats-alert-tx">
                {alerts.pausedOverDay.count === 1
                  ? "У одного бот на паузе больше суток"
                  : `У ${alerts.pausedOverDay.count} бот на паузе больше суток`}
                {alerts.pausedOverDay.names.length > 0 && `: ${alerts.pausedOverDay.names.join(", ")}`}
              </span>
              <button type="button" onClick={() => onSegmentChange("paused")}>Посмотреть</button>
            </div>
          )}
        </div>
      )}

      <div className="pane-scroll">
        {error && conversations.length > 0 ? (
          <div className="pane-b">
            <div className="state err">
              <span className="dot crit"></span>
              {error instanceof Error ? error.message : "Список не обновился"} — показан прошлый список.
              <button
                type="button"
                className="lnk"
                style={{ color: "inherit", textDecoration: "underline" }}
                onClick={() => onRetry?.()}
              >
                Обновить
              </button>
            </div>
          </div>
        ) : null}
        {error && conversations.length === 0 ? (
          <div className="pane-b">
            <div className="state err">
              <span className="dot crit"></span>
              {error instanceof Error ? error.message : "Диалоги не загрузились."}
              <button
                type="button"
                className="lnk"
                style={{ color: "inherit", textDecoration: "underline" }}
                onClick={() => onRetry?.()}
              >
                Повторить
              </button>
            </div>
          </div>
        ) : isLoading ? (
          <div className="pane-b">
            <div className="state">
              <span className="sk av"></span>
              <span className="sk w28"></span>
              <span className="sk w22"></span>
              Загружаем диалоги
            </div>
          </div>
        ) : conversations.length === 0 ? (
          /**
           * ПРИЧИНА ПУСТОГО СПИСКА СЛОВАМИ (16.08.2026). У аккаунта пусто чаще
           * всего значит: старые диалоги этого канала завелись ДО того, как в CRM
           * появилось несколько аккаунтов, и вебхук резолвил их на основной
           * аккаунт. Кнопка сброса нужна, чтобы не гадать, как вернуться.
           */
          <div className="pane-b">
            <div className="empty">
              <p>
                {searchInput
                  ? "Ничего не найдено."
                  : accountId
                    ? `У аккаунта «${accounts.find((a) => a.id === accountId)?.title ?? ""}» пока нет переписки.`
                    : channel
                      ? `Нет переписки в канале «${channelMeta(channel).label}».`
                      : segment === "needsHuman"
                        ? "Сейчас никто не ждёт человека — бот отвечает сам."
                        : segment === "paused"
                          ? "Ни один диалог не стоит на паузе."
                          : segment === "mine"
                            ? "У вас пока нет диалогов."
                            : "Диалогов нет."}
              </p>
              {(accountId || channel || segment !== "all") && !searchInput && (
                <button
                  type="button"
                  className="pill ghost"
                  onClick={() => {
                    onAccountChange(undefined);
                    onChannelChange(undefined);
                    onSegmentChange("all");
                  }}
                >
                  Показать все
                </button>
              )}
            </div>
          </div>
        ) : royal ? (
          conversations.map((c) => (
            <RoyalDialogRow
              key={c.id}
              conversation={c}
              selected={selectedId === c.id}
              showAccount={showAccounts && noFilter}
              onSelect={selectStable}
              now={now}
              showBotState={canSeeBotState}
            />
          ))
        ) : (
          conversations.map((c) => (
            <Rh2DialogRow
              key={c.id}
              conversation={c}
              selected={selectedId === c.id}
              /* Только в срезе «Все»: в остальных аккаунт уже выбран лентой
                 сверху, а чип в каждой строке съедал ширину имени. */
              showAccount={showAccounts && noFilter}
              onSelect={onSelect}
            />
          ))
        )}
      </div>

      {data?.total != null && (
        <div className="pane-b" style={{ borderTop: "1px solid var(--line-soft)" }}>
          <Pagination
            variant="loadMore"
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onPageChange={onPageChange}
          />
        </div>
      )}
    </section>
  );
}

/** «Произвольно…» в селектах паузы: спрашивает минуты; null = отменили/ерунда. */
function promptCustomPauseMinutes(): number | null {
  const raw = window.prompt("На сколько минут поставить бота на паузу?", "45");
  if (raw === null) return null;
  const minutes = Math.round(Number(raw.replace(",", ".")));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60 * 24 * 365) return null;
  return minutes;
}

/**
 * ЛЕНТА СООБЩЕНИЙ ИНБОКСА — ОТДЕЛЬНЫЙ memo-КОМПОНЕНТ (06.09.2026, тот же приём,
 * что и ChatMessageList в ClientChatPanel.tsx).
 *
 * Раньше вся история рендерилась прямо в теле ConversationView — том же
 * компоненте, что держит состояние поля ввода `text`. Каждое нажатие клавиши
 * перерисовывало не только textarea, но и весь map по сообщениям (разделители
 * дня, группировка подряд идущих реплик, цитаты, вложения) — на переписке в
 * сотни сообщений это заметная лишняя работа на каждый символ.
 *
 * Объявлен на МОДУЛЬНОМ уровне, не внутри ConversationView — иначе новый тип
 * функции на каждый рендер родителя обнулял бы React.memo. Родитель передаёт
 * `allMessages` (полный массив — нужен целиком для поиска цитаты quotedMessage)
 * и `visibleMessages` (видимый хвост); оба меняются только при смене диалога
 * или догрузке истории, но НЕ при печати. `onShowMore` обёрнут в useCallback в
 * родителе по той же причине. Пузыри загружаемых фото/видео (pendingUploads)
 * рендерятся тут же — они часть той же ленты — и передаются отдельным пропом,
 * не участвующим в переписке.
 *
 * Прокрутка (`scrollRef`, автоскролл «только если человек и так внизу») осталась
 * в ConversationView: сам скроллируемый контейнер и его ref не переехали сюда.
 *
 * ОДЕЖДА — ЭТАЛОН ТЕМЫ 2026 (screens/messages.html, `#thread`): пузырь `.bub`,
 * свой ответ `.bub.me`, реплика бота `.bub.me.bot` (пунктирная рамка), подпись
 * отправителя `.who`, время `.tm`, разделитель дня `.day`.
 */
const ConversationMessageList = memo(function ConversationMessageList({
  allMessages,
  visibleMessages,
  hiddenCount,
  onShowMore,
  pendingUploads,
  onRetryUpload,
  onCancelUpload,
  searchQuery,
  activeSearchIndex,
  messageRefs,
  clientId,
  conversationId,
  onOpenPhoto,
  readOnly,
  royal = false,
  multiChannel = true,
  defaultChannel = null,
  onOpenInfo,
}: {
  /** Новый вид: метка канала в пузыре — только когда каналов несколько или канал сменился. */
  royal?: boolean;
  multiChannel?: boolean;
  /** Канал разговора — для подписи «посмотрите в WhatsApp» у служебной пометки, когда у реплики своего канала нет. */
  defaultChannel?: string | null;
  /** Новый вид: «Сведения о сообщении» по абсолютному индексу (стабильная функция). */
  onOpenInfo?: (absoluteIndex: number) => void;
  allMessages: ConversationMessage[];
  visibleMessages: ConversationMessage[];
  hiddenCount: number;
  onShowMore: () => void;
  pendingUploads: ReturnType<typeof usePendingMediaUploads>;
  onRetryUpload: (u: ReturnType<typeof usePendingMediaUploads>[number]) => void;
  onCancelUpload: (localId: string) => void;
  /** Непусто — подсвечивать найденные поиском вхождения (см. ConversationView). */
  searchQuery: string;
  /** Абсолютный индекс активного (не просто найденного) совпадения. */
  activeSearchIndex: number | null;
  /** Ссылки на пузыри по абсолютному индексу — только для скролла к найденному. */
  messageRefs: MutableRefObject<Map<number, HTMLDivElement>>;
  /** Для кнопки звонка на месте маски телефона (MessageText). Не меняется при
   *  печати — тот же диалог, тот же клиент, — так что мемоизация не страдает.
   *  null у диалога без карточки (общая очередь разбора, ещё не сопоставлен). */
  clientId: string | null;
  /** Для «Показать перевод на русский» (TranslatableMessageText) — тот же id,
   *  которым useConversation(id) поднял этот диалог. */
  conversationId: string;
  readOnly: boolean;
  /** Открыть просмотрщик ВСЕХ фото переписки (21.09.2026) на кадре
   *  `imageIndexInMessage` этого сообщения — родитель прибавляет смещение по
   *  предыдущим сообщениям (chatPhotoOffsetForMessage) и открывает ChatPhotoViewer. */
  onOpenPhoto: (absoluteMessageIndex: number, imageIndexInMessage: number) => void;
}) {
  const viewerAgentId = useAuthStore((s) => s.agent?.id);
  // Новый вид: какие реплики вообще рисуются (пустая служебная — нет). Хвостик и
  // слитый отступ считаются по СОСЕДНЕЙ ВИДИМОЙ реплике, а не по соседу в массиве.
  const shown = useMemo(
    () => (royal ? visibleMessages.map((m) => !!humanizeAttachmentTags(m.role === "user" ? stripBotHints(m.content) : m.content, { outgoing: m.role !== "user", hasAttachments: !!m.attachments?.length }) || !!m.attachments?.length) : []),
    [royal, visibleMessages],
  );
  return (
    <>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={onShowMore}
          className="pill ghost sm"
          style={{ alignSelf: "center" }}
        >
          Показать более ранние ({hiddenCount})
        </button>
      )}
      {visibleMessages.map((m, i) => {
        // Реплика клиента — без служебных подсказок боту: до 02.08.2026 они
        // дописывались прямо в текст и до сих пор лежат в старых записях
        // (см. lib/botMessages.ts). Ответы бота показываем как есть.
        const content = humanizeAttachmentTags(m.role === "user" ? stripBotHints(m.content) : m.content, {
          outgoing: m.role !== "user",
          hasAttachments: !!m.attachments?.length,
          channel: m.sourceChannel ?? defaultChannel,
        });
        // От сообщения осталась одна подсказка и ничего больше — показывать
        // пустой пузырь незачем, вложения при этом сохраняем.
        if (!content && !m.attachments?.length) return null;
        /**
         * РАЗДЕЛИТЕЛЬ ДНЯ (16.08.2026, по замечанию владельца: «не показывает
         * время и дату, непонятно, кто когда писал»).
         *
         * Ставится, только когда день сменился, — иначе полоса «сегодня» висела
         * бы над каждой репликой и мешала читать. У старых записей поля `at` нет
         * вовсе: тогда и разделителя нет, переписка выглядит как раньше.
         */
        const prevMsg = visibleMessages[i - 1];
        const prevAt = prevMsg?.at;
        const showDay = !!m.at && (!prevAt || dushanbeDate(prevAt) !== dushanbeDate(m.at));
        /**
         * ГРУППИРОВКА ПОДРЯД ИДУЩИХ РЕПЛИК ОДНОГО ОТПРАВИТЕЛЯ (владелец
         * 22.08.2026: «полная имитация мессенджера»). До этой правки плашка
         * «Бот»/«Клиент»/имя агента повторялась над КАЖДЫМ пузырём — в
         * Telegram/WhatsApp имя показывается один раз на группу подряд идущих
         * реплик, а не под каждой строкой. Сравниваем по senderPrefix (тот же
         * ключ, что и в превью списка диалогов) — это отличает бота от
         * конкретного агента и от «вручную из мессенджера», а не только
         * сторону (клиент/компания): смена агента посреди группы всё равно
         * покажет новую плашку, это операционно важно знать, кто именно писал.
         */
        const sameGroupAsPrev =
          !!prevMsg &&
          !showDay &&
          prevMsg.role === m.role &&
          (m.role !== "assistant" || senderPrefix(prevMsg.by) === senderPrefix(m.by));
        // Ответ живого человека (агент из CRM или вручную из мессенджера) — тот
        // же пузырь `.me`, но без пунктира: пунктир в эталоне означает бота.
        const humanReply = m.role === "assistant" && (m.by?.kind === "agent" || m.by?.kind === "manual");
        // Настоящий ответ бота — для кнопок оценки (BotReplyFeedback). Отсутствие
        // `by` трактуется как бот (см. MessageSender в @royal-home/shared) — то
        // же правило, что и у humanReply/сервера; «system» (служебная рассылка
        // CRM) сюда не попадает: оценивать нечего, это не слова бота.
        const isBotAnswer = m.role === "assistant" && (!m.by || m.by.kind === "bot");
        // Абсолютный индекс в ПОЛНОЙ истории — и для ключа (см. ниже), и для
        // ref (скролл поиска), и чтобы понять, это ли сообщение сейчас
        // активное совпадение (useConversationSearch).
        const absoluteIndex = hiddenCount + i;
        const isActiveSearchMatch = absoluteIndex === activeSearchIndex;
        if (royal) {
          // НОВЫЙ ВИД (владелец 20.11.2026, «как в WhatsApp»): наши ответы — бота
          // и сотрудника — одинаковые пузыри справа, без подписи «бот» и без
          // «Верно/Неверно»; кто ответил и оценка — в «Сведениях о сообщении».
          // Хвостик — у последней реплики группы одной стороны.
          const sameDay = (a: string, b: string) => dushanbeDate(a) === dushanbeDate(b);
          let next = i + 1;
          while (next < visibleMessages.length && !shown[next]) next++;
          let prev = i - 1;
          while (prev >= 0 && !shown[prev]) prev--;
          // Один признак на хвостик и на слитый отступ — сторона разговора и день.
          const tail = isGroupTail(m, visibleMessages[next], sameDay);
          const cont = !showDay && sameSide(visibleMessages[prev], m, sameDay);
          const showChannel = !!m.sourceChannel && (multiChannel || (!!prevMsg?.sourceChannel && prevMsg.sourceChannel !== m.sourceChannel));
          return (
            <Fragment key={messageRenderKey(m, absoluteIndex)}>
              {showDay && m.at && <span className="day">{dushanbeDayLabel(m.at)}</span>}
              <div
                data-chat-message={messageRenderKey(m, absoluteIndex)}
                data-msg-index={absoluteIndex}
                data-sender={m.role === "user" ? "client" : m.by?.kind ?? "bot"}
                ref={(el) => {
                  if (el) messageRefs.current.set(absoluteIndex, el);
                  else messageRefs.current.delete(absoluteIndex);
                }}
                className={`bub${m.role === "user" ? "" : " me"}${tail ? " ry-tail" : ""}${cont ? " ry-cont" : ""}${isActiveSearchMatch ? " ring-2 ring-amber" : ""}`}
              >
                <span className="sr-only">{m.role === "user" ? "Клиент:" : "Мы:"}</span>
                <MessageQuote quoted={quotedMessage(allMessages, m.replyToMid, allMessages.indexOf(m), m.sourceConversationId)} />
                {m.sourceChannel && (showChannel
                  ? <span className="meta" data-message-channel style={{ display: "inline-block", marginRight: 6 }}>{channelMeta(m.sourceChannel).label}</span>
                  : <span className="sr-only" data-message-channel>{channelMeta(m.sourceChannel).label}</span>)}
                {/* Текст — в своей обёртке: на нём долгое нажатие выделяет слова (как
                    везде), а «Сведения» открывает нажатие на пустом месте пузыря и стрелка. */}
                {!hasVoiceAttachment(m.attachments) && !!content && (
                  <span className="ry-msg-text">
                    {m.sourceChannel === "TELEGRAM_DIRECT" ? content : searchQuery ? (
                      highlightText(content, searchQuery, isActiveSearchMatch)
                    ) : (
                      <TranslatableMessageText content={content} message={m} conversationId={m.sourceConversationId ?? conversationId} clientId={clientId} readOnly={readOnly} quietMask />
                    )}
                  </span>
                )}
                <MessageAttachments attachments={m.attachments} onImageClick={(imgIdx) => onOpenPhoto(absoluteIndex, imgIdx)} />
                {(m.at || (m.role === "assistant" && m.deliveryStatus)) && (
                  <span className="tm">
                    {m.at && <time dateTime={m.at}>{dushanbeTime(m.at)}</time>}
                    {m.role === "assistant" && <RoyalTicks status={m.deliveryStatus} />}
                  </span>
                )}
                {onOpenInfo && (
                  <button type="button" className="ry-msg-more" aria-label="Сведения о сообщении" title="Сведения о сообщении" onClick={() => onOpenInfo(absoluteIndex)}>
                    <ChevronDown aria-hidden="true" />
                  </button>
                )}
              </div>
            </Fragment>
          );
        }
        return (
        // Ключ — АБСОЛЮТНЫЙ индекс в истории (аудит №4, 27.08): окно
        // видимых сообщений скользит (hiddenCount растёт с каждым новым
        // входящим), и относительный индекс переиспользовал компонент с
        // данными СОСЕДНЕГО сообщения — играющее голосовое обрывалось, а
        // открытое фото молча подменялось чужим.
        <Fragment key={messageRenderKey(m, absoluteIndex)}>
          {showDay && m.at && <span className="day">{dushanbeDayLabel(m.at)}</span>}
        <div
          data-chat-message={messageRenderKey(m, absoluteIndex)}
          ref={(el) => {
            if (el) messageRefs.current.set(absoluteIndex, el);
            else messageRefs.current.delete(absoluteIndex);
          }}
          className={`bub${m.role === "user" ? "" : humanReply ? " me" : " me bot"}${
            isActiveSearchMatch ? " ring-2 ring-amber" : ""
          }`}
        >
          {sameGroupAsPrev ? null : m.role === "assistant" ? (
            <MessageSenderBadge sender={m.by} viewerAgentId={viewerAgentId} className="who" />
          ) : (
            <span className="who">Клиент</span>
          )}
          {/* На что этот ответ. Ищем по ВСЕЙ ленте, а не по показанной части:
              цитируемая реплика вполне может быть выше свёрнутого хвоста. */}
          <MessageQuote quoted={quotedMessage(allMessages, m.replyToMid, allMessages.indexOf(m), m.sourceConversationId)} />
          {m.sourceChannel && (royal && !multiChannel && !(prevMsg?.sourceChannel && prevMsg.sourceChannel !== m.sourceChannel)
            // Новый вид: канал один на весь разговор — слово в каждом пузыре только
            // мешает читать; для экранного чтеца оно остаётся.
            ? <span className="sr-only" data-message-channel>{channelMeta(m.sourceChannel).label}</span>
            : <span className="meta" data-message-channel style={{ display: "inline-block", marginRight: 6 }}>{channelMeta(m.sourceChannel).label}</span>)}
          {/* Текст расшифровки голосового агенту и в CRM не показываем (решение
              владельца 16.08.2026) — только сам звук: расшифровка бывает выдумана
              (тихая запись даёт Gemini повод сочинить фразу), а в базе она всё
              равно остаётся — боту она нужна как память уже проговоренного. */}
          {!hasVoiceAttachment(m.attachments) &&
            (m.sourceChannel === "TELEGRAM_DIRECT" ? <span>{content}</span> : searchQuery ? (
              highlightText(content, searchQuery, isActiveSearchMatch)
            ) : (
              <TranslatableMessageText content={content} message={m} conversationId={m.sourceConversationId ?? conversationId} clientId={clientId} readOnly={readOnly} />
            ))}
          {/* Фото, голосовые и видео клиента прямо в пузыре: раньше от них
              оставалась только пометка «[вложение: image]». */}
          <MessageAttachments
            attachments={m.attachments}
            onImageClick={(imgIdx) => onOpenPhoto(absoluteIndex, imgIdx)}
          />
          {/* Оценка ответа бота прямо в чате (17.09.2026) — см. BotReplyFeedback.tsx. */}
          {isBotAnswer && !readOnly && m.sourceChannel !== "TELEGRAM_DIRECT" && (
            <BotReplyFeedback
              conversationId={m.sourceConversationId ?? conversationId}
              message={m}
              messageKey={m.mid ?? `idx:${m.sourceMessageIndex ?? absoluteIndex}`}
              index={m.sourceMessageIndex ?? absoluteIndex}
            />
          )}
          {/* Время — часами ДУШАНБЕ, а не устройства: директор может смотреть из
              другой страны, и «в 14:30» обязано значить одно и то же для всех. */}
          <span className="tm" data-message-time-unknown={!m.at || undefined}>
            {m.at ? <time dateTime={m.at} title={`${dushanbeDayLabel(m.at)}, ${dushanbeTime(m.at)}`}>{messageTimeText(m.at)}</time> : messageTimeText(m.at)}
            {/* Галочки доставки — были только на мобильном (владелец
                22.08.2026: «полная имитация мессенджера»), десктоп молчал
                о статусе, хотя WhatsApp его присылает. */}
          {m.role === "assistant" && <DeliveryTicks status={m.deliveryStatus} />}
          </span>
        </div>
        </Fragment>
        );
      })}
      {/* Фото/видео в процессе загрузки (18.08.2026) — пузырь появляется сразу
          по нажатию «Отправить», не дожидаясь ответа сервера (оптимистично, как
          текстовые реплики выше), и не блокирует остальной чат: прогресс живёт в
          store/mediaUploads.ts на уровне conversationId, переключение диалогов
          его не сбрасывает. Настоящая реплика придёт из истории после успеха —
          тогда этот пузырь убирается (см. useUploadConversationMediaWithProgress). */}
      {pendingUploads.map((u) => (
        <div key={u.localId} className="bub me">
          {/* Плитка эталона `.att-img` (180x120) — та же, которой приходит уже
              доставленное фото (components/MessageAttachments.tsx): пузырь во
              время отправки и после неё не должен менять размер и рамку. */}
          <div className="att-img" style={{ position: "relative" }}>
            {u.kind === "image" ? (
              <img src={u.previewUrl} alt="Загружается" className="w-full h-full object-cover" />
            ) : (
              <video src={u.previewUrl} className="w-full h-full object-cover" muted preload="metadata" />
            )}
            {u.status === "uploading" && (
              <div className="absolute inset-0 bg-black/45 flex flex-col items-center justify-center gap-1">
                <RotateCw className="w-5 h-5 text-white animate-spin" />
                <span className="text-[13px] font-semibold text-white tabular-nums">{u.progress}%</span>
                <div className="w-[70%] h-1 rounded-full bg-white/30 overflow-hidden">
                  <div className="h-full bg-white" style={{ width: `${u.progress}%` }} />
                </div>
              </div>
            )}
            {u.status === "error" && (
              <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-1 px-2 text-center">
                {/* Значок белый, а не красный: подложка тут всегда тёмная, и
                    красный `--crit` на ней не добирает 4.5 контраста ни в одной
                    из тем. Красным остаётся строка отказа под пузырём. */}
                <AlertCircle className="w-5 h-5 text-white" />
                <span className="text-[13px] font-semibold text-white">Не отправлено</span>
              </div>
            )}
          </div>
          {u.caption && <p style={{ marginTop: 6 }}>{u.caption}</p>}
          {u.status === "error" && (
            <div className="wrap" style={{ marginTop: 6 }}>
              <span className="txt" style={{ color: "var(--crit)" }}>
                {u.error || "Не удалось отправить"}
              </span>
              <button type="button" className="lnk" onClick={() => onRetryUpload(u)}>
                Повторить
              </button>
              <button type="button" className="lnk" onClick={() => onCancelUpload(u.localId)}>
                Убрать
              </button>
            </div>
          )}
        </div>
      ))}
    </>
  );
});

export function ConversationView({ id, onBack, clean = false, royal = false, onPromoteToClient }: { id: string; onBack: () => void; clean?: boolean; royal?: boolean; onPromoteToClient?: (clientId: string) => void }) {
  const isClientGroup = id.startsWith("client:");
  const isGroupedEntry = isClientGroup || id.startsWith("td_");
  const groupedQuery = useGroupedConversation(isGroupedEntry ? id : null);
  const singleQuery = useConversation(isGroupedEntry ? null : id);
  const conversation = isGroupedEntry ? groupedQuery.data : singleQuery.data;
  useEffect(() => {
    if (!id.startsWith("client:") && conversation?.clientId) onPromoteToClient?.(conversation.clientId);
  }, [id, conversation?.clientId, onPromoteToClient]);
  const conversationError = isGroupedEntry ? groupedQuery.error : singleQuery.error;
  const conversationLoading = isGroupedEntry ? groupedQuery.isLoading : singleQuery.isLoading;
  const reloadConversation = isGroupedEntry ? groupedQuery.refetch : singleQuery.refetch;
  const [selectedReplySource, setSelectedReplySource] = useState("");
  // Полная история (см. подробный комментарий ниже у поиска) — выше, чем раньше:
  // по ней новый вид сам выбирает канал ответа.
  const allMessages = useMemo(() => conversation?.messages ?? [], [conversation?.messages]);
  // Новый вид (20.11.2026): канал ответа в общем чате выбирается сам — тот, где
  // клиент писал последним; ручной выбор (меню «⋯») важнее. Прежний вид — как был:
  // пока канал не выбран руками, отправка закрыта.
  const autoReplySource = useMemo(
    () => (royal && isGroupedEntry ? autoReplySourceId(allMessages, conversation?.sources) : ""),
    [royal, isGroupedEntry, allMessages, conversation?.sources],
  );
  // Во время набора канал не меняется сам (ревью #332): начал печатать в
  // Instagram — пришло сообщение в WhatsApp — ответ всё равно уйдёт в Instagram.
  // Фиксируется на первом символе, отпускается, когда поле снова пустое.
  const [typingLockSource, setTypingLockSource] = useState("");
  const chosenReplySource = selectedReplySource || typingLockSource || autoReplySource;
  const replySource = conversation?.sources?.find((source) => source.id === chosenReplySource && source.canReply);
  const replyTargetId = isGroupedEntry ? (replySource?.id ?? null) : id;
  const customerRequestConversationIds = callbackRequestConversationIds(isGroupedEntry
    ? (conversation?.sources ?? []).map((source) => source.id)
    : [id]);
  // Полная история — нужна и здесь (окно "показать более ранние" ниже), и
  // поиску (useConversationSearch ищет по ВСЕЙ переписке, а не только по
  // видимому хвосту, — иначе не находил бы то, что ещё свёрнуто).
  // useMemo, а не голый `?? []` (21.09.2026): массив теперь входит в deps двух
  // новых хуков ниже (chatPhotos, openChatPhoto) — без мемоизации пустой
  // fallback создавал бы новую ссылку на каждый рендер и пересчитывал их
  // впустую (react-hooks/exhaustive-deps честно на это указал).
  const narrow = useNarrowScreen();
  // Переписка нового вида на телефоне — на весь экран: фон под ней не прокручивается (при клавиатуре iOS
  // иначе «поплыла» бы и вся страница, и видимая область уезжала от переписки; кадр 12, 20.11.2026).
  useScrollLock(royal && narrow);
  const readOnly = useIsReadOnly();
  const search = useConversationSearch(allMessages);
  const { close: closeConversationSearch } = search;
  // Проактивно, ДО отправки (владелец 18.09.2026) — см. lib/messagingWindow.ts.
  const replySourceMessages = useMemo(
    () => isGroupedEntry && replySource ? allMessages.filter((message) => message.sourceConversationId === replySource.id) : allMessages,
    [allMessages, isGroupedEntry, replySource],
  );
  const windowClosed = isGroupedEntry
    ? !!replySource && isMessagingWindowClosed(replySource.channel, lastInboundMessageAt(replySourceMessages))
    : isMessagingWindowClosed(conversation?.channel, conversation ? lastInboundMessageAt(conversation.messages) : null);
  // Продавец: полоса под шапкой (21.09.2026) и кнопка «Добавить объект» в
  // просмотрщике фото читают ОДИН и тот же запрос (общий queryKey в
  // useSellerObject) — второго похода на сервер здесь нет.
  const sellerObject = useSellerObject(conversation?.clientId);
  // Просмотрщик ВСЕХ фото переписки (макет «Объект из переписки», раздел 3):
  // свайп листает не одно сообщение, а всю историю. Список строится из уже
  // загруженных allMessages — без похода на сервер.
  const chatPhotos = useMemo(
    () => buildChatPhotoList(allMessages, conversation?.name ?? null),
    [allMessages, conversation?.name]
  );
  const [chatPhotoIndex, setChatPhotoIndex] = useState<number | null>(null);
  const openChatPhoto = useCallback(
    (absoluteMessageIndex: number, imageIndexInMessage: number) => {
      setChatPhotoIndex(chatPhotoOffsetForMessage(allMessages, absoluteMessageIndex) + imageIndexInMessage);
    },
    [allMessages]
  );
  const reply = useReplyToConversation(replyTargetId);
  const voiceMessage = useSendVoiceMessage(replyTargetId);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const mediaUpload = useUploadConversationMediaWithProgress(replyTargetId);
  const pendingUploads = usePendingMediaUploads(replyTargetId);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [pendingMedia, setPendingMedia] = useState<File | null>(null);
  const [mediaPreview, setMediaPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingMedia?.type.startsWith("image/")) { setMediaPreview(null); return; }
    const url = URL.createObjectURL(pendingMedia);
    setMediaPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingMedia]);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const botState = conversationBotState({ id, grouped: isGroupedEntry, pausedUntil: conversation?.pausedUntil,
    sources: conversation?.sources, selectedSourceId: chosenReplySource });
  // Новый вид (ревью #332): пауза из «⋯» в общем чате клиента — сразу во ВСЕХ
  // каналах разговора, куда CRM отвечает, а не в одном выбранном молча.
  const royalBotIds = useMemo(
    () => (!royal ? [] : isGroupedEntry ? (conversation?.sources ?? []).filter((source) => source.canReply).map((source) => source.id) : [id]),
    [royal, isGroupedEntry, conversation?.sources, id],
  );
  const royalPausedCount = !royal ? 0 : isGroupedEntry
    ? (conversation?.sources ?? []).filter((source) => source.canReply && !!source.pausedUntil && Date.parse(source.pausedUntil) > Date.now()).length
    : (conversation?.pausedUntil && Date.parse(conversation.pausedUntil) > Date.now() ? 1 : 0);
  const resume = useResumeConversationBot(royal ? royalBotIds : botState.controlId);
  const pause = usePauseConversationBot(royal ? royalBotIds : botState.controlId);
  // Меню «Пауза» в шапке (TASKS.md 10.09 «с обзора прода глазами», п.6): тот же
  // приём, что уже применён на телефоне (MobileChatView.tsx, «Раньше здесь
  // стояли пять контролов... нативный select паузы») — пилюля-триггер вместо
  // родного <select>, чтобы шапка не мешала браузерный виджет с круглыми
  // кнопками `.call`. Логика паузы не тронута: тот же pause.mutate внутри.
  const pauseMenu = useDismissableMenu<HTMLButtonElement>();
  // «Ещё» в шапке нового вида: редкое (поиск, карточка, данные клиента) — в меню.
  const moreMenu = useDismissableMenu<HTMLButtonElement>();
  // Новый вид: «⋯» открывает основное меню или вложенный выбор срока паузы
  // (только руководству); скрепка — меню «фото, объект, быстрые ответы».
  const [moreView, setMoreView] = useState<"main" | "pause">("main");
  const attachMenu = useDismissableMenu<HTMLButtonElement>();
  const [propertyPickerOpen, setPropertyPickerOpen] = useState(false);
  // «Сведения о сообщении» — абсолютный индекс в allMessages; setState стабилен,
  // поэтому memo-ленте передаётся как есть и не перерисовывает её при печати.
  const [infoIndex, setInfoIndex] = useState<number | null>(null);
  const openInfoAt = useCallback((target: HTMLElement) => {
    const index = Number(target.dataset.msgIndex);
    if (Number.isInteger(index)) setInfoIndex(index);
  }, []);
  const longPress = useLongPress(openInfoAt);
  const navigate = useNavigate();
  const [text, setText] = useState("");
  // Идёт запись голосового — кнопку не меняем на «Отправить» и поле не трогаем,
  // иначе набранная буква сняла бы запись вместе с кнопкой (ревью #332).
  const [voiceBusy, setVoiceBusy] = useState(false);
  useEffect(() => {
    if (!royal || !isGroupedEntry) return;
    setTypingLockSource((current) => (text.trim() ? current || autoReplySource : ""));
  }, [royal, isGroupedEntry, text, autoReplySource]);
  useEffect(() => setSelectedReplySource(""), [id]);
  useEffect(() => {
    const input = composerRef.current;
    if (!clean || !input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }, [clean, text]);
  // Черновик ответа переживает принудительную перезагрузку при автообновлении
  // (находка ночной проверки 24.09.2026, №246/К2-4): без этого пятиминутный
  // потолок ожидания (см. UpdatePrompt.tsx) стирал набранный, но не
  // отправленный текст. Ключ — id разговора, чтобы черновик восстановился
  // именно в него, а не в первый открытый после перезагрузки.
  //
  // С 17.11.2026 (аудит F2-5) черновик по диалогу хранится во ВСЕХ оболочках, а
  // не только в чистой: агент уходил в карточку клиента проверить цену,
  // возвращался — поле пустое. Хранилище (lib/cleanChatDraft.ts, sessionStorage)
  // привязано к сотруднику и сессии, переживает и уход с экрана, и перезагрузку
  // при обновлении (сброс на pagehide); очищается отправкой.
  useCleanChatDraft({ enabled: true, conversationId: id, text, restore: setText });
  // Последний пресет ("Бессрочно") — длительность паузы по умолчанию после ручного
  // ответа (решение владельца 18.08.2026); то же значение зашито на сервере в
  // OPERATOR_REPLY_PAUSE_MS. Агент по-прежнему может выбрать более короткую паузу.
  const [pauseOptionIndex, setPauseOptionIndex] = useState(PAUSE_OPTIONS.length - 1);
  // Выбранное через «Произвольно…» число минут для паузы при отправке ответа.
  const [customPauseMinutes, setCustomPauseMinutes] = useState<number | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  // Длинные диалоги рендерим хвостом по MESSAGES_CHUNK с кнопкой «показать более ранние».
  const reading = useChatReadingPosition(clean && !!conversation, allMessages.length, MESSAGES_CHUNK);
  const { visibleCount, setVisibleCount, scrollRef } = reading;
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const closeSearch = useCallback(() => {
    closeConversationSearch();
    // В новом виде кнопка поиска живёт в меню «Ещё» — фокус возвращается на него.
    (searchButtonRef.current ?? moreMenu.buttonRef.current)?.focus();
  }, [closeConversationSearch, moreMenu.buttonRef]);
  // Быстрые ответы — только новый вид, та же лента, что на телефоне (lib/chatQuickReplies.ts).
  const quickReplies = useMemo(() => (royal ? chatQuickReplies(allMessages) : []), [royal, allMessages]);
  // Сколько разных каналов в ленте (общий чат клиента) — для метки канала в пузырях.
  const multiChannel = useMemo(
    () => new Set(allMessages.map((message) => message.sourceChannel).filter(Boolean)).size > 1,
    [allMessages],
  );
  const replyableSources = (conversation?.sources ?? []).filter((source) => source.canReply);
  const replySourceLabelsList = replySourceLabels(replyableSources.map((source) => source.channel));
  // Имя в шапке без кода карточки («Продавец ПР-000894» → «Продавец из Facebook»).
  const headerTitle = chatTitle(conversation?.name, conversation?.channel === "MULTI" ? (replySource?.channel ?? null) : conversation?.channel);
  // Ссылки на пузыри сообщений по АБСОЛЮТНОМУ индексу — только для скролла к
  // найденному поиском (см. useConversationSearch ниже); автоскролл к низу
  // ленты (эффект чуть ниже) через них не идёт, ему хватает scrollRef.
  const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const paused = botState.paused;
  // Управление ботом — только руководству. См. комментарий у самого блока ниже.
  const canManageBot = useCan()("messages.view") && !readOnly && (royal ? royalBotIds.length > 0 : !!botState.controlId);
  const allChannelsWord = royalBotIds.length > 1 ? " во всех каналах" : "";

  // Новый диалог — сбрасываем окно истории, панель и поиск.
  useEffect(() => {
    setVisibleCount(MESSAGES_CHUNK);
    setShowInfo(false);
    setInfoIndex(null);
    closeConversationSearch();
    // closeConversationSearch стабилен (useCallback без зависимостей в useConversationSearch) —
    // в массиве зависимостей ниже не ради строгости, а чтобы линт не потерял из
    // виду реальную зависимость эффекта.
  }, [id, closeConversationSearch, setVisibleCount]);

  /**
   * Автопрокрутка — ТОЛЬКО ЕСЛИ ЧЕЛОВЕК И ТАК ВНИЗУ (аудит №4, 27.08).
   *
   * Безусловный scrollTo выдёргивал позицию чтения каждые несколько секунд:
   * оператор отматывал вверх перечитать договорённости, поллинг приносил новое
   * сообщение — и его возвращало в низ. В бойком диалоге история была
   * нечитаема при открытом чате. Порог в 120 пикселей — обычный «почти внизу».
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (clean) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (atBottom) el.scrollTo({ top: el.scrollHeight });
  }, [conversation, clean, scrollRef]);

  /**
   * ПЕРЕХОД К НАЙДЕННОМУ ПОИСКОМ СООБЩЕНИЮ (06.09.2026).
   *
   * Совпадение вполне может лежать ВЫШЕ текущего окна `visibleCount` (лента
   * рендерит только последний хвост, см. MESSAGES_CHUNK) — тогда сначала
   * раздвигаем окно, чтобы нужный пузырь вообще попал в DOM, и только
   * следующим эффектом (после перерисовки, когда ref на него уже поставлен)
   * скроллим к нему. Раздельные эффекты специально: `scrollIntoView` на ещё
   * не отрисованный узел ничего не сделает.
   */
  useEffect(() => {
    if (search.activeAbsoluteIndex === null) return;
    setVisibleCount((v) => Math.max(v, allMessages.length - search.activeAbsoluteIndex!));
  }, [search.activeAbsoluteIndex, allMessages.length, setVisibleCount]);

  useEffect(() => {
    if (search.activeAbsoluteIndex === null) return;
    const el = messageRefs.current.get(search.activeAbsoluteIndex);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [search.activeAbsoluteIndex, search.matches.length, visibleCount]);

  async function handleSend() {
    const value = text.trim();
    if (readOnly || !value || reply.isPending || !replyTargetId || (clean && !conversation)) return;
    try {
      // Срок паузы уходит ВСЕГДА (ревью #332). В новом виде выбора в окне нет, и
      // pauseOptionIndex остаётся «Бессрочно» — как было по умолчанию. Без срока
      // сервер (defaultPauseForSender, lib/conversationDelivery.ts) дал бы
      // директору/незакреплённому агенту 10 минут, и бот писал бы поверх человека.
      // «Эстафета» поменяет это одним местом — когда придёт.
      const minutes = customPauseMinutes ?? PAUSE_OPTIONS[pauseOptionIndex].minutesFromNow();
      await reply.mutateAsync({ text: value, pausedUntil: pausedUntilIso(minutes) });
      // Не стираем текст, набранный, пока шёл запрос (WEB-PAGES02).
      setText((cur) => clearIfUnchanged(cur, value));
      if (clean) reading.jumpToLatest();
    } catch {
      // Ошибка показана через reply.isError — текст не очищаем, чтобы не потерять набранное.
    }
  }

  /** Файл выбран в скрытом `<input>` — проверяем размер СРАЗУ, до загрузки: канал
   *  диалога уже известен, дожидаться ответа сервера ради очевидного отказа незачем.
   *  У видео это больше не отказ по каналу (гибридный режим) — только 1 ГБ предохранитель. */
  function handlePickMedia(file: File | undefined) {
    if (!file || readOnly || !replyTargetId) return;
    setMediaError(null);
    const error = validateOutgoingMediaPick(file, (isGroupedEntry ? replySource?.channel : conversation?.channel) ?? undefined);
    if (error) {
      setMediaError(error);
      return;
    }
    setPendingMedia(file);
  }

  /**
   * Отправка фото/видео (18.08.2026, WhatsApp/Telegram-стиль): пузырь с прогрессом
   * появляется в ленте СРАЗУ, запрос грузится в фоне (store/mediaUploads.ts,
   * hooks/useConversations.ts::useUploadConversationMediaWithProgress) — ни поле
   * ввода, ни остальной чат не блокируются, пока идёт загрузка.
   */
  function handleSendMedia() {
    if (!pendingMedia || readOnly || !replyTargetId) return;
    mediaUpload.start(pendingMedia, text.trim() || undefined);
    setPendingMedia(null);
    setText("");
  }

  const hiddenCount = Math.max(0, allMessages.length - visibleCount);
  const visibleMessages = useMemo(() => hiddenCount > 0 ? allMessages.slice(hiddenCount) : allMessages, [allMessages, hiddenCount]);

  // Стабильная ссылка на функцию (06.09.2026, вынос ленты в ConversationMessageList) —
  // инлайн-стрелка в JSX создавалась бы заново на каждый рендер (в том числе на
  // каждое нажатие клавиши в поле ответа) и обнуляла бы React.memo у списка.
  const showMoreMessages = reading.showMoreMessages;

  const meta = conversation ? channelMeta(conversation.channel) : null;
  const ChannelIcon = meta?.icon;
  if (clean && !conversation) {
    return <section className="card clean-conversation-state" aria-label="Диалог" aria-busy={conversationLoading}>
      {narrow && <button type="button" className="pill ghost" onClick={onBack}><ChevronLeft className="i" />К списку чатов</button>}
      {conversationError ? <div role="alert">
        <h2>Не удалось открыть диалог</h2>
        <p>{conversationError instanceof Error ? conversationError.message : "Проверьте подключение и повторите попытку."}</p>
        <button type="button" className="pill ghost" onClick={() => reloadConversation()}>Повторить загрузку диалога</button>
      </div> : <div role="status"><h2>Открываем переписку</h2><div className="clean-message-skeleton" /><div className="clean-message-skeleton" /><div className="clean-message-skeleton" /></div>}
    </section>;
  }
  /**
   * ПРАВАЯ ПАНЕЛЬ ДИАЛОГА — разметка эталона (screens/messages.html, `#scr-chat`):
   * шапка `.pane-h` с аватаром и действиями, лента `.thread` с пузырями `.bub`,
   * строка-подсказка `.suggest` и композер `.compose`. Высота панели задана
   * инлайном, как в прототипе задаются размеры конкретного места: сам эталон
   * рисует один экран данных и предела высоты не знает.
   */
  return (
    <section
      className={clean ? "card clean-conversation" : "card"}
      aria-label={conversation?.name ? `Диалог: ${conversation.name}` : "Диалог"}
      style={royal ? undefined : { display: "flex", flexDirection: "column", maxHeight: "calc(100dvh - 160px)", minHeight: 420 }}
    >
      {royal ? <>
        {/* ШАПКА НОВОГО ВИДА — как в мессенджере (владелец 20.11.2026): назад,
            аватар со значком канала, имя без кода карточки, звонок и «⋯». Второй
            строки нет: ни канала словами, ни состояния бота. Всё прежнее на месте
            — в «⋯» (поиск, сведения, карточка, канал ответа; руководству — бот)
            и в сведениях о контакте по нажатию на имя. */}
        <div className="ry-chat-head">
          {narrow && (
            <button
              type="button"
              className="ry-round ry-round-ghost"
              onClick={() => { if (showInfo) setShowInfo(false); else onBack(); }}
              aria-label={showInfo ? "Назад к переписке" : "Назад к списку чатов"}
            >
              <ChevronLeft aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="ry-chat-who"
            onClick={() => setShowInfo((v) => !v)}
            aria-expanded={showInfo}
            aria-controls="conversation-contact-details"
            title="Сведения о контакте"
          >
            <span className="ry-chat-av">
              <RhAvatar name={headerTitle.title} size={44} />
              <RoyalChannelBadge channel={isGroupedEntry && (!conversation?.channel || conversation.channel === "MULTI") ? "MULTI" : conversation?.channel} />
            </span>
            <span className="ry-chat-who-tx">
              <b>{conversation ? headerTitle.title : "…"}</b>
              <span className="sr-only">{isGroupedEntry && (!conversation?.channel || conversation.channel === "MULTI") ? "Общий чат" : meta?.label}</span>
            </span>
          </button>
          {conversation?.clientPhone && !readOnly && (
            <CallClientButton clientId={conversation.clientId} phone={conversation.clientPhone} variant="icon" className="ry-round ry-round-ghost" />
          )}
          <div ref={moreMenu.boxRef} className="ry-menu-box">
            <button
              ref={moreMenu.buttonRef}
              type="button"
              className="ry-round ry-round-ghost"
              onClick={() => { setMoreView("main"); moreMenu.setOpen((v) => !v); }}
              aria-haspopup="menu"
              aria-expanded={moreMenu.open}
              aria-label="Ещё"
              title="Ещё"
            >
              <MoreHorizontal aria-hidden="true" />
            </button>
            {moreMenu.open && moreView === "main" && (
              <div role="menu" aria-label="Ещё" className="ry-menu" onClick={() => moreMenu.setOpen(false)}>
                <button type="button" role="menuitem" onClick={() => (search.isOpen ? closeSearch() : search.open())}>
                  <Search aria-hidden="true" />{search.isOpen ? "Закрыть поиск" : "Найти в переписке"}
                </button>
                <button type="button" role="menuitem" onClick={() => setShowInfo((v) => !v)}>
                  <Info aria-hidden="true" />{showInfo ? "Скрыть сведения о контакте" : "Сведения о контакте"}
                </button>
                {conversation?.clientShortId && (
                  <button type="button" role="menuitem" onClick={() => navigate(`/clients/${conversation.clientShortId}`)}>
                    <RoyalIcon name="users" size={20} />Карточка клиента
                  </button>
                )}
                {/* Канал ответа в общем чате: выбран сам (где клиент писал последним),
                    сменить — здесь, а не полем под перепиской. */}
                {!readOnly && isGroupedEntry && replyableSources.length > 1 && (
                  <div role="group" aria-label="Ответить через" className="ry-menu-group">
                    <span className="ry-menu-cap">Ответить через</span>
                    {replyableSources.map((source, index) => (
                      <button
                        key={source.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={source.id === replySource?.id}
                        onClick={() => setSelectedReplySource(source.id)}
                      >
                        {source.id === replySource?.id ? <Check aria-hidden="true" /> : <span className="ry-menu-gap" aria-hidden="true" />}
                        {replySourceLabelsList[index]}
                      </button>
                    ))}
                  </div>
                )}
                {/* Бот — только руководству (право messages.view, как и на сервере).
                    Агенту в окне про бота нет ничего: решение владельца 20.11.2026. */}
                {canManageBot && royalPausedCount > 0 && (
                  <button type="button" role="menuitem" disabled={resume.isPending} onClick={() => resume.mutate()}>
                    <Bot aria-hidden="true" />Вернуть боту{allChannelsWord}
                  </button>
                )}
                {canManageBot && royalPausedCount < royalBotIds.length && (
                  <button
                    type="button"
                    role="menuitem"
                    aria-haspopup="menu"
                    disabled={pause.isPending}
                    onClick={(event) => { event.stopPropagation(); setMoreView("pause"); }}
                  >
                    <Bot aria-hidden="true" />Поставить бота на паузу{allChannelsWord}…
                  </button>
                )}
              </div>
            )}
            {moreMenu.open && moreView === "pause" && canManageBot && royalPausedCount < royalBotIds.length && (
              <div role="menu" aria-label={`Поставить бота на паузу${allChannelsWord}`} className="ry-menu" onClick={() => moreMenu.setOpen(false)}>
                <button type="button" role="menuitem" onClick={(event) => { event.stopPropagation(); setMoreView("main"); }}>
                  <ChevronLeft aria-hidden="true" />Назад
                </button>
                {PAUSE_OPTIONS.map((opt, idx) => (
                  <button
                    key={opt.label}
                    type="button"
                    role="menuitem"
                    disabled={pause.isPending}
                    onClick={() => pause.mutate(pausedUntilIso(PAUSE_OPTIONS[idx].minutesFromNow()))}
                  >
                    Пауза: {opt.label}
                  </button>
                ))}
                <button
                  type="button"
                  role="menuitem"
                  disabled={pause.isPending}
                  onClick={() => {
                    const minutes = promptCustomPauseMinutes();
                    if (minutes !== null) pause.mutate(pausedUntilIso(minutes));
                  }}
                >
                  Пауза: произвольно…
                </button>
              </div>
            )}
          </div>
        </div>
      </> : <div className="pane-h clean-conversation-header">
        {/* Видна только там, где список и диалог не помещаются рядом: на широком
            экране список диалогов всегда на виду слева, возвращаться некуда. */}
        <button
          type="button"
          className="pill icon ghost only-narrow"
          onClick={() => { if (clean && showInfo) setShowInfo(false); else onBack(); }}
          aria-label={clean && showInfo ? "Назад к переписке" : "Назад к списку чатов"}
        >
          <ChevronLeft className="i" />
        </button>
        <span className="av" style={rh2AvatarTone(conversation?.name)}>
          {initialsFromName(conversation?.name ?? null)}
        </span>
        <div className="t">
          <b>
            <button type="button" className="lk" onClick={() => setShowInfo((v) => !v)} title="Данные клиента" aria-expanded={showInfo} aria-controls="conversation-contact-details">
              {conversation?.name ?? "…"}
            </button>
          </b>
          {clean ? <span className="!flex !items-center !gap-2 !text-sm">
            {ChannelIcon && <ChannelIcon className="h-4 w-4 shrink-0" aria-hidden="true" />}
            {isGroupedEntry && (!conversation?.channel || conversation.channel === "MULTI") ? "Общий чат" : meta?.label}
            <span className="clean-bot-state" data-paused={paused}>{botState.label}</span>
          </span> : <span>{isGroupedEntry && (!conversation?.channel || conversation.channel === "MULTI") ? "Общий чат" : meta?.label ?? ""}</span>}
        </div>
        {/* Поиск ВНУТРИ уже открытого диалога (06.09.2026) — отдельно от поиска
            по списку слева (ConversationList выше ищет диалог целиком). */}
        <button
          type="button"
          className="call"
          ref={searchButtonRef}
          onClick={() => (search.isOpen ? closeSearch() : search.open())}
          aria-expanded={search.isOpen}
          title="Найти в переписке"
          aria-label="Найти в переписке"
        >
          <Search className="i" />
        </button>
        {conversation?.clientShortId && (
          <button
            type="button"
            className="pill ghost sm"
            onClick={() => navigate(`/clients/${conversation.clientShortId}`)}
          >
            Карточка клиента
          </button>
        )}
        {/**
         * ЩИТ ИСХОДЯЩИХ ОСТАНОВИЛ БОТА (17.09.2026) — бейдж рядом с той же
         * кнопкой снятия паузы. Без него «бот на паузе» ничем не отличается от
         * паузы, которую поставил оператор, и сотрудник не понимает ни причины,
         * ни того, что снимется она сама, как только человек напишет.
         */}
        {conversation?.shieldPause && (
          <span className="chip warn" title="Пауза снимется сама, как только человек напишет">
            Бот остановлен щитом: {conversation.shieldPause.reasonText}
          </span>
        )}
        {/**
         * УПРАВЛЕНИЕ БОТОМ — ТОЛЬКО ПРИ messages.view (07.09.2026, найдено
         * адверсариальной проверкой мержа).
         *
         * Раздел «Чаты» в этом же релизе открыли агенту по messages.viewOwn, а
         * сервер (routes/conversations.ts, /pause и /resume) в тот же день стал
         * требовать именно messages.view на этих двух маршрутах — владелец
         * прямо запретил агенту решать судьбу бота. Здесь, на десктопе, гейта
         * не было вовсе: кнопка «Вернуть боту» и список пауз рисовались
         * агенту как обычные, нажатие тихо падало бы 403. Мобильный близнец
         * (MobileChatView.tsx, canManageBot) такой гейт уже имел.
         */}
        {canManageBot &&
          (paused ? (
            <button
              type="button"
              className="pill ghost sm"
              onClick={() => resume.mutate()}
              disabled={resume.isPending}
            >
              Вернуть боту
            </button>
          ) : (
            <div ref={pauseMenu.boxRef} className="relative">
              <button
                ref={pauseMenu.buttonRef}
                type="button"
                className="pill ghost sm"
                onClick={() => pauseMenu.setOpen((v) => !v)}
                disabled={pause.isPending}
                aria-haspopup="menu"
                aria-expanded={pauseMenu.open}
              >
                Поставить на паузу…
                <ChevronDown className="i" />
              </button>
              {pauseMenu.open && (
                <div
                  role="menu"
                  aria-label="Поставить бота на паузу"
                  className="pane-h-pause-menu"
                  onClick={() => pauseMenu.setOpen(false)}
                >
                  {PAUSE_OPTIONS.map((opt, idx) => (
                    <button
                      key={opt.label}
                      type="button"
                      role="menuitem"
                      className="pill ghost sm"
                      disabled={pause.isPending}
                      onClick={() => pause.mutate(pausedUntilIso(PAUSE_OPTIONS[idx].minutesFromNow()))}
                    >
                      {opt.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    role="menuitem"
                    className="pill ghost sm"
                    disabled={pause.isPending}
                    onClick={() => {
                      const minutes = promptCustomPauseMinutes();
                      if (minutes !== null) pause.mutate(pausedUntilIso(minutes));
                    }}
                  >
                    Произвольно…
                  </button>
                </div>
              )}
            </div>
          ))}
      </div>}

      <div className={clean ? "clean-conversation-workspace" : undefined} data-context-open={showInfo || undefined} style={clean ? undefined : { display: "contents" }}>
      {showInfo && conversation && (
        <div id="conversation-contact-details" className="pane-b clean-contact-details" style={{ borderBottom: "1px solid var(--line-soft)" }}>
          <div className="list">
            {clean ? <>
              <h2 className="clean-contact-title">{royal ? headerTitle.title : "О собеседнике"}</h2>
              {/* Новый вид: объект продавца и «Добавить объект» — здесь, а не полосой
                  над перепиской (владелец 20.11.2026). Тот же компонент и запрос. */}
              {royal && <section className="ry-contact-object" aria-label="Объект"><SellerObjectStrip clientId={conversation.clientId} /></section>}
              <dl className="clean-contact-facts">
                {royal && headerTitle.code && <div><dt>Карточка</dt><dd>{headerTitle.code}</dd></div>}
                <div><dt>Канал</dt><dd>{channelMeta(conversation.channel).label}</dd></div>
                <div><dt>Имя в профиле</dt><dd>{conversation.profileName ?? "Не указано"}</dd></div>
                <div><dt>Первое обращение</dt><dd><time dateTime={conversation.firstContactAt} title={dushanbeDayLabel(conversation.firstContactAt)}>{relativeTime(conversation.firstContactAt)}</time></dd></div>
                <div><dt>Сообщений</dt><dd>{conversation.messages.length}</dd></div>
              </dl>
              <section className="clean-contact-phone" aria-label="Телефон собеседника"><h3>Телефон</h3>
                {conversation.clientPhone && !readOnly ? <CallClientButton clientId={conversation.clientId} phone={conversation.clientPhone} variant="full" label={conversation.clientPhone} className="lnk" /> : <p>{conversation.clientPhone ?? "Номер пока не указан"}</p>}
              </section>
              <section className="clean-contact-profile" aria-label="Информация о клиенте">
                <h3>Информация о клиенте</h3>
                {!isGroupedEntry && <ConversationClientLink conversationId={id} clientId={conversation.clientId} readOnly={readOnly} />}
                {conversation.contact ? <ContactProfilePanel contact={conversation.contact} readOnly={readOnly} /> : <p>Дополнительных сведений пока нет.</p>}
              </section>
              {!isGroupedEntry && <details className="clean-contact-support"><summary>Данные для поддержки</summary>
                <dl className="clean-contact-facts"><div><dt>Идентификатор в канале</dt><dd>{conversation.subscriberId}</dd></div></dl>
                <p>Ссылка на профиль недоступна.</p>
              </details>}
            </> : <>
            <div className="quiet">
              <span className="txt">
                Канал: <b>{channelMeta(conversation.channel).label}</b>. Имя в соцсети:{" "}
                <b>{conversation.profileName ?? "не передано"}</b>. Первое сообщение:{" "}
                <b>{relativeTime(conversation.firstContactAt)}</b>. Сообщений в истории:{" "}
                <b>{conversation.messages.length}</b>. ID в мессенджере: <b>{conversation.subscriberId}</b>.
              </span>
            </div>
            <div className="quiet">
              <span className="txt">Телефон:</span>
              {conversation.clientPhone && !readOnly ? (
                <CallClientButton
                  clientId={conversation.clientId}
                  phone={conversation.clientPhone}
                  variant="full"
                  label={conversation.clientPhone}
                  className="lnk"
                />
              ) : (
                <span className="txt">{conversation.clientPhone ?? "бот ещё не собрал"}</span>
              )}
            </div>
            {/* Что бот знает о человеке вообще — общий компонент с телефоном. */}
            {!isGroupedEntry && <ConversationClientLink conversationId={id} clientId={conversation.clientId} readOnly={readOnly} />}
            <ContactProfilePanel contact={conversation.contact} readOnly={readOnly} />
            <div className="quiet">
              <span className="txt">
                Ссылку на профиль и username соцсети мессенджеры вебхуком не передают: это ограничение платформ,
                а не CRM. Всё, что бот узнаёт по ходу диалога (телефон, бюджет, район), попадает в карточку клиента.
              </span>
            </div>
            </>}
          </div>
        </div>
      )}
      <div className={clean ? "clean-conversation-timeline" : undefined} style={clean ? undefined : { display: "contents" }}>
      {!royal && <SellerObjectStrip clientId={conversation?.clientId} />}
      {clean && conversationError && <div className="suggest" role="status"><span className="txt">Переписка не обновилась. Показана сохранённая история.</span><button type="button" className="lnk" onClick={() => reloadConversation()}>Обновить</button></div>}

      {/* Строка поиска — только клиентский поиск по уже загруженным `allMessages`,
          на сервер ничего не уходит (см. useConversationSearch). */}
      {search.isOpen && (
        <div
          className="pane-b"
          style={{
            borderBottom: "1px solid var(--line-soft)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <input
            className="inp"
            style={{ flex: 1, maxWidth: "none" }}
            type="search"
            autoFocus
            value={search.query}
            onChange={(e) => search.setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeSearch();
              else if (e.key === "Enter" && e.shiftKey) search.goPrev();
              else if (e.key === "Enter") search.goNext();
            }}
            placeholder="Найти в переписке"
            aria-label="Найти в переписке"
          />
          <span className="meta" role="status" aria-live="polite" style={{ fontSize: "var(--fs-13)", color: "var(--muted)" }}>
            {search.matches.length > 0 ? `${search.activeMatch + 1} из ${search.matches.length}` : search.query ? "0" : ""}
          </span>
          <button
            type="button"
            className="call"
            onClick={search.goPrev}
            disabled={search.matches.length === 0}
            aria-label="Предыдущее совпадение"
          >
            <ChevronUp className="i" />
          </button>
          <button
            type="button"
            className="call"
            onClick={search.goNext}
            disabled={search.matches.length === 0}
            aria-label="Следующее совпадение"
          >
            <ChevronDown className="i" />
          </button>
          <button type="button" className="pill ghost sm" onClick={closeSearch}>
            Закрыть
          </button>
        </div>
      )}


      {conversation && !royal && <CustomerRequestsPanel conversationIds={customerRequestConversationIds} />}

      <div
        ref={scrollRef}
        className="thread"
        tabIndex={0}
        aria-label="Переписка"
        style={{ flex: 1, minHeight: 0 }}
        onScroll={clean ? reading.onScroll : undefined}
        {...(royal ? {
          ...longPress,
          // Правая кнопка мыши (и долгое нажатие на Android) — «Сведения о сообщении».
          onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => {
            const native = event.nativeEvent as MouseEvent & { pointerType?: string };
            const touch = native.pointerType ? native.pointerType !== "mouse" : !!window.matchMedia?.("(hover: none)").matches;
            if (touch) {
              // Палец: по тексту — системное выделение; вне текста шторку откроет
              // таймер долгого нажатия (useLongPress), здесь только глушим меню.
              if (isLongPressTarget(event.target)) event.preventDefault();
              return;
            }
            const target = (event.target as HTMLElement).closest<HTMLElement>("[data-chat-message]");
            if (!target || (event.target as HTMLElement).closest("a, audio, video, img")) return;
            event.preventDefault();
            openInfoAt(target);
          },
        } : {})}
      >
        <div ref={reading.contentRef} className={clean ? "clean-thread-content" : undefined} style={clean ? undefined : { display: "contents" }}>
        {clean && allMessages.length === 0 && <div className="clean-chat-empty" role="status"><MessageSquare className="i" aria-hidden="true" /><h3>Начало переписки</h3><p>Здесь появятся сообщения клиента, ответы бота и сотрудников.</p></div>}
        <ConversationMessageList
          allMessages={allMessages}
          visibleMessages={visibleMessages}
          hiddenCount={hiddenCount}
          onShowMore={showMoreMessages}
          pendingUploads={readOnly ? [] : pendingUploads}
          readOnly={readOnly}
          onRetryUpload={mediaUpload.retry}
          onCancelUpload={mediaUpload.cancel}
          searchQuery={search.query}
          activeSearchIndex={search.activeAbsoluteIndex}
          messageRefs={messageRefs}
          clientId={conversation?.clientId ?? null}
          conversationId={id}
          onOpenPhoto={openChatPhoto}
          royal={royal}
          multiChannel={multiChannel}
          defaultChannel={conversation?.channel ?? null}
          onOpenInfo={royal ? setInfoIndex : undefined}
        />
        {/* Новый вид: важное о разговоре — серой строкой по центру ленты, как
            служебное сообщение Telegram. Запрос клиента «нужен сотрудник/звонок»
            видят все, кто ведёт чат; остановку бота щитом — только руководство. */}
        {royal && conversation && <CustomerRequestsPanel variant="line" conversationIds={customerRequestConversationIds} />}
        {royal && canManageBot && conversation?.shieldPause && (
          <p className="ry-service" title="Пауза снимется сама, как только человек напишет">Бот остановлен щитом: {conversation.shieldPause.reasonText}</p>
        )}
        </div>
      </div>
      {clean && reading.showLatest && <div className="clean-jump-latest"><button type="button" className="pill ghost" onClick={reading.jumpToLatest}><ChevronDown className="i" />{reading.newMessageCount > 0 ? `Новые сообщения: ${reading.newMessageCount}` : "К последним сообщениям"}</button></div>}
      {clean && <span className="sr-only" role="status" aria-live="polite">{reading.newMessageCount > 0 ? `Новых сообщений: ${reading.newMessageCount}` : ""}</span>}

      {chatPhotoIndex !== null && (
        <ChatPhotoViewer
          photos={chatPhotos}
          index={chatPhotoIndex}
          onClose={() => setChatPhotoIndex(null)}
          onIndexChange={setChatPhotoIndex}
          sellerClientId={!readOnly && sellerObject.data?.isSeller ? conversation?.clientId : null}
        />
      )}
      {royal && infoIndex !== null && allMessages[infoIndex] && (() => {
        const m = allMessages[infoIndex];
        return (
          <RoyalMessageInfo
            message={m}
            text={humanizeAttachmentTags(m.role === "user" ? stripBotHints(m.content) : m.content, { outgoing: m.role !== "user", hasAttachments: !!m.attachments?.length, channel: m.sourceChannel ?? conversation?.channel })}
            conversationId={m.sourceConversationId ?? id}
            messageKey={m.mid ?? `idx:${m.sourceMessageIndex ?? infoIndex}`}
            index={m.sourceMessageIndex ?? infoIndex}
            readOnly={readOnly}
            onClose={() => setInfoIndex(null)}
          />
        );
      })()}

      {readOnly ? <p className="clean-read-only-chat-note" role="note">Режим просмотра. Отправка сообщений и управление ботом недоступны.</p> : <>
      {/* Проактивно, ДО попытки отправить (владелец 18.09.2026): агент открывает
          клиента с закрытым окном и узнаёт о запрете, только напечатав сообщение и
          получив отказ — см. lib/messagingWindow.ts. Как только придёт настоящий
          отказ сервера, показывается строка ниже с точным текстом Meta, эта
          прячется: дублировать одно предупреждение незачем. */}
      {windowClosed && !reply.isError && (
        <div className="suggest">
          <span className="dot warn"></span>
          <span className="txt">
            Клиент не писал больше суток, поэтому ваше сообщение уже не дойдёт. Позвоните
            {conversation?.clientPhone ? (
              <>
                {" "}
                <CallClientButton
                  clientId={conversation.clientId}
                  phone={conversation.clientPhone}
                  variant="full"
                  label="через CRM"
                  className="lnk"
                />
              </>
            ) : (
              " с личного телефона"
            )}{" "}
            или дождитесь его сообщения.
            {(isGroupedEntry ? replySource?.channel : conversation?.channel) === "WHATSAPP" && " В WhatsApp можно также отправить первое сообщение кнопкой «Написать в WhatsApp» в карточке клиента: она шлёт заранее одобренный текст."}
          </span>
        </div>
      )}

      {/* Причина с сервера, а не общий текст: «канал выключен в Настройках → Meta»
          лечится настройкой, и совет «попробуйте ещё раз» там только вредил.
          Закрытое 24-часовое окно Meta — отдельная, заметная строка (владелец
          22.08.2026: «предупреждение, а не тихая ошибка»). */}
      {reply.isError && isWindowClosedError(reply.error) ? (
        <div className="suggest">
          <span className="dot warn"></span>
          <span className="txt">{reply.error instanceof Error ? reply.error.message : "Окно ответа закрыто."}</span>
        </div>
      ) : (
        reply.isError && (
          <div className="suggest">
            <span className="dot crit"></span>
            <span className="txt">
              {reply.error instanceof Error && reply.error.message
                ? reply.error.message
                : "Не удалось отправить, попробуйте ещё раз."}
            </span>
          </div>
        )
      )}
      {/* Отказ голосового — отдельная строка: причина («в записи услышан номер»)
          принципиально другая, чем у обычной ошибки сети, путать их нельзя. */}
      {voiceError && (
        <div className="suggest">
          <span className="dot crit"></span>
          <span className="txt">{voiceError}</span>
        </div>
      )}
      {/* Отказ фото/видео — та же логика отдельной строки, что у голосового: причина
          («файл слишком большой») не имеет отношения к обычной ошибке сети. */}
      {mediaError && (
        <div className="suggest">
          <span className="dot crit"></span>
          <span className="txt">{mediaError}</span>
        </div>
      )}
      {pendingMedia && (
        <div className="suggest">
          {pendingMedia.type.startsWith("image/") ? (
            <img
              src={mediaPreview ?? undefined}
              alt="Предпросмотр"
              className="w-9 h-9 rounded-sm object-cover shrink-0"
            />
          ) : (
            <Video className="i" />
          )}
          <span className="txt">{pendingMedia.name}</span>
          <button type="button" className="lnk" onClick={() => setPendingMedia(null)}>
            Отменить
          </button>
          <button type="button" className="pill sm" onClick={handleSendMedia}>
            Отправить
          </button>
        </div>
      )}
      {/* Предупреждение ДО отправки, а не после. Иначе агент считает, что клиент
          номер получил, и ждёт звонка впустую. Правило то же самое, что применяет
          сервер (packages/shared/maskContacts) — расходиться им нельзя. */}
      {hasMaskablePhone(text) && (
        <div className="suggest">
          <span className="dot warn"></span>
          <span className="txt">
            Телефон в сообщении будет скрыт, клиент увидит «****». Ссылки и адреса почты уходят как есть.
          </span>
        </div>
      )}

      {clean && !narrow && !royal && <p className="clean-compose-keyboard-hint m-0 px-5 pb-2 text-sm text-gray">Enter — отправить · Shift+Enter — новая строка</p>}
      {royal ? (
        /* СТРОКА ВВОДА КАК В WHATSAPP (владелец 20.11.2026): скрепка, поле и одна
           круглая кнопка — пустое поле даёт микрофон, есть текст — «отправить».
           Канал выбран сам; фото, объект и быстрые ответы — под скрепкой (или «/»
           первым символом). Срока паузы бота в окне нет. */
        <form className="compose ry-chat-compose" onSubmit={(e) => e.preventDefault()}>
          {isGroupedEntry && !replyableSources.length ? (
            <span className="meta" role="note">История доступна только для чтения: для этих каналов нет безопасной отправки из CRM.</span>
          ) : <>
          <div ref={attachMenu.boxRef} className="ry-menu-box ry-attach">
            <button
              ref={attachMenu.buttonRef}
              type="button"
              className="ry-round ry-round-ghost"
              onClick={() => attachMenu.setOpen((v) => !v)}
              disabled={reply.isPending || !replyTargetId}
              aria-haspopup="menu"
              aria-expanded={attachMenu.open}
              aria-label="Прикрепить"
              title="Прикрепить"
            >
              <Paperclip aria-hidden="true" />
            </button>
            {attachMenu.open && (
              <div role="menu" aria-label="Прикрепить" className="ry-menu ry-menu-up" onClick={() => attachMenu.setOpen(false)}>
                <button type="button" role="menuitem" onClick={() => mediaInputRef.current?.click()}>
                  <Video aria-hidden="true" />Фото или видео
                </button>
                {conversation?.clientId && conversation.clientShortId && (
                  <button type="button" role="menuitem" onClick={() => setPropertyPickerOpen(true)}>
                    <Building2 aria-hidden="true" />Объект из базы
                  </button>
                )}
                {quickReplies.length > 0 && (
                  <div role="group" aria-label="Быстрые ответы" className="ry-menu-group">
                    <span className="ry-menu-cap">Быстрые ответы</span>
                    {quickReplies.map((q) => (
                      <button key={q} type="button" role="menuitem" className="ry-menu-quick" onClick={() => { setText(q); composerRef.current?.focus(); }}>{q}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <textarea
            ref={composerRef}
            value={text}
            readOnly={voiceBusy}
            onChange={(e) => {
              const value = e.target.value;
              setText(value);
              // «/» первым символом — быстрые ответы, как в Telegram.
              if (value === "/" && quickReplies.length > 0) attachMenu.setOpen(true);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !narrow) {
                e.preventDefault();
                // Открыто меню скрепки («/» — быстрые ответы): Enter не отправляет «/».
                if (attachMenu.open) return;
                handleSend();
              }
            }}
            rows={1}
            placeholder={replySource && replyableSources.length > 1 ? `Сообщение в ${channelMeta(replySource.channel).label}` : "Сообщение"}
            aria-label="Текст ответа"
          />
          <input
            ref={mediaInputRef}
            type="file"
            accept="image/*,video/*"
            className="hidden"
            onChange={(e) => {
              handlePickMedia(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {conversation?.clientId && conversation.clientShortId && (
            <ChatPropertySend
              clientId={conversation.clientId}
              clientShortId={conversation.clientShortId}
              conversationId={replyTargetId ?? undefined}
              disabled={reply.isPending || conversationLoading || !replyTargetId}
              hideTrigger
              open={propertyPickerOpen}
              onOpenChange={setPropertyPickerOpen}
            />
          )}
          {/* Одна круглая кнопка; на ней — значок канала, куда уйдёт ответ, если
              каналов несколько: виден и во время набора, когда подсказки уже нет. */}
          <span className="ry-send-wrap">
            {text.trim() && !voiceBusy ? (
              <button
                type="button"
                className="ry-round ry-chat-send"
                onClick={handleSend}
                disabled={reply.isPending || !replyTargetId || (attachMenu.open && text.trim() === "/")}
                title="Отправить (Enter)"
                aria-label={replySource && replyableSources.length > 1 ? `Отправить в ${channelMeta(replySource.channel).label}` : "Отправить"}
              >
                <RoyalIcon name="send" />
              </button>
            ) : (
              <VoiceRecordButton
                send={(blob) => voiceMessage.mutateAsync(blob)}
                onError={setVoiceError}
                onBusyChange={setVoiceBusy}
                disabled={reply.isPending || !replyTargetId}
              />
            )}
            {replySource && replyableSources.length > 1 && !voiceBusy && <RoyalChannelBadge channel={replySource.channel} />}
          </span>
          </>}
        </form>
      ) : (
      <form className="compose" onSubmit={(e) => e.preventDefault()}>
        {isGroupedEntry && (conversation?.sources?.some((source) => source.canReply) || isClientGroup) && (
          <label className="sr-only" htmlFor="inbox-reply-source">Канал ответа</label>
        )}
        {/* Новый вид: выбор канала прячется, когда выбирать больше не из чего —
            канал для ответа один и он уже выбран. Логика выбора та же: сам код
            канал не подставляет, поэтому до выбора поле видно всегда, а при
            нескольких каналах — тоже всегда, чтобы можно было сменить. */}
        {isGroupedEntry && (conversation?.sources?.some((source) => source.canReply) || isClientGroup)
          && !(royal && replyableSources.length === 1 && !!replySource) && (
          <select
            id="inbox-reply-source"
            className="inp"
            value={selectedReplySource}
            onChange={(event) => setSelectedReplySource(event.target.value)}
            aria-label="Куда ответить"
          >
            <option value="">Выберите канал для ответа</option>
            {(() => {
              const sources = (conversation?.sources ?? []).filter((source) => source.canReply);
              const labels = replySourceLabels(sources.map((source) => source.channel));
              return sources.map((source, index) => (
                <option key={source.id} value={source.id}>{labels[index]}</option>
              ));
            })()}
          </select>
        )}
        {isGroupedEntry && !(conversation?.sources ?? []).some((source) => source.canReply) && (
          <span className="meta" role="note">История доступна только для чтения: для этих каналов нет безопасной отправки из CRM.</span>
        )}
        <textarea
          ref={composerRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (clean) { e.target.style.height = "auto"; e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`; }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && (!clean || !narrow)) {
              e.preventDefault();
              handleSend();
            }
          }}
          rows={1}
          placeholder={royal
            // Короче: поле в строке ввода нового вида узкое на телефоне, а канал виден выше.
            ? (isGroupedEntry && !replySource ? "Выберите канал" : "Сообщение")
            : isGroupedEntry ? (replySource ? `Ответить в ${replySource.channel ?? "выбранный канал"}` : "Сначала выберите канал") : "Ответ клиенту"}
          aria-label="Текст ответа"
        />
        <input
          ref={mediaInputRef}
          type="file"
          accept="image/*,video/*"
          className="hidden"
          onChange={(e) => {
            handlePickMedia(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="call"
          onClick={() => mediaInputRef.current?.click()}
          disabled={reply.isPending || !replyTargetId}
          title="Прикрепить фото или видео"
          aria-label="Прикрепить фото или видео"
        >
          <Paperclip className="i" />
        </button>
        {/* Быстрая отправка объекта из чата (владелец 21.08.2026) — вся логика в
            компоненте, здесь только кнопка. */}
        {conversation?.clientId && conversation.clientShortId && <ChatPropertySend
          clientId={conversation?.clientId ?? null}
          clientShortId={conversation?.clientShortId ?? null}
          conversationId={replyTargetId ?? undefined}
          disabled={reply.isPending || conversationLoading || !replyTargetId}
        />}
        {/* «Предложить ответ» (черновик от ИИ рядом с микрофоном) убрана
            целиком (владелец 06.09.2026: «зачем она?») — не отвечала на
            явную потребность и добавляла кнопку туда, где должно быть
            просто и понятно, как в обычном мессенджере. */}
        <VoiceRecordButton
          send={(blob) => voiceMessage.mutateAsync(blob)}
          onError={setVoiceError}
          disabled={reply.isPending || !replyTargetId}
        />
        <button
          type="button"
          className={royal ? "ry-round ry-chat-send" : "pill"}
          onClick={handleSend}
          disabled={!text.trim() || reply.isPending || !replyTargetId}
          title="Отправить (Enter)"
          aria-label={royal ? "Отправить" : undefined}
        >
          {royal ? <RoyalIcon name="send" /> : "Отправить"}
        </button>
      </form>
      )}

      {/* Пауза и возвращение бота одной строкой — `.suggest` эталона. Выбор
          длительности остаётся тем же селектом, что и был: меняется одежда,
          не поведение отправки. */}
      {!paused && !royal && (
        <div className="suggest">
          <span className="txt">{royal ? "Ответ ставит бота на паузу:" : "Ваш ответ ставит бота на паузу на"}</span>
          <select
            className="inp"
            style={{ width: "auto" }}
            value={customPauseMinutes !== null ? "custom" : pauseOptionIndex}
            onChange={(e) => {
              if (e.target.value === "custom") {
                const minutes = promptCustomPauseMinutes();
                if (minutes !== null) setCustomPauseMinutes(minutes);
                return;
              }
              setCustomPauseMinutes(null);
              setPauseOptionIndex(Number(e.target.value));
            }}
            aria-label="На сколько ответ ставит бота на паузу"
          >
            {PAUSE_OPTIONS.map((opt, idx) => (
              <option key={opt.label} value={idx}>
                {opt.label}
              </option>
            ))}
            <option value="custom">
              {customPauseMinutes !== null ? `${customPauseMinutes} мин (произвольно)` : "Произвольно…"}
            </option>
          </select>
          {!royal && <span className="txt">он не будет отвечать поверх вас.</span>}
        </div>
      )}
      </>}
      </div>
      </div>
    </section>
  );
}
