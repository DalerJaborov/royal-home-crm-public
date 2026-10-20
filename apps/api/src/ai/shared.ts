import { prisma } from "../db.js";
import { estimateCostUsd } from "./pricing.js";
import type { CustomerPropertyAdmission, CustomerPropertyDelivery, CustomerPropertyReference } from "@royal-home/shared";

/**
 * Общее для всех поставщиков ИИ: типы диалога, разбор JSON из ответа модели и
 * запись вызова в журнал.
 *
 * Живёт отдельным модулем, потому что этим пользуются оба клиента — Claude
 * (`client.ts`) и Gemini (`geminiClient.ts`), а `client.ts` при этом сам
 * подключает Gemini по выбору в настройках. Пока общее лежало в `client.ts`,
 * два модуля импортировали друг друга: цикл работал, но делал порядок
 * инициализации неявным. Теперь оба зависят от этого модуля, а он — ни от кого
 * из них.
 */

/**
 * Вложение реплики — для показа в переписке CRM. Ровно одно из двух полей:
 *  - `file` — то, что ПРИСЛАЛ клиент: имя файла в закрытом хранилище, а не адрес;
 *    выдаётся только через маршрут с проверкой права (lib/privateFiles.ts);
 *  - `url` — то, что ОТПРАВИЛ бот: путь внутри `/uploads` к фотографии нашего же
 *    объекта. Она и так открыта на сайте, прятать её за правом не от кого.
 */
export interface StoredAttachment {
  /** «video» и «file» появились 16.08.2026: до этого видео и документы не
   *  сохранялись вовсе, и присланный рум-тур нельзя было посмотреть в CRM. */
  kind: "image" | "audio" | "video" | "file";
  file?: string;
  url?: string;
  mime: string;
  /**
   * Идентификатор ЭТОГО вложения у Meta (`message_id`), когда оно ушло отдельным
   * запросом (см. messengers/propertyShowcase.ts). Несколько вложений одной реплики
   * CRM — это несколько РЕАЛЬНЫХ сообщений Meta, у каждого свой mid и своё эхо; поля
   * ChatMessage.mid/mid2 одной пары не хватает, поэтому у показов объекта mid лежит
   * при каждом вложении, а не на уровне реплики.
   */
  mid?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Internal persisted server metadata. Never forwarded to a model/widget. */
  customerPropertyAdmission?: CustomerPropertyAdmission;
  customerPropertyAdmissionDenied?: Extract<import("@royal-home/shared").CustomerPropertyAdmissionResult, { status: "denied" }>;
  customerPropertyBatch?: import("@royal-home/shared").CustomerPropertyAdmissionResult[];
  customerPropertyReference?: CustomerPropertyReference;
  customerPropertyDelivery?: CustomerPropertyDelivery;
  /** Что клиент прислал вместе с этой репликой. В модель НЕ уходит: вызовы
   *  пересобирают сообщение по полям role/content (см. client.ts), иначе
   *  Anthropic отверг бы объект с незнакомым ключом. */
  attachments?: StoredAttachment[];
  /**
   * Когда реплика была сказана (ISO). В модель полем НЕ уходит — вызовы
   * пересобирают сообщение по role/content, — но из него считаются разрывы во
   * времени, которые подмешиваются в текст (см. ai/conversationTime.ts).
   *
   * Необязательное: у реплик, записанных до 01.08.2026, его нет. Для них разрыв
   * посчитать не из чего, и они читаются как раньше.
   */
  at?: string;
  /**
   * Кто написал реплику со стороны компании — только у role="assistant".
   * В модель НЕ уходит, как at/attachments выше: вызовы пересобирают сообщение
   * по role/content. Описание смысла — в @royal-home/shared/conversationMessage.
   */
  by?:
    | { kind: "bot" }
    | { kind: "system" }
    | { kind: "agent"; agentId: string; agentName: string }
    /** Ответ руками из самого мессенджера, мимо CRM — автор неизвестен. */
    | { kind: "manual" };
  /** Идентификатор реплики у Meta и ссылка на цитируемую. В модель НЕ уходят, как и
   *  поля выше. Смысл описан в @royal-home/shared/conversationMessage. */
  mid?: string;
  mid2?: string;
  replyToMid?: string;
  /**
   * Статус доставки НАШЕЙ реплики у клиента — тот же, что в
   * @royal-home/shared/conversationMessage (24.09.2026, ночная проверка). Пишется
   * markMessageDeliveryStatus/markLastReplyUndelivered (messengers/conversation.ts);
   * `failed` значит, что клиент реплику не получил, — повтор (jobs/aiReplyRetry.ts)
   * обязан считать такой ход неотвеченным. В модель НЕ уходит, как at/mid выше.
   */
  deliveryStatus?: "sent" | "delivered" | "read" | "failed";
  /**
   * Реплика клиента записана системой ВМЕСТО хода бота — бот намеренно промолчал
   * (рубильник выключен, оператор взял диалог, исчерпан предел ИИ), а номер всё
   * равно оформили (`silent` в acceptLead). В модель не уходит, как и поля выше.
   *
   * Нужна затем, чтобы повтор «зависших» диалогов (lib/stuckConversations.ts) не
   * принял её за неотвеченное сообщение и не заговорил поверх молчания, о котором
   * решение уже принято. Авария 17.09.2026: ровно так бот рассылал «Ташаккур,
   * рақаматонро қабул кардам…» в шесть чатов каждые полчаса.
   */
  silentCapture?: boolean;
  /**
   * Карточка объекта — только у канала сайта (23.08.2026, владелец: «карточка с
   * фото и ценой, кнопка посмотреть, не выходя из чата»). У остального Meta уже
   * есть свой полноценный показ — реальные фотографии в чат + ссылка отдельным
   * сообщением (см. attachments выше и messengers/propertyShowcase.ts); карточка
   * для них была бы вторым, более бедным способом показать то же самое.
   */
  propertyCard?: PropertyCard;
  /**
   * Реплику уже записали, но виджету сайта её пока не показывать (ISO, до этого
   * момента) — владелец 23.08.2026: мгновенный ответ бота выдаёт в нём машину,
   * «пусть печатает, а ответ приходит через 5–15 секунд, каждый раз по-разному».
   * Только для канала WEBSITE: у Meta/Telegram задержку и так даёт настоящая сеть,
   * добавлять искусственную там нечего. В модель НЕ уходит, как at/mid выше.
   */
  visibleAt?: string;
  /**
   * Запасные номера, которые КЛИЕНТ назвал в этой реплике и которых не было среди
   * уже известных номеров карточки (Client.phone/whatsappPhone/extraPhones) —
   * зашифрованы (lib/phoneCrypto.ts), сам текст реплики уже замаскирован в
   * content (см. lib/clientPhoneMasking.ts, требование владельца 04.09.2026, тот
   * же приём, что у Interaction.mentionedPhonesEncrypted для звонков). В модель
   * НЕ уходит, как at/mid выше.
   */
  mentionedPhonesEncrypted?: string[];
  /**
   * Русский перевод реплики (13.09.2026) — только у role="user", когда текст
   * определился как таджикский (ai/clientLanguage.ts) и сотрудник нажал «Показать
   * перевод» в переписке (см. messengers/translateChatMessage.ts). Тот же приём,
   * что у Interaction.transcriptRu для звонков: оригинал остаётся как пришёл
   * (спорные места разбираются по тому, что клиент написал на самом деле), перевод
   * лежит рядом. Считается ПО КЛИКУ, не на каждое входящее сообщение — тем же
   * поводом, по которому переводу звонков это уже привили 19.08.2026: не тратить
   * вызов модели на переписку, которую никто не откроет. В модель НЕ уходит, как
   * at/mid выше.
   */
  translatedRu?: string;
}

