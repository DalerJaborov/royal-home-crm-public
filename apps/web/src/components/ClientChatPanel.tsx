import { forwardRef, memo, useCallback, useEffect, useRef, useState } from "react";
import { Virtuoso, type ItemProps, type ListProps } from "react-virtuoso";
import { Download, MessageCircle, SendHorizonal, User, X } from "lucide-react";
import { hasMaskablePhone } from "@royal-home/shared";
import { downloadClientConversation, useSendClientMessage, useSendClientVoiceMessage } from "../hooks/useClients";
import { useAiConversationCost } from "../hooks/useConversations";
import { useCan, useIsReadOnly } from "../lib/permissions";
import { useAuthStore } from "../store/auth";
import { VoiceRecordButton } from "./VoiceRecordButton";
import { useMobileUx } from "../hooks/useMobileUx";
import { useScrollLock } from "../hooks/useScrollLock";
import { useSwipeToDismiss } from "./BottomSheet";
import { ConfirmDialog } from "./ConfirmDialog";
import { MessageAttachments } from "./MessageAttachments";
import { TranslatableMessageText } from "./MessageTranslateToggle";
import { DeliveryTicks } from "./DeliveryTicks";
import { BotReplyFeedback } from "./BotReplyFeedback";
import { hasVoiceAttachment } from "../lib/voiceAttachment";
import { MessageSenderBadge, senderPrefix } from "./MessageSenderBadge";
import { MessageQuote, quotedMessage } from "./MessageQuote";
import { CLIENT_SOURCE_LABELS } from "../lib/clientFormat";
import { stripBotHints, humanizeAttachmentTags } from "../lib/botMessages";
import { dushanbeDate, dushanbeDateTime, dushanbeDayLabel, dushanbeTime } from "../lib/date";
import { relativeTime } from "../lib/format";
import type { ConversationMessage } from "../types";
import { Rh2Portal } from "./rh2/Rh2Scope";
import { clearIfUnchanged } from "../lib/clearSentText";
import { inboxConversationId } from "../lib/inboxLink";

/**
 * ПЕРЕПИСКА С КЛИЕНТОМ — отдельная выезжающая панель, а не колонка в карточке.
 *
 * ЧТО БЫЛО НЕ ТАК. Переписка жила внутри левой колонки карточки шириной 280 px и
 * открывалась ссылкой «Показать переписку (37)» в самом её низу. Чтобы прочитать
 * то, ради чего карточку и открывают, агент прокручивал колонку до конца, а потом
 * читал текст, ломающийся по два слова в строке. Владелец 13.08.2026: «надо, чтобы
 * было настоящее окошко ИИ-бота, удобное для переписки с телефона и ПК, чтобы не
 * было потребности переходить в настоящий WhatsApp или Instagram».
 *
 * ПОЧЕМУ ПАНЕЛЬ, А НЕ ЕЩЁ ОДИН ЭКРАН. Переписка нужна вместе с карточкой: агент
 * смотрит требования клиента и тут же отвечает. Отдельный экран (инбокс) для этого
 * уже есть, но рядовому агенту он закрыт правом, и уводить его туда с карточки
 * своего же клиента незачем.
 *
 * ГДЕ КАКОЙ ВИД. На компьютере — боковая панель справа, выезжает сдвигом. На
 * телефоне — шторка почти во весь экран: этим занимается общее правило CSS для
 * `[role="dialog"]` (index.css), поэтому здесь нет ни одного «мобильного» размера,
 * кроме тех, что нужны прокрутке. Смахивание вниз добавляет useSwipeToDismiss —
 * ровно как у остальных окон CRM.
 */

