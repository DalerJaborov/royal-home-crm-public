/**
 * ЧАТ НА САЙТЕ — ЕЩЁ ОДИН КАНАЛ ТОГО ЖЕ БОТА (владелец 23.08.2026).
 *
 * Посетитель royalhome.tj открывает виджет в углу страницы и пишет. Отвечает не
 * отдельный «чат-бот для сайта», а РОВНО ТОТ ЖЕ бот, что ведёт WhatsApp, Instagram и
 * Telegram: та же квалификация, те же рубильники, та же защита, тот же приём заявки
 * с распределением на агента. Второй бот означал бы два характера, два набора правил
 * и два места, где чинить одну и ту же ошибку.
 *
 * ЧЕМ САЙТ ОТЛИЧАЕТСЯ ОТ МЕССЕНДЖЕРА — ровно одним: ответ никуда не отправляется.
 * У Meta и Telegram есть транспорт, куда толкнуть реплику; здесь её забирает сама
 * страница (`loadWebsiteChatMessages`, короткий опрос). Поэтому:
 *
 *  · ход диалога идёт через processMessengerTurn, как у всех каналов;
 *  · ответ агента из инбокса CRM просто ложится в переписку — deliverToConversation
 *    для этого канала пропускает шаг сетевой отправки (см. conversationDelivery.ts).
 *    Благодаря этому оператор подхватывает чат на сайте так же, как любой другой
 *    диалог: кнопкой «Ответить», и посетитель видит его сообщение в виджете.
 *
 * КТО ТАКОЙ ПОСЕТИТЕЛЬ. Телефона у него нет, аккаунта нет — есть только случайный
 * идентификатор сессии, который сайт хранит у себя в браузере. Он и служит
 * subscriberId: пара (канал, subscriberId) уникальна, как у мессенджеров, и человек,
 * вернувшийся на сайт в том же браузере, продолжает свой разговор, а не начинает
 * заново. Заявку бот оформит обычным порядком, когда получит номер.
 */

import { prisma } from "../db.js";
import { describeProperty, recordPageInterest, sharedMediaHint } from "./sharedMedia.js";
import { resolvePropertyFromPageUrl } from "../lib/resolvePropertyFromPageUrl.js";
import { noteRealInbound } from "../lib/outboundShield.js";
import { processMessengerTurn, type MessengerTurnResult } from "./conversation.js";
import { customerPropertyContextEnabled } from "../lib/customerPropertyContextFlag.js";
import { admitCustomerPropertyInput } from "../lib/customerPropertyAdmission.js";
import type { AuthenticatedCustomerInput } from "../lib/customerIngressAuthority.js";
import { customerPropertyEvidenceFromWebsite } from "../lib/customerPropertyEvidence.js";
import { customerPropertyMessageVisible } from "../lib/customerPropertyHistory.js";
import { screenIncomingText } from "../ai/inboundScreen.js";
import type { ChatMessage, PropertyCard } from "../ai/shared.js";

/** Канал в BotConversation.channel. Строка, а не enum: канал в схеме — строка,
 *  и это то самое место, где новый канал добавляется без миграции. */
import { WEBSITE_CHANNEL } from "./channels.js";
export { WEBSITE_CHANNEL };

import { WEBSITE_SESSION_RE } from "../lib/shared/websiteSession.js";
export { WEBSITE_SESSION_RE };

export interface WebsiteChatMessage {
  role: "user" | "assistant";
  content: string;
  at: string | null;
  /** Кто ответил со стороны компании: бот или живой сотрудник. Виджет показывает
   *  это подписью — человеку важно знать, что с ним говорит уже не робот. */
  author: "bot" | "human" | null;
  /** Карточка объекта (фото/цена/район), когда бот показывает объект вместо
   *  недоступных на этом канале настоящих фотографий. */
  propertyCard?: PropertyCard;
}

/** Реплики диалога для виджета: только текст и кто сказал — служебные поля
 *  переписки (mid, вложения, статусы доставки) наружу не отдаём. */