/**
 * Карточка объекта для чата на сайте: фото, цена и главное — без перехода на
 * другую страницу. Кнопка «Смотреть» ведёт на полную карточку сайта, если
 * человеку нужны все фото и подробности.
 */
export interface PropertyCard {
  shortId: number;
  /** «2-комн, Сино» — заголовок, как в подборке объектов промта. */
  title: string;
  /** Уже отформатирована («1 060 000 с.») — виджету не нужно знать про валюты. */
  price: string;
  rooms?: number;
  areaSqm?: number;
  district: string;
  address?: string;
  /** null — у объекта нет фотографий; карточка всё равно полезна остальными полями.
   *  Всегда равно photoUrls[0], если фото есть — оставлено для обратной совместимости
   *  виджета, который ещё не умел листать несколько фото. */
  photoUrl: string | null;
  /** Все фотографии объекта (23.08.2026: «сделай так, чтобы можно было все смотреть
   *  в карточке») — виджет строит из них галерею, не открывая полную страницу сайта. */
  photoUrls: string[];
  siteUrl: string;
}

/** Фото клиента для vision — прикладывается к последнему user-сообщению. */
export interface ImageInput {
  mediaType: string;
  /** base64 без префикса data: */
  data: string;
}

/**
 * Достаёт JSON из ответа модели. Сначала пробуем целиком, потом — первый
 * объект или массив внутри текста: модель иногда обрамляет ответ пояснением.
 */
export function extractJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return null;
    }
  }
}

/** Счётчик израсходованных токенов по видам — по нему считаются деньги. */
export interface SpentTokens {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** Сколько из inputTokens/outputTokens — звук (живой голос, 03.10.2026): у
   *  Live API звук и текст стоят по-разному (см. ai/pricing.ts). Не задано — всё текст. */
  audioInputTokens?: number;
  audioOutputTokens?: number;
}

export function emptyUsage(): SpentTokens {
  return { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
}

/**
 * Запись обращения к ИИ в журнал. Раньше сюда попадала только сумма всех
 * токенов, поэтому перерасход был не виден: по одной цифре нельзя отличить
 * дорогой выход от дешёвого чтения кэша, а без модели — пересчитать стоимость.
 *
 * Журнал не должен ронять то, что он записывает: ошибка записи только логируется.
 */
export async function logAiCall(params: {
  endpoint: string;
  model: string;
  spent: SpentTokens;
  ms: number;
  ok: boolean;
  /**
   * Диалог мессенджера (Conversation.id) или канал живого звонка (channelId,
   * см. lib/telephony/liveVoiceBridge.ts) — если вызов сделан в его рамках.
   * null/не передан — вызов фоновый или системный (карточка объекта, ночной
   * инсайт, аудит бота...), и по нему стоимость конкретного разговора не
   * считается (13.09.2026, «стоимость разговора нигде не видна» — владелец).
   */
  conversationId?: string | null;
}): Promise<void> {
  const { endpoint, model, spent, ms, ok, conversationId } = params;
  const total =
    spent.inputTokens + spent.outputTokens + spent.cacheWriteTokens + spent.cacheReadTokens;
  try {
    await prisma.aiLog.create({
      data: {
        endpoint,
        model,
        tokens: total || undefined,
        inputTokens: spent.inputTokens || undefined,
        outputTokens: spent.outputTokens || undefined,
        cacheWriteTokens: spent.cacheWriteTokens || undefined,
        cacheReadTokens: spent.cacheReadTokens || undefined,
        costUsd: estimateCostUsd(model, spent),
        ms,
        ok,
        conversationId: conversationId || undefined,
      },
    });
  } catch (logError) {
    console.error("[ai-log]", logError instanceof Error ? logError.message : logError);
  }
}