/**
 * ВИРТУАЛИЗАЦИЯ ЛЕНТЫ (06.09.2026) — react-virtuoso (MIT) вместо чанка
 * «последние 60 + кнопка "Показать более ранние"».
 *
 * ПОЧЕМУ НЕ @virtuoso.dev/message-list. Изначально в исследовании этот пакет
 * (готовая обёртка над react-virtuoso под чаты) казался подходящим — self-hosted,
 * работает целиком в браузере. При установке выяснилось: он распространяется по
 * коммерческой лицензии (`license: "Commercial"` в его package.json, EULA
 * virtuoso.dev/message-list-eula) — использовать его на проде значило бы либо
 * купить лицензию, либо нарушить EULA после истечения ознакомительного периода.
 * Ни то, ни другое молча не решается за владельца, поэтому пакет удалён из
 * зависимостей, а вместо него — сам движок под ним, `react-virtuoso` (MIT,
 * бесплатный): даёт ту же виртуализацию рендера, только без готовых чатовых
 * плюшек (imperative prepend и т.п.), которые здесь и не нужны — вся история
 * уже загружена одним запросом (GET /clients/:id), достраивать её с сервера
 * по скроллу эта правка не пытается.
 *
 * ЧТО ИЗМЕНИЛОСЬ ПО СУТИ. Раньше рендерились последние MESSAGES_CHUNK (60)
 * реплик, более ранние — по кнопке. Виртуализация делает это ограничение
 * ненужным: `messages` (весь массив, уже в памяти) передаётся в Virtuoso целиком,
 * а в DOM в любой момент лежат только реально видимые пузыри — на диалоге в
 * тысячи реплик открытие панели не подвешивает вкладку. Кнопка «Показать более
 * ранние» убрана — прокрутка вверх открывает историю сама, ничего докачивать не
 * нужно (весь массив уже в памяти).
 *
 * followOutput (default `true`): Virtuoso автоскроллит к новому сообщению,
 * ТОЛЬКО когда список и так был проскроллен вниз — ровно то же правило «человек
 * и так внизу», которое уже применено в инбоксе (аудит №4, 27.08,
 * pages/Messages.tsx / MobileChatView.tsx). У этой панели раньше было иначе —
 * `el.scrollTop = el.scrollHeight` безусловно на каждое изменение `messages.length`
 * (поллинг каждые 8с, ClientChatPanel.tsx). Сознательно выравниваю с инбоксом:
 * безусловный скролл на виртуализированном списке с историей в тысячи сообщений
 * означал бы, что оператора выдёргивает вниз каждым поллингом ровно в момент,
 * когда он прокрутил вверх перечитать историю, — та самая проблема, которую
 * аудит №4 уже решил для инбокса.
 */
const VirtuosoList = forwardRef<HTMLDivElement, ListProps>(function VirtuosoList(props, ref) {
  // `.thread` прототипа — колонка с зазором и внутренним отступом; здесь его
  // держит сам список Virtuoso, потому что прокруткой владеет она.
  return <div {...props} ref={ref} className="thread" />;
});

/** paddingBottom вместо `gap` на List: элементы ленты — сиблинги в обычном
 *  потоке документа (Virtuoso не оборачивает их общим flex-контейнером), gap
 *  сработал бы только на самом List, а не между Item. 6px = тот же зазор,
 *  что был у gap-1.5 в прежней немой вёрстке. */
const VirtuosoItem = forwardRef<HTMLDivElement, ItemProps<ConversationMessage>>(function VirtuosoItem(
  { item: _item, style, ...rest },
  ref
) {
  return <div {...rest} ref={ref} style={{ ...style, paddingBottom: 6 }} />;
});

export interface ClientConversation {
  /** Conversation.id (BotConversation/TelegramConversation) — не было до
   *  13.09.2026, понадобилось для стоимости ИИ по разговору (AiConversationCostBadge).
   *  ГОЛЫЙ id БЕЗ "tg_"-префикса нарочно: AiLog.conversationId (routes/ai.ts /cost)
   *  пишется как raw TelegramConversation.id (см. jobs/telegramReplyRetry.ts), FK на
   *  него нет. Не путать с conversationId, который ChatMessageList собирает отдельно
   *  для translate/reply-* — тем маршрутам, наоборот, нужен префикс. */
  id: string;
  pausedUntil: string | null;
  channel: string;
  messages: ConversationMessage[];
}

function channelLabel(channel: string): string {
  return CLIENT_SOURCE_LABELS[channel as keyof typeof CLIENT_SOURCE_LABELS] ?? channel;
}

/**
 * СТОИМОСТЬ ИИ ПО РАЗГОВОРУ (13.09.2026, «стоимость разговора нигде не видна» —
 * владелец) — маленькая служебная цифра рядом с названием канала, не выпячиваем:
 * тот же тихий цвет, что у остальных заметок в шапке. Скрыта у рядового агента
 * (finance.view — тот же рубильник, что у /finance/* и мисс-контрола), и молчит,
 * пока по разговору не было ни одного платного вызова или цена модели неизвестна
 * (estimateCostUsd вернул null — «нет данных», не ноль).
 */
export function AiConversationCostBadge({ conversationId }: { conversationId: string }) {
  const can = useCan();
  const seesMoney = can("finance.view");
  const cost = useAiConversationCost(conversationId, seesMoney);
  if (!seesMoney || cost.data?.costUsd == null) return null;
  return <span> · ИИ: ${cost.data.costUsd.toFixed(2)}</span>;
}

