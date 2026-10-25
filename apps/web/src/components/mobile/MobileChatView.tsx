import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertCircle,
  ArrowUp,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  MoreHorizontal,
  Paperclip,
  RotateCw,
  Search,
  Video,
} from "lucide-react";
import { hasMaskablePhone } from "@royal-home/shared";
import {
  isWindowClosedError,
  useAiConversationCost,
  useConversation,
  useGroupedConversation,
  usePauseConversationBot,
  useReplyToConversation,
  useResumeConversationBot,
  useSendVoiceMessage,
  useUploadConversationMediaWithProgress,
} from "../../hooks/useConversations";
import type { ConversationMessage } from "../../types";
import { channelMeta, initialsFromName } from "../../lib/channelMeta";

export function replySourceLabels(channels: Array<string | null>): string[] {
  return channels.map((channel, index) => {
    if (!channel) return `Чат ${index + 1}`;
    const label = channelMeta(channel).label;
    return channels.filter((candidate) => candidate === channel).length > 1 ? `${label} ${index + 1}` : label;
  });
}

export function messageTimeText(at: string | null | undefined): string {
  return at ? dushanbeTime(at) : "Время сообщения неизвестно";
}

export function messageRenderKey(message: ConversationMessage, index: number): string {
  const localKey = message.mid ?? `idx:${message.sourceMessageIndex ?? index}`;
  return message.sourceConversationId ? `${message.sourceConversationId}:${localKey}` : message.mid ?? `msg-${index}`;
}
import { isMessagingWindowClosed, lastInboundMessageAt } from "../../lib/messagingWindow";
import { ContactProfilePanel } from "../ContactProfilePanel";
import { ConversationClientLink } from "../ConversationClientLink";
import { CallClientButton } from "../CallClientButton";
import { MessageAttachments } from "../MessageAttachments";
import { hasVoiceAttachment } from "../../lib/voiceAttachment";
import { MessageSenderBadge } from "../MessageSenderBadge";
import { MessageQuote, quotedMessage } from "../MessageQuote";
import { DeliveryTicks } from "../DeliveryTicks";
import { VoiceRecordButton } from "../VoiceRecordButton";
import { ChatPropertySend } from "../ChatPropertySend";
import { relativeTime } from "../../lib/format";
import { dushanbeDate, dushanbeDayLabel, dushanbeTime } from "../../lib/date";
import { stripBotHints, humanizeAttachmentTags } from "../../lib/botMessages";
import { TranslatableMessageText } from "../MessageTranslateToggle";
import { BotReplyFeedback } from "../BotReplyFeedback";
import { PAUSE_OPTIONS, pausedUntilIso } from "../../lib/botPauseOptions";
import { useCan, useIsReadOnly } from "../../lib/permissions";
import { useAuthStore } from "../../store/auth";
import { useConversationSearch } from "../../hooks/useConversationSearch";
import { useDraftBeforeUpdate } from "../../hooks/useDraftBeforeUpdate";
import { highlightText } from "../../lib/highlightText";
import { rh2AvatarTone } from "../../lib/rh2Avatar";
import { ChannelIcon } from "../ChannelIcon";
import { RH2_SCR_BARE } from "../rh2/Rh2Scope";
import { validateOutgoingMediaPick } from "../../lib/mediaUpload";
import { usePendingMediaUploads, type PendingMediaUpload } from "../../store/mediaUploads";
import { useSellerObject } from "../../hooks/useSellerObject";
import { SellerObjectStrip } from "../chat/SellerObjectStrip";
import { callbackRequestConversationIds, CustomerRequestsPanel } from "../chat/CustomerRequestsPanel";
import { ChatPhotoViewer } from "../chat/ChatPhotoViewer";
import { buildChatPhotoList, chatPhotoOffsetForMessage } from "../../lib/chatPhotos";
import { clearIfUnchanged } from "../../lib/clearSentText";

/**
 * Мобильная переписка — эталон темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/messages.html, секция `#scr-chat`): шапка
 * `.pane-h` с кнопкой «Назад» (в прототипе она `.pill.icon.ghost.only-narrow`,
 * то есть видна ровно на этой ширине), лента `.thread` с пузырями `.bub`,
 * строки-подсказки `.suggest` и композер `.compose`.
 *
 * Экран остаётся `fixed inset-0` (18.08.2026): раньше переписка жила ВНУТРИ
 * скроллящегося содержимого страницы, палец тянул то ленту, то саму страницу, и
 * шапка чата уезжала за экран. Это поведение, а не облик, и оно сохранено.
 *
 * Логика (хуки, паузы, вложения, цитаты, дни по Душанбе, поиск по переписке) —
 * та же, что в десктопном ConversationView: изменились разметка и классы.
 */

const MESSAGES_CHUNK = 60;

/** «Произвольно…» в селектах паузы: спрашивает минуты; null = отменили/ерунда. */
function promptCustomPauseMinutes(): number | null {
  const raw = window.prompt("На сколько минут поставить бота на паузу?", "45");
  if (raw === null) return null;
  const minutes = Math.round(Number(raw.replace(",", ".")));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60 * 24 * 365) return null;
  return minutes;
}