function toWebsiteMessages(raw: unknown): WebsiteChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const messages: WebsiteChatMessage[] = (raw as ChatMessage[])
    .filter(customerPropertyMessageVisible)
    .filter((m) => m && typeof m.content === "string" && m.content.trim().length > 0)
    // Реплика уже лежит в БД, но ей назначен искусственный момент появления
    // (см. visibleAt в ai/shared.ts) — до него виджет её не видит вовсе, а не
    // видит «моргнувшей и появившейся заново»: следующий опрос покажет её сам,
    // как только время придёт, тем же курсором `after` по `at`.
    .filter((m) => !m.visibleAt || Date.parse(m.visibleAt) <= Date.now())
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
      at: m.customerPropertyDelivery?.publishedAt ?? (typeof m.at === "string" ? m.at : null),
      author:
        m.role !== "assistant"
          ? null
          : // by отсутствует у реплик, записанных до появления подписи, — считаем их
            // ботом: до подхвата оператором такие диалоги вёл только он.
            !m.by || m.by.kind === "bot"
            ? "bot"
            : "human",
      ...(m.propertyCard ? { propertyCard: m.propertyCard } : {}),
    }));
  // Managed publication can occur after a later IN already occupied the array
  // tail. Its public cursor order must follow publication, not pending creation.
  return (raw as ChatMessage[]).some((message) => message?.customerPropertyDelivery?.publishedAt)
    ? messages.sort((a, b) => (a.at ? Date.parse(a.at) : 0) - (b.at ? Date.parse(b.at) : 0)) : messages;
}

/**
 * Отвечает ли бот в чате на сайте прямо сейчас: общий рубильник бота И свой
 * собственный. Отказ базы — «отвечает»: замолчавший без причины бот на витрине
 * хуже лишнего ответа, и ровно так же ведут себя остальные рубильники каналов.
 */
export async function isWebsiteChatEnabled(): Promise<boolean> {
  try {
    const s = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { botEnabled: true, botWebsiteChatEnabled: true },
    });
    if (!s) return true;
    return s.botEnabled && s.botWebsiteChatEnabled;
  } catch {
    return true;
  }
}

/**
 * Ход разговора: посетитель написал — бот ответил.
 *
 * Возвращает то же, что и любой другой канал (MessengerTurnResult): текст ответа,
 * иногда второй «пузырь», и признак shouldReply=false, когда отвечать не надо —
 * например, диалог взял на себя живой оператор. Виджет в этом случае просто ничего
 * не дорисовывает: сообщение оператора придёт следующим опросом.
 */