/**
 * Сколько реплик клиента ждут ответа ПРЯМО СЕЙЧАС — для счётчика на кнопке
 * «Открыть переписку (N)» (07.09.2026, было `messages.length`, то есть вся
 * переписка целиком вместе с ответами бота — число росло само по себе и не
 * говорило агенту, есть ли вообще что читать).
 *
 * «Непрочитанное» в привычном смысле здесь не годится: сервер помечает
 * диалог прочитанным в момент открытия САМОЙ карточки клиента
 * (routes/clients/card.ts, «ОТКРЫЛ КАРТОЧКУ = ПРОЧИТАЛ ПЕРЕПИСКУ», 31.08.2026)
 * — то есть к моменту, когда рисуется эта кнопка, `readAt` уже обновлён, и
 * «непрочитанных» всегда было бы 0. Считаем вместо этого хвост подряд идущих
 * реплик клиента с конца истории — ровно то, на что бот/агент ещё не ответили.
 * Одно сообщение клиента без ответа даёт 1, три подряд — 3, а если последним
 * писал бот — 0 (агенту нечего наверстывать, `waitingForReply` тоже погаснет).
 */
export function pendingReplyCount(messages: ConversationMessage[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") break;
    count++;
  }
  return count;
}

/**
 * ЛЕНТА СООБЩЕНИЙ — ВИРТУАЛИЗИРОВАННЫЙ КОМПОНЕНТ (05.09→06.09.2026).
 *
 * Изначально (05.09) это был обычный map по срезу сообщений в отдельном
 * React.memo — печать в поле ответа не перерисовывала ленту. Теперь под тем же
 * именем — обёртка над react-virtuoso: в DOM в любой момент лежат только
 * реально видимые пузыри (см. комментарий у VirtuosoList/VirtuosoItem выше).
 *
 * ВАЖНО: React.memo здесь НЕ следствие виртуализации, а отдельная, всё ещё
 * нужная защита. `<Virtuoso itemContent={...}>` сам по себе не спасает от
 * перерисовки — если `ChatMessageList` перерисовывается при каждом нажатии
 * клавиши в поле ответа (родитель ClientChatPanel держит состояние `text`),
 * инлайн-функция `itemContent` создавалась бы заново на каждый рендер, и
 * Virtuoso честно перевызывал бы её для всех СМОНТИРОВАННЫХ (видимых) строк —
 * виртуализация ограничивает количество строк, но не отменяет лишнюю работу
 * на них. `memo` на самом компоненте + `useCallback` на `renderItem` (ниже)
 * закрывают именно это: пока `messages` не меняется, ни компонент, ни его
 * itemContent не пересоздаются.
 *
 * Модульный уровень — по той же причине, что и раньше: объявленный ВНУТРИ
 * ClientChatPanel компонент создавался бы заново при каждом её рендере, и
 * React.memo не спасал бы — сравнивает не тип, а то, что тип остался тем же.
 * `messages` — полный массив, не срез: и для `quotedMessage` (цитата может
 * быть в любом месте истории), и потому что Virtuoso сам решает, что рендерить.
 *
 * `key={selected}` на самом компоненте (ставит родитель, ClientChatPanel) —
 * принудительный ремонт при смене вкладки-канала: разные диалоги не должны
 * наследовать друг у друга положение скролла или измеренные высоты сообщений.
 */