/**
 * ЛЕНТА СООБЩЕНИЙ МОБИЛЬНОГО ИНБОКСА — ОТДЕЛЬНЫЙ memo-КОМПОНЕНТ (06.09.2026, тот
 * же приём, что и ChatMessageList в ClientChatPanel.tsx / ConversationMessageList
 * в pages/Messages.tsx).
 *
 * Раньше вся история рендерилась прямо в теле MobileChatView — том же
 * компоненте, что держит состояние поля ввода `text`. Каждое нажатие клавиши
 * перерисовывало не только textarea, но и весь map по сообщениям (разделители
 * дня, цитаты, вложения, галочки доставки) — на длинной переписке это заметная
 * лишняя работа на каждый символ.
 *
 * Объявлен на МОДУЛЬНОМ уровне — иначе новый тип функции на каждый рендер
 * родителя обнулял бы React.memo. `allMessages` (полный массив — нужен целиком
 * для quotedMessage) и `visibleMessages` меняются только при смене диалога или
 * догрузке истории, но НЕ при печати; `onShowMore` обёрнут в useCallback в
 * родителе по той же причине. Баннер неудачной загрузки диалога (`loadFailed`)
 * и кнопка «Показать более ранние» — часть той же прокручиваемой ленты, поэтому
 * рисуются здесь же, а не в родителе.
 *
 * Прокрутка (`scrollRef`, автоскролл «только если человек и так внизу») осталась
 * в MobileChatView: сам скроллируемый контейнер и его ref не переехали сюда.
 */