export async function handleWebsiteChatTurn(input: {
  sessionId: string;
  messageId?: string;
  text: string;
  name?: string;
  pageUrl?: string;
  authenticatedInput?: AuthenticatedCustomerInput;
  silent?: boolean;
}): Promise<MessengerTurnResult> {
  /**
   * НАСТОЯЩЕЕ ВХОДЯЩЕЕ ДЛЯ ЩИТА (17.09.2026, lib/outboundShield.ts).
   *
   * У виджета нет `mid` провайдера, но есть то, ради чего он и нужен: это
   * ДЕЙСТВИЕ ЖИВОГО ЧЕЛОВЕКА — запрос пришёл с его страницы, а не был дописан в
   * историю нашим же кроном. Идентификатором служит сам запрос.
   */
  await noteRealInbound({
    channel: WEBSITE_CHANNEL,
    subscriberId: input.sessionId,
    providerId: `web:${Date.now()}`,
    name: input.name ?? null,
  });

  // Shield undo may change ownershipEpoch. Mint the accepted input boundary
  // only afterwards; otherwise this same legitimate IN immediately goes stale.
  const propertyAdmission = await admitCustomerPropertyInput({ channel: "WEBSITE",
    peer: input.sessionId, eventKind: "website_message", eventId: input.messageId,
    evidence: customerPropertyContextEnabled() ? customerPropertyEvidenceFromWebsite(input) : [],
    deferFocusUntilClassification: !customerPropertyContextEnabled(), authenticatedInput: input.authenticatedInput });

  if (input.silent) return processMessengerTurn({ channel: WEBSITE_CHANNEL, subscriberId: input.sessionId,
    text: input.text, name: input.name, silent: true, messageId: input.messageId,
    customerPropertyAdmission: propertyAdmission, customerAuthenticatedInput: input.authenticatedInput });

  /**
   * ОТСЕВ ВХОДЯЩЕГО — И В ЧАТЕ САЙТА ТОЖЕ (правка 22.09.2026).
   *
   * Просьбы о материальной помощи, рассылка и разговор не по делу отсекались во
   * всех каналах, кроме этого: Meta (routes/webhooks.ts), личка и Direct
   * Messages Telegram, комментарии под публикациями — везде, а виджет сайта
   * отдавал такое сообщение прямо модели. Тот самый класс «защита подключена не
   * во всех каналах», которым этот репозиторий болеет (см. CLAUDE.md), и прямое
   * требование владельца: «везде одни и те же правила». Решение про полное
   * молчание на просьбу о деньгах было про поведение агентства, а не про один
   * транспорт (ai/moneyRequestGuard.ts).
   *
   * `silent: true` — та же дорога, что у выключенного бота ниже: сообщение
   * ложится в переписку с пометкой, диалог всплывает в инбоксе, и владелец
   * видит, что обращение было. Виджету отвечаем как обычно (`shouldReply:
   * false`) — он просто ничего не дорисовывает.
   */
  const screen = screenIncomingText(input.text, {});
  if (screen.action === "silent") {
    await processMessengerTurn({
      channel: WEBSITE_CHANNEL,
      customerPropertyAdmission: propertyAdmission,
      customerAuthenticatedInput: input.authenticatedInput,
      messageId: input.messageId,
      subscriberId: input.sessionId,
      text: `${input.text}\n${screen.mark}`.trim(),
      name: input.name,
      silent: true,
    });
    return { reply: "", ready: false, accepted: false, shouldReply: false };
  }

  const viewedPropertyId = await recordPageInterest(input.pageUrl, WEBSITE_CHANNEL, input.sessionId);
  return processMessengerTurn({
    channel: WEBSITE_CHANNEL,
    customerPropertyAdmission: propertyAdmission,
    customerAuthenticatedInput: input.authenticatedInput,
    customerPropertyEventKind: "website_message",
    messageId: input.messageId,
    subscriberId: input.sessionId,
    text: input.text,
    name: input.name,
    // След «в диалоге речь об этом объекте» («голос рынка»); на ответ не влияет.
    sharedPropertyId: viewedPropertyId,
    // Страница объекта — тот же «объект показан пальцем», что и клик по рекламе:
    // заявка уходит агенту этого объекта (решение владельца 24.09), если в
    // разговоре не назван другой. Только для страницы самого объекта.
    adPropertyId: input.pageUrl ? await pagePropertyId(input.pageUrl) : null,
    /**
     * Страница, с которой пишут, — подсказка НА ОДИН ХОД (turnHint живёт ровно ход
     * и в историю не попадает, см. MessengerTurnInput). Человек, открывший карточку
     * трёхкомнатной в Сино, обычно спрашивает именно про неё, и переспрашивать
     * «какой район вас интересует» в этот момент — худшее, что можно сделать.
     */
    turnHint: [
      input.pageUrl ? await pageHint(input.pageUrl) : "",
      /**
       * ПРИСЛАННАЯ ССЫЛКА ЧИТАЕТСЯ И В ЧАТЕ САЙТА (21.09.2026). Обогащение ссылок
       * жило только в канале Meta, и посетитель, приславший в виджет ссылку на наш
       * же объект, получал ответ, будто ничего не присылал.
       */
      await sharedMediaHint({ text: input.text, channel: WEBSITE_CHANNEL, recipientId: input.sessionId, accountId: null }),
    ]
      .filter(Boolean)
      .join(" ") || undefined,
  });
}