const ChatMessageList = memo(function ChatMessageList({
  messages,
  clientId,
  conversationId,
  feedbackConversationId,
  readOnly,
}: {
  messages: ConversationMessage[];
  /** Для кнопки звонка на месте скрытого номера (MessageText). */
  clientId: string;
  /** Для «Показать перевод на русский» (TranslatableMessageText) — тот же "tg_"-префикс,
   *  что у остального инбокса (TG_PREFIX в routes/conversations.ts), не голый
   *  ClientConversation.id: POST /conversations/:id/translate различает
   *  BotConversation/TelegramConversation по префиксу, а без него Telegram-диалог
   *  тихо 404-ился вместо честного «перевод не поддержан». */
  conversationId?: string | null;
  /**
   * Для оценки ответа бота (BotReplyFeedback) — ОТДЕЛЬНО от `conversationId` выше:
   * тот несёт «сырой» Conversation.id как есть (перевод и стоимость ИИ читают его
   * так же для обеих таблиц), а маршрут `/conversations/:id/reply-feedback` живёт
   * в общем инбоксе и различает BotConversation/TelegramConversation по префиксу
   * `tg_` (см. routes/conversations.ts, TG_PREFIX). Без этого префикса оценка
   * телеграм-диалога стучалась бы не в ту таблицу и всегда отвечала бы 404.
   */
  feedbackConversationId?: string | null;
  readOnly: boolean;
}) {
  const viewerAgentId = useAuthStore((s) => s.agent?.id);
  const renderItem = useCallback(
    (index: number, m: ConversationMessage) => {
      // Реплика клиента — без служебных подсказок боту, как в инбоксе
      // (lib/botMessages.ts) — до 02.08.2026 они дописывались прямо в текст и
      // до сих пор лежат в старых записях. humanizeAttachmentTags превращает
      // техническое «[вложение: template]» в человеческое — той же правкой,
      // что и Messages.tsx/MobileChatView.tsx (07.09.2026, было пропущено
      // именно здесь: панель на карточке жила отдельным путём от инбокса).
      const content = humanizeAttachmentTags(m.role === "user" ? stripBotHints(m.content) : m.content, {
          outgoing: m.role !== "user",
        });
      // Разделитель дня — та же логика, что в инбоксе (Messages.tsx,
      // MobileChatView.tsx): сравниваем с ПРЕДЫДУЩИМ сообщением полного
      // массива, `index` здесь уже абсолютный (Virtuoso передаёт позицию в
      // полном `data`, не в видимом окне).
      const prevAt = messages[index - 1]?.at;
      const showDay = !!m.at && (!prevAt || dushanbeDate(prevAt) !== dushanbeDate(m.at));
      return (
        <>
          {/* Подпись дня — `.day` прототипа (messages.html): плашка по центру ленты. */}
          {showDay && m.at && (
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 6 }}>
              <span className="day">{dushanbeDayLabel(m.at)}</span>
            </div>
          )}
          {/* Пузырь `.bub`; ответ компании — `.bub.me` (справа), ответ бота ещё и
              `.bub.bot` (пунктирная рамка), ровно как в прототипе. */}
          <div style={{ display: "flex", justifyContent: m.role === "user" ? "flex-start" : "flex-end" }}>
            <div
              className={`bub${m.role === "user" ? "" : " me"}${
                m.role !== "user" && (!m.by || m.by.kind === "bot") ? " bot" : ""
              }`}
              style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
            >
              <span className="who">
                {m.role === "assistant" ? (
                  /* Без `pill`: фон и кегль подписи уже задаёт `.bub .who`
                     прототипа, а свой пилл наложил бы поверх второй фон. */
                  <MessageSenderBadge sender={m.by} viewerAgentId={viewerAgentId} />
                ) : (
                  <>
                    <User className="i" /> Клиент
                  </>
                )}
              </span>
              {/* На что этот ответ — ищем по всей ленте, `index` уже абсолютный
                  (Virtuoso всегда передаёт позицию в полном массиве `data`). */}
              <MessageQuote quoted={quotedMessage(messages, m.replyToMid, index)} rh2 />
              {/* Текст расшифровки голосового агенту и в CRM не показываем (решение
                  владельца 16.08.2026) — только сам звук: расшифровка бывает выдумана
                  (тихая запись даёт Gemini повод сочинить фразу), а в базе она всё
                  равно остаётся — боту она нужна как память уже проговоренного. */}
              {!hasVoiceAttachment(m.attachments) && (
                <TranslatableMessageText content={content} message={m} conversationId={conversationId} clientId={clientId} readOnly={readOnly} rh2 />
              )}
              {/* Фото и голосовые клиента видно прямо здесь: агенту со своим
                  клиентом инбокс закрыт правом, и это его единственное окно. */}
              <MessageAttachments attachments={m.attachments} rh2 />
              {/* Оценка ответа бота прямо в чате (17.09.2026) — тот же компонент,
                  что и в инбоксе (Messages.tsx), не копия. */}
              {!readOnly && m.role === "assistant" && (!m.by || m.by.kind === "bot") && feedbackConversationId && (
                <BotReplyFeedback
                  conversationId={feedbackConversationId}
                  message={m}
                  messageKey={m.mid ?? `idx:${index}`}
                  index={index}
                />
              )}
              {m.at && (
                <span className="tm">
                  {dushanbeTime(m.at)}
                  {/* Галочки доставки — как в инбоксе (аудит №4, 27.08): только у
                      ответов компании, статус приходит от мессенджер-платформы. */}
                  {m.role === "assistant" && <DeliveryTicks status={m.deliveryStatus} rh2 />}
                </span>
              )}
            </div>
          </div>
        </>
      );
    },
    [messages, clientId, conversationId, viewerAgentId, feedbackConversationId, readOnly]
  );

  if (messages.length === 0) {
    return (
      <div className="empty">
        <span className="ic">
          <MessageCircle className="i" />
        </span>
        <p>Сообщений пока нет.</p>
        <span className="sub">{readOnly ? "Здесь появится переписка клиента." : "Напишите первым, ответ клиента придёт сюда же, в CRM."}</span>
      </div>
    );
  }

  return (
    <Virtuoso
      style={{ height: "100%" }}
      data={messages}
      // Дефолт true: скроллит к новому сообщению, ТОЛЬКО если список и так был
      // внизу — см. комментарий у объявления VirtuosoList выше (сознательное
      // выравнивание с правилом инбокса, аудит №4).
      followOutput
      // Открываем панель сразу внизу истории — как в любом мессенджере.
      initialTopMostItemIndex={messages.length - 1}
      computeItemKey={(index, m) => m.mid ?? `msg-${index}`}
      components={{ List: VirtuosoList, Item: VirtuosoItem }}
      itemContent={renderItem}
    />
  );
});