const MobileMessageList = memo(function MobileMessageList({
  allMessages,
  visibleMessages,
  hiddenCount,
  onShowMore,
  loadFailed,
  loadError,
  onRetry,
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
}: {
  allMessages: ConversationMessage[];
  visibleMessages: ConversationMessage[];
  hiddenCount: number;
  onShowMore: () => void;
  loadFailed: boolean;
  loadError: unknown;
  onRetry: () => void;
  /** Фото/видео в процессе загрузки (22.09.2026, перенос с десктопа) — тот же
   *  стор и тот же хук, что в Messages.tsx (useUploadConversationMediaWithProgress). */
  pendingUploads: PendingMediaUpload[];
  onRetryUpload: (u: PendingMediaUpload) => void;
  onCancelUpload: (localId: string) => void;
  /** Непусто — подсвечивать найденные поиском вхождения (см. MobileChatView). */
  searchQuery: string;
  /** Абсолютный индекс активного (не просто найденного) совпадения. */
  activeSearchIndex: number | null;
  /** Ссылки на пузыри по абсолютному индексу — только для скролла к найденному. */
  messageRefs: MutableRefObject<Map<number, HTMLDivElement>>;
  /** Для кнопки звонка на месте маски телефона (MessageText). Не меняется при
   *  печати, так что мемоизация не страдает; null у диалога без карточки. */
  clientId: string | null;
  /** Для «Показать перевод на русский» (TranslatableMessageText) — тот же `id`,
   *  которым MobileChatView поднял этот диалог через useConversation(id). */
  conversationId: string;
  readOnly: boolean;
  /** Открыть просмотрщик ВСЕХ фото переписки (21.09.2026) — см. Messages.tsx,
   *  тот же приём, чтобы формулировка смещения не разъехалась между экранами. */
  onOpenPhoto: (absoluteMessageIndex: number, imageIndexInMessage: number) => void;
}) {
  const viewerAgentId = useAuthStore((s) => s.agent?.id);
  return (
    <>
      {loadFailed && (
        <div className="state err">
          <span className="dot crit"></span>
          {loadError instanceof Error && loadError.message
            ? loadError.message
            : "Переписка не загрузилась: сообщения на месте, оборвалась связь."}
          <button
            type="button"
            className="lnk"
            style={{ color: "inherit", textDecoration: "underline" }}
            onClick={onRetry}
          >
            Повторить
          </button>
        </div>
      )}
      {hiddenCount > 0 && (
        <button type="button" onClick={onShowMore} className="pill ghost sm" style={{ alignSelf: "center" }}>
          Показать более ранние ({hiddenCount})
        </button>
      )}
      {visibleMessages.map((m, i) => {
        // Реплика клиента — без служебных подсказок боту (см. lib/botMessages.ts).
        // humanizeAttachmentTags и для поиска тоже: искать по «[вложение: template]»
        // человек не станет, он ищет по тому, что видит.
        const content = humanizeAttachmentTags(m.role === "user" ? stripBotHints(m.content) : m.content, {
          outgoing: m.role !== "user",
        });
        if (!content && !m.attachments?.length) return null;
        const prevAt = visibleMessages[i - 1]?.at;
        const showDay = !!m.at && (!prevAt || dushanbeDate(prevAt) !== dushanbeDate(m.at));
        // Ответ живого человека (агент из CRM или вручную из мессенджера) — тот же
        // пузырь `.me`, но без пунктира: пунктир в эталоне означает бота.
        const humanReply = m.role === "assistant" && (m.by?.kind === "agent" || m.by?.kind === "manual");
        // Настоящий ответ бота — для кнопок оценки (BotReplyFeedback), тот же
        // признак, что и в десктопном инбоксе (Messages.tsx).
        const isBotAnswer = m.role === "assistant" && (!m.by || m.by.kind === "bot");
        // Абсолютный индекс в ПОЛНОЙ истории — для ключа (ниже), для ref
        // (скролл поиска) и чтобы понять, активное ли это совпадение.
        const absoluteIndex = hiddenCount + i;
        const isActiveSearchMatch = absoluteIndex === activeSearchIndex;
        return (
          // Абсолютный индекс, а не относительный: окно скользит, и по
          // относительному ключу аудио/фото перескакивали на чужое
          // сообщение (аудит №4, 27.08).
          <Fragment key={messageRenderKey(m, absoluteIndex)}>
            {showDay && m.at && <span className="day">{dushanbeDayLabel(m.at)}</span>}
            <div
              ref={(el) => {
                if (el) messageRefs.current.set(absoluteIndex, el);
                else messageRefs.current.delete(absoluteIndex);
              }}
              className={`bub${m.role === "user" ? "" : humanReply ? " me" : " me bot"}${
                isActiveSearchMatch ? " ring-2 ring-amber" : ""
              }`}
            >
              {/* Кто отвечал — подписью `.who` эталона, не голым капс-текстом
                  (жалоба владельца 18.08.2026: «CRM» перед сообщением выглядело
                  как отладочная надпись, не как часть интерфейса). */}
              {m.role === "assistant" &&
                (humanReply
                  ? // Своё же сообщение агента не подписываем именем — как в
                    // обычном мессенджере (07.09.2026, просьба владельца). Ответ
                    // КОЛЛЕГИ по-прежнему подписан: директору и другим агентам с
                    // доступом важно знать, кто именно писал.
                    !(m.by?.kind === "agent" && m.by.agentId === viewerAgentId) && (
                      <span
                        className="who"
                        title={
                          m.by?.kind === "agent"
                            ? undefined
                            : "Ответ отправлен прямо в Instagram/Messenger, в обход CRM. Кто именно писал — неизвестно: Meta сообщает только аккаунт страницы, а не сотрудника"
                        }
                      >
                        {m.by?.kind === "agent" ? `${m.by.agentName} · агент` : "Вручную из мессенджера"}
                      </span>
                    )
                  : (
                      <MessageSenderBadge sender={m.by} viewerAgentId={viewerAgentId} className="who" />
                    ))}
              {m.sourceChannel && <span className="meta" data-message-channel style={{ display: "inline-block", marginRight: 6 }}>{channelMeta(m.sourceChannel).label}</span>}
              <MessageQuote quoted={quotedMessage(allMessages, m.replyToMid, allMessages.indexOf(m), m.sourceConversationId)} />
              {/* Расшифровку голосового не показываем — только звук (решение
                  владельца 16.08.2026, см. десктопный ConversationView). */}
              {!hasVoiceAttachment(m.attachments) &&
                (m.sourceChannel === "TELEGRAM_DIRECT" ? content : searchQuery ? (
                  highlightText(content, searchQuery, isActiveSearchMatch)
                ) : (
                  <TranslatableMessageText content={content} message={m} conversationId={m.sourceConversationId ?? conversationId} clientId={clientId} readOnly={readOnly} />
                ))}
              <MessageAttachments
                attachments={m.attachments}
                onImageClick={(imgIdx) => onOpenPhoto(absoluteIndex, imgIdx)}
              />
              {/* Оценка ответа бота прямо в чате (17.09.2026) — тот же компонент,
                  что и в десктопном инбоксе (Messages.tsx), не копия. */}
              {isBotAnswer && !readOnly && m.sourceChannel !== "TELEGRAM_DIRECT" && (
                <BotReplyFeedback
                  conversationId={m.sourceConversationId ?? conversationId}
                  message={m}
                  messageKey={m.mid ?? `idx:${m.sourceMessageIndex ?? absoluteIndex}`}
                  index={m.sourceMessageIndex ?? absoluteIndex}
                />
              )}
              <span className="tm" data-message-time-unknown={!m.at || undefined}>
                  {/* Бот помечен иконкой у времени, а не пунктирной рамкой на
                      весь пузырь (10.09.2026): рамка читалась как «черновик».
                      Стиль рамки снят в theme-2026-mobile-chat.css. */}
                  {m.role === "assistant" && !humanReply && <Bot className="i" aria-label="Ответил бот" />}
                  {messageTimeText(m.at)}
                  {m.role === "assistant" && <DeliveryTicks status={m.deliveryStatus} />}
              </span>
            </div>
          </Fragment>
        );
      })}
      {/* Фото/видео в процессе загрузки — тот же приём и та же разметка, что в
          десктопном инбоксе (Messages.tsx, ConversationMessageList): пузырь
          появляется сразу по нажатию «Отправить», прогресс живёт в
          store/mediaUploads.ts на уровне conversationId и переживает
          переключение диалогов. */}
      {pendingUploads.map((u) => (
        <div key={u.localId} className="bub me">
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

export function MobileChatView({ id, onBack, onPromoteToClient }: { id: string; onBack: () => void; onPromoteToClient?: (clientId: string) => void }) {
  const readOnly = useIsReadOnly();
  const isGrouped = id.startsWith("client:") || id.startsWith("td_");
  // Отказ загрузки самой переписки раньше не читался вовсе: шапка навсегда
  // оставалась с «…», лента пустой, а композер — полностью рабочим, и человек
  // отправлял сообщение в диалог, который не загрузился, не понимая, дошло ли
  // оно и кому. Теперь отказ виден, а поле ввода заперто до успешной загрузки.
  const singleQuery = useConversation(id, { enabled: !isGrouped });
  const groupedQuery = useGroupedConversation(isGrouped ? id : null);
  const conversation = isGrouped ? groupedQuery.data : singleQuery.data;
  useEffect(() => {
    if (!id.startsWith("client:") && conversation?.clientId) onPromoteToClient?.(conversation.clientId);
  }, [id, conversation?.clientId, onPromoteToClient]);
  const loadFailed = isGrouped ? groupedQuery.isError : singleQuery.isError;
  const loadError = isGrouped ? groupedQuery.error : singleQuery.error;
  const refetch = isGrouped ? groupedQuery.refetch : singleQuery.refetch;
  // Полная история — нужна и окну "показать более ранние" ниже, и поиску
  // (useConversationSearch ищет по ВСЕЙ переписке, не только по видимому хвосту).
  // useMemo, а не голый `?? []` (21.09.2026): массив теперь входит в deps двух
  // новых хуков ниже (chatPhotos, openChatPhoto) — без мемоизации пустой
  // fallback создавал бы новую ссылку на каждый рендер (react-hooks/exhaustive-deps).
  const allMessages = useMemo(() => conversation?.messages ?? [], [conversation?.messages]);
  const search = useConversationSearch(allMessages);
  const { close: closeConversationSearch } = search;
  // Проактивно, ДО отправки (владелец 18.09.2026) — см. lib/messagingWindow.ts.
  const [selectedReplySourceId, setSelectedReplySourceId] = useState<string | null>(null);
  const replySources = (conversation?.sources ?? []).filter((source) => source.canReply);
  const replySourceLabelsForSelect = replySourceLabels(replySources.map((source) => source.channel));
  const selectedReplySource = replySources.find((source) => source.id === selectedReplySourceId) ?? null;
  const customerRequestConversationIds = callbackRequestConversationIds(isGrouped
    ? (conversation?.sources ?? []).map((source) => source.id)
    : [id]);
  const replyTargetId = isGrouped ? selectedReplySource?.id ?? null : id;
  const replyChannel = selectedReplySource?.channel ?? conversation?.channel ?? null;
  const sourceMessages = useMemo(
    () => isGrouped && replyTargetId ? allMessages.filter((message) => message.sourceConversationId === replyTargetId) : allMessages,
    [allMessages, isGrouped, replyTargetId],
  );
  const windowClosed = isMessagingWindowClosed(
    replyChannel ?? undefined,
    sourceMessages.length ? lastInboundMessageAt(sourceMessages) : null,
  );
  // Продавец: полоса под шапкой (21.09.2026) и «Добавить объект» в просмотрщике
  // фото — тот же приём, что в десктопном ConversationView (Messages.tsx),
  // второго похода на сервер не заводит (общий queryKey useSellerObject).
  const sellerObject = useSellerObject(conversation?.clientId);
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
  // Фото/видео из чата (22.09.2026, перенос с десктопа Messages.tsx) — тот же
  // хук с прогрессом, тот же стор загрузок на уровне conversationId.
  const mediaUpload = useUploadConversationMediaWithProgress(replyTargetId);
  const pendingUploads = usePendingMediaUploads(replyTargetId);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [pendingMedia, setPendingMedia] = useState<File | null>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const resume = useResumeConversationBot(isGrouped ? null : id);
  const pause = usePauseConversationBot(isGrouped ? null : id);
  const navigate = useNavigate();
  const [text, setText] = useState("");
  // Черновик ответа переживает принудительную перезагрузку при автообновлении
  // (находка ночной проверки 24.09.2026, №246/К2-4) — тот же приём, что в
  // десктопном ConversationView (Messages.tsx), ключ id разговора.
  useDraftBeforeUpdate(id, text, setText);
  const [showInfo, setShowInfo] = useState(false);
  // Меню «⋯» (10.09.2026): лупа, карточка, данные диалога и пауза бота живут в
  // нём, а не четырьмя разнокалиберными контролами в шапке — шапка стала одной
  // строкой 56 px вместо 140 (docs/mobile-ux-plan-10-09.md §2).
  const [menuOpen, setMenuOpen] = useState(false);
  // Подсказка «ваш ответ ставит бота на паузу» — один раз после первой отправки
  // за сессию, а не постоянной строкой над полем: постоянная строка отнимала
  // 44 px у переписки на каждом экране (там же, §2).
  const [pauseHint, setPauseHint] = useState(false);
  // Клавиатура Android поднимает visualViewport, но не меняет layout viewport —
  // fixed-контейнер оставался во всю высоту, и композер уезжал под клавиатуру.
  // Смещение считается от visualViewport и прикладывается к нижней границе.
  const [keyboardInset, setKeyboardInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      setKeyboardInset(inset < 80 ? 0 : inset);
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  const [visibleCount, setVisibleCount] = useState(MESSAGES_CHUNK);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Первый рендер диалога — лента должна открыться на последнем сообщении, а не
  // наверху. Раньше это маскировалось сломанным скроллом (см. комментарий у
  // .thread ниже): контент обрезался по высоте контейнера, и последний экран
  // сообщений просто оказывался единственным видимым. После починки скролла
  // лента честно открывается там, где её оставил браузер (scrollTop:0), и без
  // этого флага смотрящий эффект ниже промахивался: на первом рендере
  // scrollTop ещё 0, а scrollHeight уже полный, «внизу» не считается —
  // прокрутка к низу не срабатывала вовсе.
  const initialScrollDone = useRef(false);
  // Ссылки на пузыри по абсолютному индексу — только для скролла к найденному
  // поиском (см. desktop ConversationView, тот же приём).
  const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  /**
   * Управление ботом — только руководству: агент паузу не назначает и не должен
   * читать про «CRM»/внутреннюю кухню бота, ему нужна просто переписка (жалоба
   * владельца 18.08.2026, скриншот чата: «для агентов это не должно нигде быть»,
   * подтверждено 07.09.2026: «пусть это больше не решают агенты»).
   *
   * ПРОВЕРКА ПО ПРАВУ, А НЕ ПО РОЛИ (07.09.2026, найдено адверсариальной
   * проверкой мержа). `role !== "AGENT"` было верно, пока раздел «Чаты» вообще
   * не был открыт агенту. Тем же днём агенту выдали messages.viewOwn — тот же
   * `role` стал пускать в UI управления ботом того, кому сервер (routes/
   * conversations.ts, /pause и /resume) уже отказывает по messages.view.
   */
  const canManageBot = useCan()("messages.view") && !readOnly && !isGrouped;
  // Стоимость ИИ по разговору (13.09.2026) — служебная цифра, только директору/
  // руководителю (finance.view, тот же рубильник, что у /finance/*); запрос не
  // уходит вовсе, если права нет (см. enabled у useAiConversationCost).
  const seesMoney = useCan()("finance.view");
  const aiCost = useAiConversationCost(isGrouped ? null : id, seesMoney && showInfo && !isGrouped);

  const paused = !!conversation?.pausedUntil && new Date(conversation.pausedUntil).getTime() > Date.now();

  useEffect(() => {
    setVisibleCount(MESSAGES_CHUNK);
    setShowInfo(false);
    setSelectedReplySourceId(null);
    closeConversationSearch();
    initialScrollDone.current = false;
  }, [id, closeConversationSearch]);

  // Прокручиваем вниз только когда человек уже внизу — иначе чтение истории
  // выдёргивало каждым новым сообщением (аудит №4, 27.08). Первое сообщение
  // после открытия диалога — исключение: `atBottom` по scrollTop:0 не
  // считается «внизу», так что без initialScrollDone лента навсегда
  // оставалась бы там, где её открыл браузер (наверху), а не на последней
  // реплике.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !conversation?.messages.length) return;
    if (!initialScrollDone.current) {
      el.scrollTop = el.scrollHeight;
      initialScrollDone.current = true;
      return;
    }
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (atBottom) el.scrollTo({ top: el.scrollHeight });
  }, [conversation?.messages.length]);

  // Переход к найденному поиском сообщению — тот же приём, что в десктопном
  // ConversationView: сперва раздвигаем окно `visibleCount`, если совпадение
  // лежит выше текущего хвоста, и только следующим эффектом (когда ref на
  // нужный узел уже поставлен после перерисовки) скроллим к нему.
  useEffect(() => {
    if (search.activeAbsoluteIndex === null) return;
    setVisibleCount((v) => Math.max(v, allMessages.length - search.activeAbsoluteIndex!));
  }, [search.activeAbsoluteIndex, allMessages.length]);

  useEffect(() => {
    if (search.activeAbsoluteIndex === null) return;
    const el = messageRefs.current.get(search.activeAbsoluteIndex);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [search.activeAbsoluteIndex, search.matches.length, visibleCount]);

  async function handleSend() {
    const value = text.trim();
    if (readOnly || !replyTargetId || !value || reply.isPending) return;
    try {
      // Пауза после ручного ответа — фиксированная «Бессрочно» (последний пресет
      // PAUSE_OPTIONS, то же число, что OPERATOR_REPLY_PAUSE_MS на сервере; решение
      // владельца 18.08.2026), без выбора рядом с полем ввода: в макете это
      // строка-подсказка, а не второй селект паузы — выбор длительности живёт
      // один раз, в шапке диалога.
      await reply.mutateAsync({
        text: value,
        pausedUntil: pausedUntilIso(PAUSE_OPTIONS[PAUSE_OPTIONS.length - 1].minutesFromNow()),
      });
      // Не стираем текст, набранный, пока шёл запрос (WEB-PAGES02).
      setText((cur) => clearIfUnchanged(cur, value));
      // Подсказка про паузу бота — один раз за сессию вкладки, после ПЕРВОЙ
      // удачной отправки, и гаснет сама (см. pauseHint).
      if (canManageBot && !sessionStorage.getItem("rh-chat-pause-hint")) {
        sessionStorage.setItem("rh-chat-pause-hint", "1");
        setPauseHint(true);
        window.setTimeout(() => setPauseHint(false), 3200);
      }
    } catch {
      // Ошибка показана через reply.isError — текст не очищаем.
    }
  }

  /** Файл выбран в скрытом `<input>` — та же проверка, что на десктопе
   *  (lib/mediaUpload.ts::validateOutgoingMediaPick), один источник правды. */
  function handlePickMedia(file: File | undefined) {
    if (!file || readOnly || !replyTargetId) return;
    setMediaError(null);
    const error = validateOutgoingMediaPick(file, replyChannel ?? undefined);
    if (error) {
      setMediaError(error);
      return;
    }
    setPendingMedia(file);
  }

  /** Отправка фото/видео — тот же приём, что на десктопе: пузырь с прогрессом
   *  появляется в ленте сразу, запрос грузится в фоне. */
  function handleSendMedia() {
    if (!pendingMedia || readOnly || !replyTargetId) return;
    mediaUpload.start(pendingMedia, text.trim() || undefined);
    setPendingMedia(null);
    setText("");
  }

  const hiddenCount = Math.max(0, allMessages.length - visibleCount);
  const visibleMessages = hiddenCount > 0 ? allMessages.slice(hiddenCount) : allMessages;
  const meta = conversation?.channel ? channelMeta(conversation.channel) : null;

  /**
   * БЫСТРЫЕ ОТВЕТЫ над полем, пока оно пустое (артефакт de2845f1, лента
   * `.quick`; правила для неё уже лежат в theme-2026-mobile-chat.css, JSX не
   * было).
   *
   * Словаря шаблонов в API нет — ни эндпоинта, ни таблицы (проверено по
   * apps/api/src/routes). Придумывать три фразы за агента нельзя, поэтому лента
   * собирается из ТОГО, ЧТО ОН УЖЕ ПИСАЛ РУКАМИ в этом диалоге: три последние
   * короткие реплики живого человека, без повторов. Реплики бота не берутся —
   * их и так шлёт бот. Нечего показать (новый диалог, отвечал только бот) —
   * ленты нет вовсе: пустая полоса чипов хуже её отсутствия.
   *
   * Ничего не запрашивается: `allMessages` уже загружены для самой переписки.
   */
  // Зависимость — `conversation?.messages`, а не `allMessages`: последнее это
  // `?? []`, то есть НОВЫЙ пустой массив на каждый рендер, и мемоизация с ним
  // не работала бы вовсе (правило react-hooks/exhaustive-deps об этом и
  // предупреждает).
  const quickReplies = useMemo(() => {
    const source = conversation?.messages ?? [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = source.length - 1; i >= 0 && out.length < 3; i--) {
      const m = source[i];
      if (m.role !== "assistant") continue;
      if (m.by?.kind !== "agent" && m.by?.kind !== "manual") continue;
      const t = m.content.trim();
      // Длинные ответы в чип не помещаются и обрезкой теряют смысл.
      if (!t || t.length > 80) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  }, [conversation?.messages]);

  // Стабильная ссылка на функцию (06.09.2026, вынос ленты в MobileMessageList) —
  // инлайн-стрелка в JSX создавалась бы заново на каждый рендер (в том числе на
  // каждое нажатие клавиши в поле ответа) и обнуляла бы React.memo у списка.
  const showMoreMessages = useCallback(() => setVisibleCount((v) => v + MESSAGES_CHUNK), []);
  const retryLoad = useCallback(() => {
    void refetch();
  }, [refetch]);

  return (
    /* 18.08.2026: раньше переписка жила ВНУТРИ обычного скроллящегося контента
       страницы (AppLayout даёт ему запас снизу под нижнюю панель, из-за чего
       страница выше вьюпорта и телефон скроллит её ЦЕЛИКОМ вместе с шапкой
       чата) — палец тянул то ленту сообщений, то саму страницу, шапка уезжала
       за экран (жалоба владельца, скриншот). fixed inset-0 выводит экран
       переписки из этого потока полностью: свой скролл только у ленты
       сообщений, всё остальное стоит на месте, как в обычном мессенджере.
       z-30 — ниже BottomNav (z-40), чтобы нижняя панель осталась поверх. */
    /* z-45 — ВЫШЕ BottomNav (z-40), а не ниже (10.09.2026): внутри диалога
       нижняя панель дублирует «Назад» и отнимает 64 px у переписки; в
       мессенджерах её нет. Запас снизу под неё убран по той же причине, отступ
       под safe-area даёт сам композер (theme-2026-mobile-chat.css). */
    <div className="rh2 screens">
      <div
        className="scr fixed inset-0 z-[45] flex flex-col"
        style={{
          ...RH2_SCR_BARE,
          paddingTop: "max(0px, env(safe-area-inset-top))",
          bottom: keyboardInset ? keyboardInset : undefined,
        }}
      >
        {/* Шапка — ОДНА строка: назад, аватар, имя и канал, меню «⋯». Раньше здесь
            стояли пять контролов (назад, аватар, лупа, «Карточка», нативный select
            паузы), и эталон на узком экране уносил имя на вторую строку — 140 px.
            Всё, кроме навигации и имени, живёт в меню ниже. */}
        <div className="pane-h" data-chat-head>
          <button
            type="button"
            className="pill icon ghost"
            onClick={onBack}
            aria-label="Назад к списку чатов"
          >
            <ChevronLeft className="i" />
          </button>
          <span className="av" style={rh2AvatarTone(conversation?.name)}>
            {initialsFromName(conversation?.name ?? null)}
          </span>
          <div className="t">
            <b>
              <button type="button" className="lk" onClick={() => setShowInfo((v) => !v)}>
                {conversation?.name ?? (loadFailed ? "Переписка не загрузилась" : "…")}
              </button>
            </b>
            {/* Канал — фирменным значком перед подписью, одной строкой с
                остальным (артефакт de2845f1: «⌾ Instagram · 2-комн, Сино · бот
                на паузе»). Универсальная иконка lucide на 12 px не читалась:
                WhatsApp и «Звонок» рисовались одной трубкой.

                «Бот на паузе» теперь видит и агент. Это НЕ отмена решения от
                18.08/07.09 («паузу не решают агенты»): управление осталось за
                правом messages.view — меню «⋯» агенту паузы не показывает.
                Меняется только слово: агент и раньше читал в этом же месте
                «отвечаете вы» — то же самое состояние, названное иначе. В
                артефакте, который владелец 11.09 потребовал «точь-в-точь», это
                экран агента, и там написано «бот на паузе». */}
            <span>
              {conversation?.channel && <ChannelIcon channel={conversation.channel} size={12} />}
              {meta ? `${meta.label}${conversation?.clientPhone ? " · номер в CRM" : ""}` : ""}
              {paused ? " · бот на паузе" : ""}
            </span>
          </div>
          <button
            type="button"
            className="call"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Действия: поиск, карточка, бот"
            aria-expanded={menuOpen}
          >
            <MoreHorizontal className="i" />
          </button>
        </div>

        <SellerObjectStrip clientId={conversation?.clientId} />
        {conversation && <CustomerRequestsPanel conversationIds={customerRequestConversationIds} />}

        {menuOpen && (
          <div data-chat-menu>
            {/* Поиск ВНУТРИ уже открытого диалога (06.09.2026) — тот же приём и та
                же общая логика (useConversationSearch), что в десктопном инбоксе. */}
            <button
              type="button"
              className="pill ghost sm"
              onClick={() => {
                setMenuOpen(false);
                if (search.isOpen) search.close();
                else search.open();
              }}
            >
              <Search className="i" /> Найти в переписке
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
            {/* Щит исходящих (17.09.2026) — та же пометка, что и на десктопе:
                мобильный экран свой, и молча разойтись им нельзя. */}
            {conversation?.shieldPause && (
              <span className="chip warn" title="Пауза снимется сама, как только человек напишет">
                Бот остановлен щитом: {conversation.shieldPause.reasonText}
              </span>
            )}
            {/* Управление ботом — только при messages.view (см. canManageBot выше). */}
            {canManageBot &&
              (paused ? (
                <button
                  type="button"
                  className="pill ghost sm"
                  onClick={() => {
                    resume.mutate();
                    setMenuOpen(false);
                  }}
                  disabled={resume.isPending}
                  title="Сейчас отвечаете вы. Вернуть бота в этот диалог"
                >
                  Вернуть боту
                </button>
              ) : (
                // data-атрибут, а не класс: `.grp` в эталоне — группа ленты событий
                // (рамка снизу, паддинги), и она бы протекла сюда.
                <div data-pause-opts role="group" aria-label="Поставить бота на паузу">
                  {PAUSE_OPTIONS.map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      className="pill ghost sm"
                      disabled={pause.isPending}
                      onClick={() => {
                        pause.mutate(pausedUntilIso(opt.minutesFromNow()));
                        setMenuOpen(false);
                      }}
                    >
                      Пауза: {opt.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="pill ghost sm"
                    disabled={pause.isPending}
                    onClick={() => {
                      const minutes = promptCustomPauseMinutes();
                      if (minutes !== null) pause.mutate(pausedUntilIso(minutes));
                      setMenuOpen(false);
                    }}
                  >
                    Пауза: произвольно…
                  </button>
                </div>
              ))}
          </div>
        )}

        {/* Строка поиска — клиентский поиск по уже загруженным `allMessages`, на
            сервер ничего не уходит (см. useConversationSearch). */}
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
                if (e.key === "Escape") search.close();
                else if (e.key === "Enter" && e.shiftKey) search.goPrev();
                else if (e.key === "Enter") search.goNext();
              }}
              placeholder="Найти в переписке"
              aria-label="Найти в переписке"
            />
            <span className="meta" style={{ fontSize: "var(--fs-13)", color: "var(--muted)" }}>
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
          </div>
        )}

        {/* Данные клиента — по нажатию на имя (в макете этому месту соответствует
            переход в карточку; когда карточки ещё нет, показываем данные здесь). */}
        {showInfo && conversation && (
          <div className="pane-b" style={{ borderBottom: "1px solid var(--line-soft)" }}>
            <div className="list">
              <div className="quiet">
                <span className="txt">
                  Канал: <b>{conversation.channel ? channelMeta(conversation.channel).label : "несколько"}</b>. Имя в соцсети:{" "}
                  <b>{conversation.profileName ?? "не передано"}</b>. Первое сообщение:{" "}
                  <b>{relativeTime(conversation.firstContactAt)}</b>. Сообщений:{" "}
                  <b>{conversation.messages.length}</b>.
                </span>
              </div>
              {seesMoney && aiCost.data?.costUsd != null && (
                <div className="quiet">
                  <span className="txt">
                    ИИ: <b>${aiCost.data.costUsd.toFixed(2)}</b>
                  </span>
                </div>
              )}
              {/* То же досье, что на десктопе: один компонент, одна правда. */}
              {!isGrouped && <ConversationClientLink conversationId={id} clientId={conversation.clientId} readOnly={readOnly} />}
              <ContactProfilePanel contact={conversation.contact} readOnly={readOnly} />
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
            </div>
          </div>
        )}

        {/* Лента сообщений — свой скролл, автопрокрутка к последнему.
            Короткая переписка (1-2 сообщения) не должна повисать наверху с
            гигантской пустотой до композера («что за ужас», скриншот
            18.08.2026) — но `justify-content: flex-end` на самом `.thread`
            для этого не годится: как только сообщений набирается больше
            высоты экрана, оверфлоу уходит НАВЕРХ (в обратную от flex-end
            сторону), а браузер не даёт туда проскроллить — scrollHeight
            контейнера молча схлопывается до clientHeight, и лента перестаёт
            скроллиться целиком (жалоба владельца 18.09.2026, воспроизведено
            живьём). Прижимаем к низу иначе: `.thread` остаётся с обычным
            flex-start, а margin-top:auto ставится на первый ребёнок
            (theme-2026-mobile-chat.css) — эта пара работает и для короткой
            переписки, и для оверфлоу без потери скролла. */}
        <div ref={scrollRef} className="thread" style={{ flex: 1, minHeight: 0 }}>
          <MobileMessageList
            allMessages={allMessages}
            visibleMessages={visibleMessages}
            hiddenCount={hiddenCount}
            onShowMore={showMoreMessages}
            loadFailed={loadFailed}
            loadError={loadError}
            onRetry={retryLoad}
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
          />
        </div>

        {chatPhotoIndex !== null && (
          <ChatPhotoViewer
            photos={chatPhotos}
            index={chatPhotoIndex}
            onClose={() => setChatPhotoIndex(null)}
            onIndexChange={setChatPhotoIndex}
            sellerClientId={!readOnly && sellerObject.data?.isSeller ? conversation?.clientId : null}
          />
        )}

        {readOnly ? <p className="suggest" role="note">Режим просмотра. Отправка сообщений и управление ботом недоступны.</p> : <>
        {/* Проактивно, ДО попытки отправить (владелец 18.09.2026): агент открывает
            клиента с закрытым окном и узнаёт о запрете, только напечатав сообщение и
            получив отказ — см. lib/messagingWindow.ts. Как только придёт настоящий
            отказ сервера, показывается строка ниже с точным текстом Meta, эта
            прячется: дублировать одно предупреждение незачем. */}
        {windowClosed && !reply.isError && (
          <div className="suggest">
            <span className="dot warn"></span>
            <span className="txt">
              Клиент не писал больше суток — WhatsApp/Instagram не пропустят свободный текст. Позвоните
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
            </span>
          </div>
        )}

        {/* Ошибки и предупреждения — над композером, чтобы их видел палец на кнопке.
            Закрытое 24-часовое окно Meta — своя строка (владелец 22.08.2026:
            предупреждение, а не тихая ошибка). */}
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
        {voiceError && (
          <div className="suggest">
            <span className="dot crit"></span>
            <span className="txt">{voiceError}</span>
          </div>
        )}
        {/* Отказ фото/видео — та же строка, что у голосового и что на десктопе:
            причина («файл слишком большой») не связана с обычной ошибкой сети. */}
        {mediaError && (
          <div className="suggest">
            <span className="dot crit"></span>
            <span className="txt">{mediaError}</span>
          </div>
        )}
        {/* Предпросмотр выбранного фото/видео с «Отменить»/«Отправить» — та же
            разметка, что в десктопном ConversationView. */}
        {pendingMedia && (
          <div className="suggest">
            {pendingMedia.type.startsWith("image/") ? (
              <img
                src={URL.createObjectURL(pendingMedia)}
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
        {hasMaskablePhone(text) && (
          <div className="suggest">
            <span className="dot warn"></span>
            <span className="txt">Телефон в сообщении будет скрыт, клиент увидит «****».</span>
          </div>
        )}

        {/* Подсказка про паузу — один раз после первой отправки (см. handleSend),
            а не постоянной строкой: постоянная отнимала 44 px у переписки. Дефолт
            при ручном ответе — «Бессрочно»; выбор длительности — в меню «⋯». */}
        {pauseHint && (
          <div className="suggest" role="status">
            <span className="txt">Бот на паузе в этом диалоге, вернуть можно в меню ⋯.</span>
          </div>
        )}

        {/* Быстрые ответы — лента чипов над полем, ТОЛЬКО пока поле пустое
            (артефакт: `quick.hidden = has`). Нажатие подставляет фразу в поле,
            не отправляя её: агент дописывает имя и правит цифры. */}
        {!text.trim() && quickReplies.length > 0 && !loadFailed && !isGrouped && (
          <div className="quick" data-chat-quick role="group" aria-label="Быстрые ответы">
            {quickReplies.map((q) => (
              <button key={q} type="button" onClick={() => setText(q)}>
                {q}
              </button>
            ))}
          </div>
        )}

        {/* КОМПОЗЕР В ОДНУ СТРОКУ (10.09.2026, docs/mobile-ux-plan-10-09.md §2):
            «+ объект» слева, поле с авторостом до пяти строк, справа микрофон,
            который становится стрелкой «отправить», как только появился текст, —
            как в Telegram. Раньше эталон переносил поле на всю ширину, а кнопки со
            широкой серой «Отправить» — второй строкой: 190 px на блок ввода. */}
        <form className="compose" data-chat-compose onSubmit={(e) => e.preventDefault()} style={isGrouped && !readOnly ? { flexWrap: "wrap" } : undefined}>
          {isGrouped && !readOnly && (
            <div className="pane-b" data-reply-source style={{ flex: "0 0 100%", width: "100%", display: "grid", gap: 6, padding: "8px 0" }}>
              <label className="meta" htmlFor="mobile-reply-source">Куда отправить</label>
              <select
                id="mobile-reply-source"
                className="inp w-full"
                value={selectedReplySourceId ?? ""}
                onChange={(event) => setSelectedReplySourceId(event.target.value || null)}
                disabled={replySources.length === 0 || loadFailed}
              >
                <option value="">Выберите канал</option>
                {replySources.map((source, index) => (
                  <option key={source.id} value={source.id}>{replySourceLabelsForSelect[index]}</option>
                ))}
              </select>
              {replySources.length === 0 && <span className="meta">Для этих переписок отправка из CRM недоступна.</span>}
            </div>
          )}
          {/* ОТПРАВИТЬ ОБЪЕКТ ПРЯМО ИЗ ЧАТА (просьба владельца 21.08.2026,
              совет экспертов 26.08, пункт 10). Кнопка была только на десктопе, а
              агенты живут в телефоне. Компонент один и тот же. */}
          {conversation?.clientId && conversation.clientShortId && <span data-compose-slot>
            <ChatPropertySend
              clientId={conversation?.clientId ?? null}
              clientShortId={conversation?.clientShortId ?? null}
              conversationId={replyTargetId ?? undefined}
              disabled={reply.isPending || loadFailed || !replyTargetId}
            />
          </span>}
          {/* ФОТО/ВИДЕО ИЗ ЧАТА (22.09.2026, перенос с десктопа Messages.tsx —
              баг класса «desktop и mobile ship together»): агенты живут в
              телефоне, а отправить снимок клиенту могли только с компьютера.
              Из галереи — как и на десктопе (владелец 21.09.2026 отменил
              отдельную кнопку камеры на всех экранах загрузки, см. StepMedia). */}
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
          <span data-compose-slot>
            <button
              type="button"
              className="call"
              onClick={() => mediaInputRef.current?.click()}
              disabled={reply.isPending || loadFailed || !replyTargetId}
              title="Прикрепить фото или видео"
              aria-label="Прикрепить фото или видео"
            >
              <Paperclip className="i" />
            </button>
          </span>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              // Авторост: высота по содержимому, потолок — max-height из CSS.
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 124)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            rows={1}
            // Переписка не загрузилась — писать в неё нельзя: иначе человек
            // отправляет вслепую в диалог, содержимого которого он не видел.
            disabled={loadFailed || !replyTargetId}
            placeholder={loadFailed ? "Переписка не загрузилась" : isGrouped && !replyTargetId ? "Выберите канал" : "Сообщение"}
            aria-label="Текст ответа"
          />
          {/* «Предложить ответ» убрана целиком (владелец 06.09.2026: «зачем
              она?») — лишняя кнопка там, где должно быть просто и понятно,
              как в обычном мессенджере. */}
          {text.trim() ? (
            <button
              type="button"
              data-compose-btn="send"
              onClick={handleSend}
              disabled={reply.isPending || loadFailed || !replyTargetId}
              aria-label="Отправить"
            >
              <ArrowUp className="i" strokeWidth={2.2} />
            </button>
          ) : (
            <span data-compose-slot>
              <VoiceRecordButton
                send={(blob) => voiceMessage.mutateAsync(blob)}
                onError={setVoiceError}
                disabled={reply.isPending || loadFailed || !replyTargetId}
              />
            </span>
          )}
        </form>
        </>}
      </div>
    </div>
  );
}
