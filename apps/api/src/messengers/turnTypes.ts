import type { CustomerPropertyAdmissionResult, ManagedCustomerPropertyReply } from "@royal-home/shared";
import type { CustomerTransportReference } from "../lib/customerConversationScope.js";
import type { AuthenticatedCustomerInput } from "../lib/customerIngressAuthority.js";
import type { CustomerPrincipal } from "../lib/customerPrincipal.js";
import type { AttachmentSource } from "./attachments.js";

/** Channel invocation contracts, independent of the legacy controller. */
export type MessengerChannel = string;

export interface MessengerTurnInput {
  /** Immutable server-selected transport; never customer/model JSON. */
  customerTransport?: CustomerTransportReference;
  /** Runtime-branded FINAL-IN accepted at the server admission boundary. */
  customerAuthenticatedInput?: AuthenticatedCustomerInput;
  /** Server admission captured before ingress enrichment; never model fields. */
  customerPropertyAdmission?: CustomerPropertyAdmissionResult;
  customerPropertyBatch?: CustomerPropertyAdmissionResult[];
  customerPropertyEventKind?: import("../lib/customerPropertyAdmission.js").CustomerPropertyAdmissionInput["eventKind"];
  channel: MessengerChannel;
  subscriberId: string;
  /**
   * В КАКОЙ НАШ аккаунт пришло сообщение (entry[].id у Meta). По нему диалог
   * привязывается к аккаунту, и ответ уходит его маркером — иначе человек,
   * написавший в Royal Home Info, получил бы ответ от основного аккаунта.
   */
  accountExternalId?: string;
  text: string;
  name?: string;
  /**
   * Это написал СОТРУДНИК со своего аккаунта (ответ руками из приложения,
   * routes/webhooks.ts::isOwnAccountSender), а не клиент. В переписку ложится,
   * но в счёт тепловой карты «когда пишут клиенты» не идёт.
   */
  fromStaff?: boolean;
  /** Вложения из вебхука (фото/голосовые). У Instagram и Messenger это прямой адрес
   *  на CDN, у WhatsApp — адрес с маркером в заголовке (см. whatsAppMediaSource). */
  attachments?: AttachmentSource[];
  /**
   * Служебная подсказка модели про ЭТОТ ход: «клиент ответил на нашу историю»,
   * «прислал видео, объект такой-то», «в сообщении чужая ссылка» (messengers/sharedMedia.ts).
   *
   * ОТДЕЛЬНЫМ ПОЛЕМ, А НЕ ПРИКЛЕЕННОЙ К ТЕКСТУ СТРОКОЙ. Раньше её дописывали прямо
   * в text, и она попадала в историю диалога как СЛОВА КЛИЕНТА. Отсюда две беды.
   * В инбосе агент видел вместо реплики человека («🔥») абзац наших инструкций.
   * И хуже: подсказка оставалась в истории навсегда и уходила модели на каждом
   * следующем ходу — ситуативное «задай ОДИН вопрос, сколько комнат» продолжало
   * давить на пятом сообщении, когда разговор шёл уже о рассрочке. Это одна из
   * причин, по которым бот переспрашивал и задавал лишние вопросы.
   *
   * Теперь подсказка живёт ровно один ход: модель её видит, история — нет.
   */
  turnHint?: string;
  /**
   * Клиент переслал публикацию (share / ig_reel) и опознана ли она как НАША.
   *
   * Нужно ровно для отсечки накрутки лайков (см. lib/incomingSpam.ts): чужой ролик
   * с просьбой лайкнуть — рассылка, а наша публикация с любым текстом — наоборот,
   * самый горячий клиент. Без этого признака различить их по тексту нельзя.
   */
  sharedPost?: boolean;
  ourSharedPost?: boolean;
  /**
   * Эта пересланная публикация — та самая НЕОПОЗНАННАЯ (messengers/sharedMedia.ts,
   * isUnresolvedSharedPost): бот её не видит и не может привязать к объекту, то
   * есть этим ходом уйдёт (или ушла бы) фраза «видео не открылось».
   *
   * Нужно для счётчика повтора ниже (ai/replyRepeatGuard.ts,
   * MAX_UNRESOLVED_SHARE_REPLIES) — живой лид «Муродали», четыре чужих рилса
   * подряд без единого слова, и бот на каждый отвечал заново одной и той же
   * фразой. Признак СЕГОДНЯШНЕГО хода: сколько раз это уже было раньше,
   * считаем сами по history ниже, ровно как countPhoneAsks считает просьбы
   * телефона по всей переписке.
   */
  unresolvedSharedPost?: boolean;
  /**
   * ad_id из referral Meta — с какого НАШЕГО объявления человек написал.
   * Сохраняется в диалоге первым касанием (см. rememberAdAttribution) и при
   * привязке к карточке переносится в Client.sourceAdId — цепочка
   * «объявление → лид → сделка» для ROMI по объявлению (ревью 26.08.2026).
   */
  adExternalId?: string;
  /**
   * ctwa_clid из referral WhatsApp (04.10.2026) — идентификатор клика по рекламе
   * click-to-WhatsApp. Пишется первым касанием рядом с adExternalId
   * (BotConversation.adClickId) и ТОЛЬКО хранится: наружу не уходит, ответ бота не меняет.
   */
  adClickId?: string;
  /**
   * О ЧЁМ БЫЛА РЕКЛАМА: "job" (вакансия), "seller" (для собственников — «сдайте/
   * продайте нам свой объект», добавлено 25.09.2026) или "property" (объект для
   * покупателя). Пишется первым касанием и живёт весь разговор (BotConversation.adTopic)
   * — до 17.09.2026 признак вакансии существовал ровно один ход, на сообщении с
   * referral, и уже со второго бот вёл кандидата по сценарию покупателя.
   */
  adTopic?: "job" | "property" | "seller";
  /**
   * Объект, по рекламе которого человек написал (опознан по коду публикации,
   * см. sharedPostContext). Пишется первым касанием и живёт весь разговор:
   * на шаблонную фразу бот отвечает НЕЙТРАЛЬНЫМ вопросом, и объект обязан
   * дождаться хода, на котором человек скажет, что ему нужно.
   */
  adPropertyId?: string | null;
  /**
   * Объект, который вебхук узнал по присланному клиентом посту, ссылке или
   * карточке («голос рынка», 03.10.2026). На ответ бота не влияет вовсе — только
   * след в ConversationProperty: на ПЕРВОМ сообщении диалога ещё нет, когда
   * вебхук узнаёт объект, и без этого поля первое же обращение «по объекту»
   * оставалось бы без связи.
   */
  sharedPropertyId?: string | null;
  /**
   * Сообщение записать, но не отвечать. Сейчас это пустая реакция («🔥» на нашу
   * историю): владелец решил на такое молчать.
   *
   * Именно ЗАПИСАТЬ. Пропустить ход целиком было бы проще, но тогда вместе с
   * ответом пропадает и факт обращения: реакции нет ни в переписке, ни в инбоксе,
   * диалог не поднимается наверх, а человек потом получает напоминание «вы не
   * отвечаете». Молчание бота и слепота CRM — разные вещи.
   */
  silent?: boolean;
  /** Идентификатор входящего сообщения у Meta и то, на что клиент ответил «ответом»
   *  (reply_to.mid). Оба нужны только для цитат в переписке CRM. */
  messageId?: string;
  replyToMessageId?: string;
  /**
   * Реплика УЖЕ лежит в истории диалога — записывать её снова нельзя (18.08.2026,
   * «повторить зависшие диалоги»). Обычный ход вызывается вебхуком на СВЕЖЕЕ
   * сообщение и сам кладёт его в BotConversation.messages (см. saveIncoming ниже).
   * Ручной повтор зависшего хода (routes/errorLog.ts) берёт ПОСЛЕДНЕЕ сообщение
   * клиента из уже сохранённой истории и зовёт этот же ход заново, чтобы получить
   * от модели ответ, — записывать реплику клиента второй раз было бы дублем.
   * Никогда не ставится из webhooks.ts.
   */
  skipSaveIncoming?: boolean;
  /**
   * Это ПОВТОР уже оплаченного хода (кнопка «Повторить зависшим» или задание
   * ai-reply-retry): суточный бюджет ходов НЕ списывается второй раз — деньги
   * стоит попытка, а повтор доводит до конца ту же попытку (правило 03.08.2026).
   */
  retryOfPaidTurn?: boolean;
}