export function ClientChatPanel({
  clientId,
  clientShortId,
  clientName,
  conversations,
  autoFocusReply = false,
  onClose,
  agentActivelyAssigned = false,
}: {
  clientId: string;
  /** Короткий числовой ID клиента — тот же, что в адресе карточки. Нужен ровно
   *  для экспорта переписки (GET /clients/:id/conversation-export ждёт его,
   *  не UUID) — остальная панель работает по clientId. */
  clientShortId: number;
  clientName: string;
  /** Все диалоги клиента (19.08.2026) — раньше был ровно один: у карточки
   *  может быть несколько каналов сразу (Instagram + WhatsApp), переключатель
   *  ниже показывает их все, по умолчанию открыт самый свежий (список уже
   *  отсортирован вызывающей стороной). */
  conversations: ClientConversation[];
  /** Открыли, чтобы ответить прямо сейчас (исход «Ждёт варианты») — ставим курсор
   *  в поле ответа. При обычном открытии этого не делаем: на телефоне фокус
   *  выбрасывает клавиатуру поверх переписки, которую человек пришёл читать. */
  autoFocusReply?: boolean;
  onClose: () => void;
  /** Клиент закреплён за живым агентом ПРЯМО СЕЙЧАС (05.09.2026) — сервер
   *  (messengers/conversation.ts::hasActiveAssignedAgent) молчит бота по этому
   *  же признаку, не дожидаясь записи в pausedUntil. Без этого пропа панель
   *  показывала бы «Бот отвечает сам», хотя бот уже не ответит. */
  agentActivelyAssigned?: boolean;
}) {
  // Фон под панелью неподвижен: промах пальцем мимо шторки иначе уводит карточку
  // под ней (см. hooks/useScrollLock.ts).
  useScrollLock();
  const isMobile = useMobileUx();
  const readOnly = useIsReadOnly();
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [text, setText] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [selected, setSelected] = useState(0);
  const conversation = conversations[selected] ?? conversations[0];
  // Текст и голосовое уходят в диалог ВЫБРАННОЙ вкладки, а не в «самый живой» (WEB-PAGES01).
  const sendConversationId = inboxConversationId(conversation.channel, conversation.id);
  const sendMessage = useSendClientMessage(clientId, sendConversationId);
  const voiceMessage = useSendClientVoiceMessage(clientId, sendConversationId);
  /** Панель ВЫЕЗЖАЕТ, а не возникает: первый кадр рисуется сдвинутой за правый
   *  край, следующий — на месте. Без задержки в кадр браузер применил бы оба
   *  состояния разом и перехода не было бы вовсе. */
  const [entered, setEntered] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  const messages = conversation.messages ?? [];
  const pausedAt = conversation.pausedUntil ? new Date(conversation.pausedUntil) : null;
  const isPaused = agentActivelyAssigned || (!!pausedAt && pausedAt.getTime() > Date.now());

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  /**
   * НЕДОПИСАННЫЙ ОТВЕТ КЛИЕНТУ НЕ ВЫБРАСЫВАЕМ МОЛЧА (аудит 22.08.2026, раунд 5).
   *
   * И Escape, и клик мимо панели раньше закрывали её сразу — вместе с набранным
   * текстом. Это ответ живому человеку, часто длинный и обдуманный; промах
   * пальцем стирал его без следа. Тот же вывод, к которому уже пришли в
   * AddInteractionModal (там по этой причине убрали закрытие по клику мимо) и
   * в ClientFormModal (там спрашивают подтверждение).
   */
  const dirty = text.trim().length > 0;
  const requestClose = useCallback(() => {
    if (dirty) setConfirmClose(true);
    else onClose();
  }, [dirty, onClose]);
  const swipe = useSwipeToDismiss(isMobile, requestClose);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") requestClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  // К последнему сообщению — как в любом мессенджере. И при открытии, и когда
  // приходит новое (пока список внизу) — теперь заботится Virtuoso сама
  // (initialTopMostItemIndex + followOutput, см. ChatMessageList выше).

  useEffect(() => {
    if (autoFocusReply && !readOnly) replyRef.current?.focus();
  }, [autoFocusReply, readOnly]);

  function send() {
    const value = text.trim();
    if (readOnly || !value || sendMessage.isPending) return;
    // Паузу боту ставит сервер (см. useSendClientMessage): агент вступил в
    // переписку — двух ответов подряд клиент получить не должен.
    // Не стираем текст, набранный, пока шёл запрос (WEB-PAGES02).
    sendMessage.mutate(value, { onSuccess: () => setText((cur) => clearIfUnchanged(cur, value)) });
  }

  /** Экспорт переписки (13.09.2026) — .json целиком, все каналы разом, с
   *  таймингами там, где они есть (см. downloadClientConversation). Ошибку
   *  просто пишем в консоль и молча снимаем "идёт" — файл, который иногда не
   *  скачался, лучше диагностировать логом, чем занимать панель модалкой ради
   *  редкого сетевого сбоя. */
  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    try {
      await downloadClientConversation(clientShortId, "json");
    } catch (err) {
      console.error("[chat-export]", err instanceof Error ? err.message : err);
    } finally {
      setExporting(false);
    }
  }

  /**
   * ОБЛИК — тема «Royal Home 2026» (09.09.2026). Панель — это `<aside class="sheet
   * right">` прототипа (screens/client-detail.html, шторки внизу файла) поверх
   * `.sheet-back`; лента внутри — `.thread` с пузырями `.bub`/`.bub.me`/`.bub.bot`
   * и подписью дня `.day`, поле ответа — `.compose` (screens/messages.html).
   *
   * `rh2` СТОИТ НА САМОМ КОРНЕ ПОРТАЛА, а не унаследован от карточки: портал
   * рендерится в document.body, то есть ВНЕ `.rh2` вызывающего экрана, и без
   * этого класса ни один селектор макета до панели бы не достал. Безусловно —
   * панель рендерит только ClientDetail.tsx (проверено грепом 09.09), других
   * хозяев у неё нет.
   */
  return (
    <Rh2Portal>
      <div
        className={`sheet-back transition-opacity duration-200 ${entered ? "opacity-100" : "opacity-0"}`}
        onClick={requestClose}
      >
        {/* role="dialog" — и для скринридера, и чтобы на телефоне панель стала
            шторкой снизу: правило одно на все окна CRM (index.css). */}
        <div
          ref={swipe.ref}
          {...swipe.handlers}
          role="dialog"
          aria-modal="true"
          aria-label={`Переписка с ${clientName}`}
          onClick={(e) => e.stopPropagation()}
          className={`sheet right transition-transform duration-300 ${
            entered ? "sm:translate-x-0" : "sm:translate-x-full"
          }`}
        >
          <div className="sheet-h">
            <div className="t" style={{ minWidth: 0, flex: 1 }}>
              <b style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {clientName}
              </b>
              <span className="note">
                Переписка · {channelLabel(conversation.channel)}
                <AiConversationCostBadge conversationId={conversation.id} />
              </span>
            </div>
            <button
              className="pill ghost icon"
              type="button"
              onClick={handleExport}
              disabled={exporting}
              aria-label="Экспортировать переписку"
              title="Скачать всю переписку клиента (.json, все каналы, с таймингами)"
            >
              <Download className="i" />
            </button>
            <button className="pill ghost icon" type="button" onClick={requestClose} aria-label="Закрыть переписку">
              <X className="i" />
            </button>
          </div>

          {/* Переключатель каналов (19.08.2026) — только когда их правда несколько:
              одна вкладка сама по себе не несла бы смысла, только занимала строку.
              `.seg` прототипа — тот же переключатель срезов, что в messages.html. */}
          {conversations.length > 1 && (
            <div className="pane-b">
              <div className="seg" role="tablist" aria-label="Каналы клиента">
                {conversations.map((c, idx) => (
                  <button
                    key={`${c.channel}-${idx}`}
                    type="button"
                    role="tab"
                    aria-selected={idx === selected}
                    onClick={() => setSelected(idx)}
                  >
                    {channelLabel(c.channel)}
                  </button>
                ))}
              </div>
            </div>
          )}

            {/* УПРАВЛЕНИЯ БОТОМ ЗДЕСЬ БОЛЬШЕ НЕТ (владелец 07.09.2026).
                Дословно: «пусть это больше не решают агенты, а только админ и
                директор, и сам ИИ решает, когда боту возвращаться к общей логике».
                Раньше в шапке переписки стояли плашка «Бот молчит, пока клиент у
                вас» и кнопка «Вернуть боту» — панель выглядела пультом управления
                роботом вместо мессенджера, а решение о возврате бота принимал тот,
                кому его принимать не по чину.
                Никто не остаётся запертым: бот и так молчит, пока клиент закреплён
                за живым агентом, и возвращается сам, когда закрепление снято или
                вышел срок паузы. Руководству выключатель остался в разделе
              «Сообщения» — он открыт правом messages.view, которого у агента нет. */}

          {/* Лента. `basis` вместо `flex-1`: у шторки высота определяется содержимым
              (общее правило CSS ставит height:auto), и лента с базой 0 схлопнулась
              бы в ноль — панель показала бы шапку и поле ответа без единого
              сообщения. 62dvh подобраны замером: вместе с шапкой и полем ответа
              шторка упирается ровно в свой потолок 92dvh, то есть занимает телефон
              почти целиком, как и просил владелец. Больше не нужно: лишнее всё
              равно срежет max-height, а при появлении клавиатуры лента ужимается
              сама (shrink + min-h-0), не выталкивая поле ввода за край экрана.
              overflow-y-auto/px-3/py-3/gap-1.5 сюда больше не ставим — прокрутку и
              внутренние отступы ленты теперь держит сама Virtuoso (VirtuosoList,
              см. выше): двойной скролл-контейнер (этот div + Virtuoso внутри)
              сломал бы виртуализацию — Virtuoso должна быть единственным
              владельцем скролла ленты. */}
          <div className="thread" style={{ minHeight: 0, flex: "1 1 62dvh", padding: 0, display: "block" }}>
            {/* key={selected} — принудительный ремонт при смене вкладки-канала:
                разные диалоги не должны наследовать друг у друга положение
                скролла и измеренные высоты сообщений (см. ChatMessageList выше). */}
            <ChatMessageList
              key={selected}
              messages={messages}
              readOnly={readOnly}
              clientId={clientId}
              conversationId={
                conversation ? (conversation.channel === "TELEGRAM" ? `tg_${conversation.id}` : conversation.id) : null
              }
              feedbackConversationId={
                conversation ? (conversation.channel === "TELEGRAM" ? `tg_${conversation.id}` : conversation.id) : null
              }
            />
          </div>

          {/* data-sheet-footer — общее правило CSS прижимает поле ответа к низу
              шторки и уводит его из-под системной полосы жестов. */}
          {readOnly ? (
            <p data-sheet-footer role="note">Режим просмотра. Отправка сообщений недоступна.</p>
          ) : <form
            data-sheet-footer
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
            className="compose"
            style={{ flexWrap: "wrap" }}
          >
            {/* Предупреждение ДО отправки — тем же правилом, что применит сервер.
                Тихой строкой `.quiet`, не карточкой (договор §6.1). */}
            {hasMaskablePhone(text) && (
              <div className="quiet warn" style={{ flex: "1 1 100%" }}>
                <span className="dot warn" />
                <span className="txt">
                  Телефон в сообщении будет скрыт, клиент увидит «****». Ссылки и почта уходят как есть.
                </span>
              </div>
            )}
            {sendMessage.isError && (
              <div className="quiet crit" style={{ flex: "1 1 100%" }}>
                <span className="dot crit" />
                <span className="txt">
                  {sendMessage.error instanceof Error && sendMessage.error.message
                    ? sendMessage.error.message
                    : "Не удалось отправить, попробуйте ещё раз."}
                </span>
              </div>
            )}
            {voiceError && (
              <div className="quiet crit" style={{ flex: "1 1 100%" }}>
                <span className="dot crit" />
                <span className="txt">{voiceError}</span>
              </div>
            )}
            <textarea
                ref={replyRef}
                id="client-chat-reply"
                rows={1}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  // Enter отправляет, Shift+Enter переносит строку — как в мессенджерах.
                  // На телефоне это не мешает: там у клавиатуры своя кнопка переноса.
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                maxLength={2000}
              placeholder={`Написать в ${channelLabel(conversation.channel)}…`}
            />
            <VoiceRecordButton
              send={(blob) => voiceMessage.mutateAsync(blob)}
              onError={setVoiceError}
              disabled={sendMessage.isPending}
            />
            <button
              className="pill"
              type="submit"
              disabled={sendMessage.isPending || !text.trim()}
              title="Отправить (Enter)"
            >
              <SendHorizonal className="i" />
            </button>
          </form>}
        </div>

        {confirmClose && (
          <ConfirmDialog
            title="Закрыть переписку?"
            description="Набранный ответ клиенту не отправлен и будет потерян."
            confirmLabel="Закрыть"
            onConfirm={onClose}
            onCancel={() => setConfirmClose(false)}
          />
        )}
      </div>
    </Rh2Portal>
    );
}