/**
 * Бот в чате выключен — сообщение всё равно НЕ теряется.
 *
 * Ровно то же поведение, что у выключенного канала Meta (см. botChannels.ts):
 * «бот молчит» никогда не значит «сообщение выброшено». Реплика ложится в
 * переписку, диалог всплывает в инбоксе непрочитанным, и агент отвечает руками —
 * его ответ дойдёт до виджета обычным опросом.
 *
 * Тем же путём, что и у мессенджеров: `silent` в processMessengerTurn означает
 * «записать, но не отвечать», — второй способ записи сообщения разошёлся бы с
 * первым молча (а вместе с ним разошлись бы и дебаунс, и подсчёт непрочитанных).
 */
export async function recordWebsiteChatMessageOnly(input: {
  sessionId: string;
  text: string;
  name?: string;
  messageId?: string;
  authenticatedInput?: AuthenticatedCustomerInput;
}): Promise<void> {
  await handleWebsiteChatTurn({ ...input, silent: true });
}

/**
 * Что нового в диалоге после отметки `after`.
 *
 * Этим виджет забирает и ответы бота, и — главное — реплики живого агента из инбокса
 * CRM. Отметка передаётся временем последней показанной реплики: у сообщений
 * переписки есть поле `at`, и сравнение по нему честнее счётчика, который разъехался
 * бы при любой правке истории.
 */
export async function loadWebsiteChatMessages(
  sessionId: string,
  after?: string
): Promise<{ messages: WebsiteChatMessage[]; paused: boolean }> {
  const conversation = await prisma.botConversation.findFirst({
    where: { channel: WEBSITE_CHANNEL, subscriberId: sessionId },
    select: { messages: true, pausedUntil: true },
  });
  if (!conversation) return { messages: [], paused: false };

  const all = toWebsiteMessages(conversation.messages);
  const afterMs = after ? Date.parse(after) : NaN;
  const messages = Number.isFinite(afterMs)
    ? all.filter((m) => m.at && Date.parse(m.at) > afterMs)
    : all;

  return {
    messages,
    // Бот на паузе — значит диалог ведёт живой сотрудник. Виджет показывает это
    // честной подписью вместо «печатает…» от имени бота, которого там уже нет.
    paused: !!conversation.pausedUntil && conversation.pausedUntil > new Date(),
  };
}

/** Объект, на странице которого сидит посетитель; сбой базы — просто «не знаем». */
async function pagePropertyId(pageUrl: string): Promise<string | null> {
  return resolvePropertyFromPageUrl(pageUrl).catch(() => null);
}

/**
 * ПОДСКАЗКА О СТРАНИЦЕ — С ДАННЫМИ ОБЪЕКТА (ревизия бота 02.10.2026). Раньше модель
 * получала голый адрес страницы, а открыть его не может: на «сколько стоит?» со
 * страницы объекта она переспрашивала «какую квартиру вы смотрите?». Теперь
 * адрес переводится в объект, и цена с районом лежат прямо в подсказке.
 */
async function pageHint(pageUrl: string): Promise<string> {
  const id = await pagePropertyId(pageUrl);
  const property = id
    ? await prisma.property.findFirst({ where: { id, deletedAt: null }, include: { district: true } }).catch(() => null)
    : null;
  if (!property) return `Посетитель пишет со страницы сайта: ${pageUrl}`;
  return (
    `[посетитель пишет со страницы объекта на нашем сайте — ${describeProperty(property)}. Если он спрашивает ` +
    "про квартиру («сколько стоит?», «ещё продаётся?»), речь об ЭТОМ объекте: цену и детали бери отсюда, не " +
    "выдумывай и не спрашивай, какую квартиру он смотрит. Если объект уже не в продаже, честно скажи и предложи похожее]"
  );
}