export interface MessengerTurnResult {
  /** Server-only original read principal. Never serialized as customer proof. */
  customerReplyPrincipal?: CustomerPrincipal;
  /** Exact managed fact part; transport must not use the legacy last-MID path. */
  customerPropertyReply?: ManagedCustomerPropertyReply;
  reply: string;
  /** Второй "пузырь" сообщения — бот иногда отвечает 2 короткими сообщениями подряд,
   *  как живой человек, вместо одного длинного блока текста. */
  reply2?: string;
  /** Собрано достаточно, ждём телефон (или уже приняли заявку). */
  ready: boolean;
  /** Заявка оформлена в CRM в этом ходе (или ранее). */
  accepted: boolean;
  /** false — оператор взял диалог на себя, бот-платформа не должна отправлять reply клиенту. */
  shouldReply?: boolean;
  /** true при shouldReply=false — вместо молчания webhooks.ts отвечает реакцией
   *  (см. sendReactionOrEmoji): повторное «спасибо» после уже состоявшегося
   *  прощания, см. isClosingMessage ниже. */
  reactOnly?: boolean;
  /**
   * Причина, по которой ход НАМЕРЕННО прошёл молча (input.silent — пустая
   * реакция клиента или просьба о деньгах), — не то же самое, что «нечего
   * ответить». Нужна webhooks.ts: раньше пустая реакция клиента («🔥») получала
   * смайлик-ответ БЕЗ учёта рубильника канала, паузы оператора и спам-меток —
   * `reactionOnly` считался в webhooks.ts независимо от processMessengerTurn, и
   * отправка смайлика этот результат вовсе не спрашивала (находка №105,
   * ночная проверка 24.09.2026). `null` — молчание не по одной из этих причин
   * (обычная реакция в обычном разговоре), смайлик отправлять можно.
   */
  silenced?: "disabled" | "paused" | "spam" | "held" | null;
  /** ИИ не ответил ни разу (после всех секундных повторов и резервной модели) —
   *  ход поставлен в персистентную очередь (jobs/aiReplyRetry.ts). Маркер нужен
   *  самому повтору: «модель всё ещё лежит» — повод ретраить, а обычное
   *  «отвечать не нужно» (молчание по правилам) — повод остановиться. */
  aiUnavailable?: boolean;
  /** Готовый WAV с озвучкой reply/reply2 (13.09.2026, зеркалим клиента,
   *  прислал ли он голосовое) — см. finishQualifyTurn, messengers/botCapabilities.ts::voiceReplies.
   *  Не заменяет текстовую доставку, отправляется ДОПОЛНИТЕЛЬНО (см. webhooks.ts). */
  replyVoiceWav?: Buffer;
}