/**
 * Кнопка входа в переписку на самой карточке.
 *
 * Показывает то, ради чего её открывают: кто написал последним, когда и что
 * именно. Без превью «Открыть переписку (37)» — это обещание неизвестно чего, и
 * агент жмёт её вслепую или не жмёт вовсе.
 */
export function ClientChatCard({
  conversations,
  onOpen,
  agentActivelyAssigned = false,
}: {
  /** Все диалоги клиента — превью показывает самый свежий (список уже
   *  отсортирован), а рядом с названием — сколько их всего, если больше одного. */
  conversations: ClientConversation[];
  onOpen: () => void;
  /** См. тот же проп у ClientChatPanel — клиент закреплён за живым агентом
   *  прямо сейчас, бот молчит по этому признаку, а не только по pausedUntil. */
  agentActivelyAssigned?: boolean;
}) {
  const conversation = conversations[0];
  const messages = conversation?.messages ?? [];
  const last = messages[messages.length - 1];
  const pausedAt = conversation?.pausedUntil ? new Date(conversation.pausedUntil) : null;
  const isPaused = agentActivelyAssigned || (!!pausedAt && pausedAt.getTime() > Date.now());
  // Хвост неотвеченных реплик клиента — см. pendingReplyCount выше. >0 сюда же
  // отвечает на «ждёт ответа»: одно и то же число, один источник правды.
  const pending = pendingReplyCount(messages);
  const waitingForReply = pending > 0;

  /**
   * ОБЛИК — тема «Royal Home 2026» (09.09.2026): вкладка «Переписка» прототипа
   * (client-detail.html, `data-panel-id="chat"`) — это `.list` со строками
   * `.row` и подписью `.state` под ними. Ровно это здесь и собрано: последняя
   * реплика строкой, вход в панель — кнопкой `.pill`. Компонент рендерит только
   * карточка клиента, переключателя облика не требуется.
   */
  return (
    <>
      <div className="sec-h">
        <h2>
          <MessageCircle className="i" /> Переписка
        </h2>
        <span className="note">
          {channelLabel(conversation.channel)}
          {conversations.length > 1 && ` +${conversations.length - 1}`}
        </span>
      </div>

      <div className="list">
        {last ? (
          <div className="row">
            <span className="av">{last.role === "user" ? "К" : "RH"}</span>
            <div className="t">
              <b>{last.content?.trim() || "вложение без текста"}</b>
              <span>
                {last.role === "user" ? "Клиент" : senderPrefix(last.by)}
                {last.at ? `, ${relativeTime(last.at)}` : ""}
              </span>
            </div>
            {waitingForReply && <span className="chip warn">ждёт ответа</span>}
          </div>
        ) : (
          <div className="state">Клиент ещё ничего не написал. Написать ему можно первым, прямо отсюда.</div>
        )}
      </div>

      <div className="state">
        {messages.length > 0 ? `Показана последняя реплика из ${messages.length}. ` : ""}
        <button className="pill sm" type="button" onClick={onOpen}>
          <MessageCircle className="i" />
          {pending > 0
            ? `Открыть переписку (${pending})`
            : messages.length > 0
              ? "Открыть переписку"
              : "Написать клиенту"}
        </button>
      </div>

      {/* СОСТОЯНИЕ БОТА С КАРТОЧКИ УБРАНО ПОЛНОСТЬЮ (владелец 07.09.2026).
          06.09 отсюда ушло «Бот отвечает сам», теперь уходит и «Бот молчит»:
          владелец просит переписку, похожую на мессенджер, а не на пульт
          управления роботом. Кто отвечает — видно по самим репликам, они
          подписаны. Выключатель остался в самой панели переписки, значком. */}
    </>
  );
}
