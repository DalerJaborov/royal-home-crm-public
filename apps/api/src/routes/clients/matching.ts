/**
 * Подбор объектов клиенту: POST /:id/send-properties, GET /:id/match (Г2, §1.2).
 * Перенос verbatim. formatPriceForClient переехал в lib/propertyOfferText.ts
 * (24.09.2026): им же пользуется ссылка на объект после первого сообщения в
 * WhatsApp (lib/whatsappFirstContact.ts), а цена в двух местах не должна разойтись.
 */
import { Router, type Request, type Response } from "express";
import { sendPropertiesSchema, type SendPropertiesFallback, type SendTargetInfo } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { stripEmbedding, stripOwnerContact } from "../../lib/ownerContact.js";
import { foreignWriteDenied } from "./shared.js";
import { can, canAccessAssignedAgent, requireAuth, scopeToOwnAgent } from "../../auth/middleware.js";
import { callAiText } from "../../ai/client.js";
import { loadMoneyContext } from "../../lib/money.js";
import {
  agentSender,
  deliverToConversation,
  lastClientMessage,
  lastClientMessageAt,
  resolveSendTarget,
  type DeliveryTarget,
} from "../../lib/conversationDelivery.js";
import { isMessagingWindowOpen } from "../../lib/messagingWindow.js";
import { asMetaChannel, isMetaChannelEnabled } from "../../messengers/meta.js";
import { isTelegramEnabled } from "../../telegram/api.js";
import { smsConfigured, toSmsPhone } from "../../lib/sms/index.js";
import { siteListingUrl } from "../../lib/siteListingUrl.js";
import { getOrCreatePropertyShareLinks } from "../../lib/propertyShareLink.js";
import { buildPropertyOfferText, formatPriceForClient } from "../../lib/propertyOfferText.js";
import { detectClientLanguage } from "../../ai/clientLanguage.js";
import { buildPropertyMatchWhere, nearestClientPlace } from "../../lib/propertyMatchFilter.js";
import { recordExposures } from "../../messengers/propertyShowcase.js";
import { loadMatchPolicy } from "../../lib/matchPolicy.js";
import { propertyOwnerAgentId } from "../../lib/propertyOwner.js";
import { sendPushToAgent } from "../../push.js";
import { loadMatchWeights, scoreClientProperty } from "../matching.js";

export const matchingRouter = Router();

/** channel+recipientId для PropertyExposure из адресата доставки — тот же мост
 *  (канал, собеседник), что использует бот в messengers/propertyShowcase.ts.
 *  Telegram — отдельная ветка DeliveryTarget без поля channel (это не meta-канал,
 *  как INSTAGRAM/FACEBOOK/WHATSAPP), поэтому канал здесь фиксирован строкой. */
function exposureChannel(target: DeliveryTarget): { channel: string; recipientId: string } {
  return target.kind === "telegram"
    ? { channel: "TELEGRAM", recipientId: target.subscriberId }
    : { channel: target.channel, recipientId: target.subscriberId };
}

type SendableClient = NonNullable<Awaited<ReturnType<typeof prisma.client.findUnique>>>;

/**
 * Лестница отказов «можно ли писать этому клиенту» — одна на отправку и на
 * вопрос «куда уйдёт» (GET /:id/send-target): иначе окно показывало бы
 * «уйдёт в WhatsApp» клиенту, отправка которому запрещена.
 */
async function loadSendableClient(req: Request, res: Response): Promise<SendableClient | null> {
  const ownAgentId = scopeToOwnAgent(req);
  const client = await prisma.client.findUnique({ where: { id: String(req.params.id) } });
  if (!client) {
    res.status(404).json({ error: "Клиент не найден" });
    return null;
  }
  if (!canAccessAssignedAgent(req, client.assignedAgentId)) {
    res.status(403).json({ error: "Недостаточно прав" });
    return null;
  }
  // Писать клиенту от имени агентства — это правка чужой карточки: сообщение
  // глушит бота. «Видеть все» (служба безопасности) права писать не даёт; в
  // Корзине переписки нет (аудит 23.09.2026, №40).
  const denied = foreignWriteDenied(req, client, ownAgentId);
  if (denied) {
    res.status(403).json({ error: denied });
    return null;
  }
  if (client.deletedAt) {
    res.status(409).json({ error: "Карточка в Корзине — сначала восстановите её" });
    return null;
  }
  // До принятия лида карточка для агента закрыта (см. POST /:id/interactions) —
  // писать клиенту в мессенджер в обход этой блокировки тоже нельзя.
  if (ownAgentId && !client.acceptedAt) {
    res.status(403).json({ error: "Сначала примите лид — до принятия карточка закрыта" });
    return null;
  }
  return client;
}

const CHANNEL_WORD: Record<string, string> = {
  WHATSAPP: "WhatsApp",
  INSTAGRAM: "Instagram",
  FACEBOOK: "Messenger",
  TELEGRAM: "Telegram",
  WEBSITE: "чат на сайте",
};

function targetChannel(target: DeliveryTarget): string {
  return target.kind === "telegram" ? "TELEGRAM" : target.channel;
}

/** Каналы, в которые CRM умеет писать; прочее (старые платформы) — «не поддерживается». */
const SENDABLE_CHANNELS = new Set(["WHATSAPP", "INSTAGRAM", "FACEBOOK", "TELEGRAM", "WEBSITE"]);

async function channelEnabled(target: DeliveryTarget): Promise<boolean> {
  if (target.kind === "telegram") return isTelegramEnabled();
  if (target.channel === "WEBSITE") return true;
  const meta = asMetaChannel(target.channel);
  return meta !== null && (await isMetaChannelEnabled(meta));
}

/** Можно ли уйти по СМС: подключены и номер клиента годится для таджикского шлюза. */
async function smsAvailableFor(phone: string): Promise<boolean> {
  if (!toSmsPhone(phone)) return false;
  return smsConfigured().catch(() => false);
}

/**
 * «Куда уйдёт объект» — ДО нажатия (28.09.2026). Раньше агент узнавал о закрытом
 * окне Meta, выключенном канале или пустом WhatsApp только из красной строки
 * ПОСЛЕ отправки, и выглядело это как «кнопка не работает».
 */
matchingRouter.get("/:id/send-target", requireAuth, async (req, res) => {
  const client = await loadSendableClient(req, res);
  if (!client) return;
  const inboxId = typeof req.query.conversationId === "string" && req.query.conversationId ? req.query.conversationId : undefined;
  const [target, smsAvailable] = await Promise.all([resolveSendTarget(client.id, inboxId), smsAvailableFor(client.phone)]);
  if (target === undefined) return res.status(404).json({ error: "Этот диалог не относится к карточке клиента" });

  const smsTail = smsAvailable ? " Отправьте по СМС или скопируйте ссылку." : " Скопируйте ссылку и отправьте её сами.";
  if (!target) {
    const info: SendTargetInfo = {
      channel: null,
      channelEnabled: false,
      windowOpen: false,
      lastClientMessageAt: null,
      smsAvailable,
      hint: `Клиент не писал в мессенджеры — в переписку отправить некуда.${smsTail}`,
    };
    return res.json(info);
  }
  const channel = targetChannel(target);
  const word = CHANNEL_WORD[channel] ?? channel;
  const [enabled, lastAt] = await Promise.all([channelEnabled(target), lastClientMessageAt(target)]);
  const windowOpen = isMessagingWindowOpen(channel, lastAt);
  const hint = !SENDABLE_CHANNELS.has(channel)
    ? `Канал ${word} больше не поддерживается.${smsTail}`
    : !enabled
      ? `${word} выключен в Настройках — сообщение не уйдёт.${smsTail}`
      : !windowOpen
        ? `Клиент не писал в ${word} больше суток — Meta не пропустит сообщение.${smsTail}`
        : `Уйдёт в ${word}, в переписку клиента. Бот в этом диалоге замолчит.`;
  const info: SendTargetInfo = {
    channel: SENDABLE_CHANNELS.has(channel) ? (channel as SendTargetInfo["channel"]) : null,
    channelEnabled: enabled && SENDABLE_CHANNELS.has(channel),
    windowOpen,
    lastClientMessageAt: lastAt?.toISOString() ?? null,
    smsAvailable,
    hint,
  };
  res.json(info);
});

/** Проданный или снятый с продажи объект клиенту не шлём: ссылка обещала бы то, чего нет. */
const NOT_OFFERABLE_STATUSES = new Set(["SOLD", "WITHDRAWN"]);

/**
 * Отправка подобранных объектов клиенту в тот канал, откуда он писал.
 *
 * Живёт в маршрутах клиента, а не в инбоксе: инбокс закрыт правом messages.view
 * (рядовой агент переписку бота не видит вовсе), а отправлять объекты СВОЕМУ клиенту
 * агент обязан уметь. Доступ поэтому проверяется как везде в карточке — по назначенному
 * агенту.
 *
 * Бот замолкает сам: это делает общая доставка (lib/conversationDelivery.ts) — агент
 * вступает в переписку самим фактом сообщения, и отвечать поверх него ИИ не должен.
 *
 * ПЕРЕДЕЛАНО 28.09.2026 (владелец: «агенты не могут отправлять объекты, такая
 * проблема была и не решена»). Три причины, по которым кнопка «не работала»:
 *  1. объект, ещё не выложенный на сайт (а это все свежие — они днями ждут фото
 *     и ролик), отказывал «Не опубликованы на сайте». Теперь уходит личной
 *     ссылкой /l/<токен> — той же, что у несайтовых объектов с 19.08.2026;
 *  2. сообщение уходило не в открытый чат, а в «последний» диалог клиента —
 *     часто в пустой WhatsApp. Теперь из чата — в открытый (`conversationId`);
 *  3. отказ мессенджера был тупиком. Теперь в ответе `fallback` — готовый текст
 *     и ссылки: агент копирует их или шлёт по СМС, не начиная заново.
 */
matchingRouter.post("/:id/send-properties", requireAuth, async (req, res) => {
  const parsed = sendPropertiesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const client = await loadSendableClient(req, res);
  if (!client) return;

  const properties = await prisma.property.findMany({
    where: { id: { in: parsed.data.propertyIds }, deletedAt: null },
  });
  if (properties.length === 0) return res.status(404).json({ error: "Объекты не найдены" });
  const notOfferable = properties.filter((p) => NOT_OFFERABLE_STATUSES.has(p.status));
  if (notOfferable.length > 0) {
    return res.status(409).json({
      error: `Продан или снят с продажи: ${notOfferable.map((p) => `№${p.shortId}`).join(", ")}. Уберите из выбора и повторите.`,
    });
  }

  // Ссылка: страница на сайте, если объект там есть; иначе — личная ссылка
  // клиента /l/<токен> (несайтовый объект или ещё не выложенный). Одна пачка
  // одним запросом (22.09.2026, сведение N+1).
  const linkIds = properties.filter((p) => p.offSite || siteListingUrl(p) === null).map((p) => p.id);
  const shareLinks = await getOrCreatePropertyShareLinks(prisma, {
    propertyIds: linkIds,
    clientId: client.id,
    createdByAgentId: req.agent!.id,
  });
  const propertyLinks = new Map<string, string>(
    properties.map((p): [string, string] => [p.id, shareLinks.get(p.id)?.url ?? siteListingUrl(p)!])
  );

  const target = await resolveSendTarget(client.id, parsed.data.conversationId);
  if (target === undefined) return res.status(404).json({ error: "Этот диалог не относится к карточке клиента" });

  // Язык — по последней реплике клиента, как у бота. Не дозвались до истории
  // (пустой диалог, отказ базы) — остаётся русский: он понятен всем.
  const lastIncoming = target ? await lastClientMessage(target) : null;
  const language = lastIncoming ? detectClientLanguage(lastIncoming) : "unknown";
  const text = buildPropertyOfferText(
    properties.map((p) => ({
      shortId: p.shortId,
      title: p.title,
      price: formatPriceForClient(p.price, p.currency),
      url: propertyLinks.get(p.id)!,
    })),
    language
  );
  const fallback: SendPropertiesFallback = {
    text,
    links: properties.map((p) => ({ propertyId: p.id, shortId: p.shortId, url: propertyLinks.get(p.id)! })),
  };

  // Подготовка без отправки: текст и ссылки (личные ссылки уже заведены выше —
  // по ним СМС и «открыл/не открыл»), бот не трогается, в хронологию не пишем.
  if (parsed.data.prepareOnly) {
    return res.json({ ok: true, prepared: true, sent: 0, fallback });
  }

  if (!target) {
    return res.status(409).json({
      error: "Клиент не писал в мессенджер — отправить в переписку некуда. Скопируйте ссылку или отправьте по СМС.",
      fallback,
    });
  }

  // Агент сам выбрал объекты и нажал «Отправить» — это его действие, не автоответ:
  // бот здесь не ошибался (learnFromOverride не ставится), но подпись в переписке
  // всё равно должна называть человека, а не молчаливое «система».
  const sender = await agentSender(req.agent!.id);
  const delivery = await deliverToConversation(target, text, undefined, { sender });
  if (!delivery.ok) {
    return res.status(delivery.status).json({ error: delivery.error, code: delivery.code, fallback });
  }

  /**
   * PropertyExposure — тем же путём, что и у бота (messengers/propertyShowcase.ts::
   * recordExposure), а не только запись в обычную хронологию ниже. Без этого агент,
   * вручную отправивший клиенту СВОЙ объект, не был защищён правилом
   * «own_property_shown» (services/leads/assignment.ts) так же, как бот-путь —
   * лид от этого клиента мог уйти в общую очередь мимо хозяина объекта, хотя клиент
   * уже держит в руках ссылку именно на его квартиру. kind="LINK": ручная отправка
   * всегда шлёт ссылку (buildPropertyOfferText), фотографий здесь не бывает.
   * Отказ записи не должен ронять уже успешную отправку клиенту — как и у бота,
   * каждая запись обёрнута в try/catch внутри recordExposure.
   */
  const { channel: exposureChannelName, recipientId: exposureRecipientId } = exposureChannel(target);
  // Один запрос на всю пачку разом (22.09.2026, сведение N+1) — было по
  // одному recordExposure на объект (пусть и через Promise.all).
  await recordExposures(
    exposureChannelName,
    exposureRecipientId,
    properties.map((p) => ({ propertyId: p.id, shortId: p.shortId, kind: "LINK" as const })),
    client.id,
    target.kind === "bot" ? target.transport : undefined
  );

  // Запись в хронологию — та же, что у кнопки «Предложить» в окне подбора: агент видит,
  // что объект уже уходил клиенту, и не отправляет его повторно.
  if (client.assignedAgentId) {
    await prisma.interaction
      .createMany({
        data: properties.map((p) => ({
          clientId: client.id,
          agentId: client.assignedAgentId!,
          type: "SYSTEM" as const,
          propertyId: p.id,
          notes: `Ссылка на объект №${p.shortId} — ${p.title} — отправлена клиенту`,
        })),
      })
      .catch((err) => console.error("[clients] запись отправки объектов:", err instanceof Error ? err.message : err));
  }

  /**
   * ПУШ ХОЗЯИНУ ОБЪЕКТА (17.09.2026, открытый вопрос №8 плана) — «агент Б не узнаёт,
   * что его объект предложили клиенту агента А»: журнал показов писался (recordExposure
   * выше), а пуш не уходил вовсе. Тот же канал доставки, что у автоподбора
   * (lib/propertyMatchFilter.ts::sendPushToAgent) — не вторая реализация. Отключаемо
   * через Настройки (matchNotifyPropertyOwner); ошибка пуша не валит уже успешную
   * отправку клиенту.
   */
  const policy = await loadMatchPolicy();
  if (policy.notifyPropertyOwner) {
    for (const p of properties) {
      const ownerId = propertyOwnerAgentId(p);
      if (!ownerId || ownerId === req.agent!.id) continue;
      void sendPushToAgent(ownerId, {
        title: "🏠 Ваш объект предложен клиенту",
        body: `Объект №${p.shortId} — ${p.title}: агент ${sender.kind === "agent" ? sender.agentName : "Сотрудник"} предложил его своему клиенту №${client.shortId}`,
        url: `/properties/${p.shortId}`,
        kind: "look",
      }).catch((err) => console.error("[push] объект предложен чужим агентом:", err));
    }
  }

  res.json({
    ok: true,
    sent: properties.length,
    masked: delivery.masked,
    pausedUntil: delivery.pausedUntil,
    channel: targetChannel(target),
  });
});

/** 7.4 Шаг 1: SQL-фильтр без AI. Ранжирование с AI-причинами — см. /ai/match в фазе AI. */
matchingRouter.get("/:id/match", requireAuth, async (req, res) => {
  const client = await prisma.client.findUnique({
    where: { id: req.params.id },
    // Желаемые места (12.09.2026, блок D) — нужны и для where (радиус), и для
    // сортировки/адаптивного расширения ниже.
    include: { desiredPlaces: true },
  });
  // Корзина — как у самой карточки (глубокая проверка 02.10.2026, П8).
  if (!client || client.deletedAt) return res.status(404).json({ error: "Клиент не найден" });
  if (!canAccessAssignedAgent(req, client.assignedAgentId)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  // До принятия лида — пустой подбор (П8): он строится по бюджету, району и
  // комнатам клиента и косвенно раскрывает требования, которые карточка до
  // принятия скрывает (gateUntilAccepted в clients/card.ts). Не 403: карточка
  // запрашивает подбор сразу при открытии, отказ выглядел бы поломкой.
  const ownAgentId = scopeToOwnAgent(req);
  if (ownAgentId && ownAgentId === client.assignedAgentId && !client.acceptedAt) {
    return res.json({ unfiltered: false, total: 0, properties: [] });
  }

  // deletedAt — объект из Корзины не должен предлагаться клиенту. offSite — объект
  // «только в CRM» (было исключение до 09.09.2026, docs/plan-18-08-private-listings-
  // and-video.md §1) СНОВА участвует в окне подбора (решение владельца 09.09/17.09.2026,
  // docs/match-policy-plan-17-09.md) — раньше он уже был виден всем агентам в разделе
  // «Объекты» и уходил клиенту персональной ссылкой, но подбор его не предлагал вовсе,
  // и агент должен был вспоминать про него сам. buildPropertyMatchWhere больше не
  // отсекает offSite (см. её докстрока); кнопка «Отправить»/«Предложить» уже умеет
  // отправлять такому объекту личную ссылку вместо адреса на сайте (POST
  // /:id/send-properties выше) — интерфейс отмечает его чипом «личная ссылка»
  // (offSite: true в каждом объекте ответа, поле уже есть в модели).
  // Общий фильтр (бюджет/район/тип/комнаты) — lib/propertyMatchFilter.ts. Вынесен оттуда,
  // чтобы его же переиспользовал реверс-подбор «новый объект → кому из ждущих он подходит»
  // (docs/auto-match-alert-plan-31-08-2026.md), без риска, что два места разъедутся в цифрах.
  // weights — те же, что «Кому подойдёт» на карточке объекта (routes/matching.ts):
  // единая шкала совпадения, а не вторая реализация с зашитыми числами (17.09.2026,
  // план раздел 6).
  const [money, policy, weights] = await Promise.all([loadMoneyContext(), loadMatchPolicy(), loadMatchWeights()]);

  /**
   * АДАПТИВНЫЙ РАДИУС (план, раздел 1 п.5 и блок D): при горстке объектов в базе
   * фиксированный километр не найдёт ничего никогда, и функция будет молчать.
   * Расширяем 1 → policy.radiusMaxMultiplier от радиуса КАЖДОГО места клиента, пока
   * после ПОЛНОЙ фильтрации (не только SQL-предфильтра) не наберём хотя бы
   * policy.minCandidates объектов или не кончатся шаги — только когда у клиента
   * вообще есть желаемые места; иначе один обычный запрос, как раньше. Шаги и
   * порог настраиваются в Настройках (17.09.2026) — было зашито ADAPTIVE_RADIUS_STEPS
   * [1,2,3]/MIN_ADAPTIVE_CANDIDATES=3 в lib/geoDistance.ts.
   *
   * НАМЕРЕННО НЕ здесь: findMatchingPropertiesForClient (routes/matching.ts) —
   * тот фиксированный радиус кормит порог «свой объект» (ownPropertyMatchThreshold)
   * и передачу клиента, и адаптивное расширение там подвинуло бы решения,
   * которые должны остаться детерминированными (см. блок D3 плана).
   */
  const radiusSteps = Array.from({ length: policy.radiusMaxMultiplier }, (_, i) => i + 1);
  const fetchProperties = (multiplier: number) => {
    const scaledClient =
      client.desiredPlaces.length > 0
        ? { ...client, desiredPlaces: client.desiredPlaces.map((p) => ({ ...p, radiusM: p.radiusM * multiplier })) }
        : client;
    return prisma.property.findMany({
      where: buildPropertyMatchWhere(scaledClient, money, policy),
      include: {
        district: true,
        photos: { take: 1, orderBy: { order: "asc" } },
        // Кто отвечает за объект — нужен и в подборе клиенту (владелец 21.08.2026:
        // «к нему прикрепилось и везде видно»), не только в разделе «Объекты»:
        // окно подбора (MatchPropertiesModal) показывает эти же карточки.
        assignedAgent: { select: { id: true, fullName: true, avatarUrl: true } },
        intakeAgent: { select: { id: true, fullName: true, avatarUrl: true } },
      },
      // Выше базового отображаемого предела (D2): срез до финального размера
      // происходит НИЖЕ, ПОСЛЕ сортировки по близости — иначе широкий OR по
      // радиусу мог бы вытеснить точные попадания в произвольном порядке Postgres.
      orderBy: { createdAt: "desc" },
      take: 60,
    });
  };

  // total (17.09.2026, контракт для веба) — размер ВСЕГО множества БЕЗ среза
  // take:15/60: агент должен видеть «сколько вообще подходит», а не «сколько
  // показано после урезания страницы». Считается на ТОМ ЖЕ множителе радиуса, на
  // котором остановилось адаптивное расширение — иначе «Подходит 1 объект» стояло
  // бы рядом со списком из трёх (расширенный радиус нашёл больше, чем базовый).
  const scaledWhere = (multiplier: number) =>
    buildPropertyMatchWhere(
      client.desiredPlaces.length > 0
        ? { ...client, desiredPlaces: client.desiredPlaces.map((p) => ({ ...p, radiusM: p.radiusM * multiplier })) }
        : client,
      money,
      policy
    );
  let rawProperties = await fetchProperties(1);
  let usedMultiplier = 1;
  if (client.desiredPlaces.length > 0) {
    for (const multiplier of radiusSteps.slice(1)) {
      if (rawProperties.length >= policy.minCandidates) break;
      rawProperties = await fetchProperties(multiplier);
      usedMultiplier = multiplier;
    }
  }
  const total = await prisma.property.count({ where: scaledWhere(usedMultiplier) });

  // distanceM — считаем ОДИН РАЗ на объект (17.09.2026, план раздел 6): раньше
  // nearestClientPlace вызывался заново на каждое сравнение компаратора (несколько
  // раз на объект при сортировке) и результат тут же выбрасывался. Теперь то же
  // значение идёт и в сортировку, и в ответ (withMatchMeta ниже) без второго счёта.
  const distanceById = new Map(rawProperties.map((p) => [p.id, nearestClientPlace(p, client)?.distanceM ?? null]));

  // Сортировка ПЕРЕД срезом (D2): точное совпадение района — вперёд, дальше по
  // расстоянию до ближайшего желаемого места (объекты без точки/без желаемых
  // мест — в конец этой группы, но не выбрасываются). Раньше `take: 15` сам был
  // финальным срезом без единой сортировки — теперь это только верхняя граница
  // выборки, а видимый размер режется здесь.
  const geoSorted = [...rawProperties].sort((a, b) => {
    // Только названный район (О11, 02.10.2026): null === null — не совпадение.
    const named = client.desiredDistrictId != null;
    const aDistrict = named && client.desiredDistrictId === a.districtId ? 0 : 1;
    const bDistrict = named && client.desiredDistrictId === b.districtId ? 0 : 1;
    if (aDistrict !== bDistrict) return aDistrict - bDistrict;
    const aDist = distanceById.get(a.id) ?? Infinity;
    const bDist = distanceById.get(b.id) ?? Infinity;
    return aDist - bDist;
  });
  const limited = geoSorted.slice(0, 15);

  /**
   * Контакт собственника режется ТЕМ ЖЕ правилом, что в разделе объектов.
   *
   * Здесь его не было вовсе: `include` без `select` тянет все поля карточки, включая
   * ownerContact, и ответ уходил рядовому агенту как есть. Хватало собственного
   * клиента с широким бюджетом, чтобы пачками вытаскивать телефоны владельцев чужих
   * объектов — самая ценная часть базы утекала мимо права properties.viewAll.
   */
  const isSupervisor = can(req, "properties.viewOwners");
  // stripEmbedding — тем же правилом «общий модуль»: 768 float на каждый объект
  // подбора браузеру не нужны (см. lib/ownerContact.ts).
  const properties = limited.map((p) => stripEmbedding(stripOwnerContact(p, req.agent!.id, isSupervisor)));

  /**
   * score/distanceM в ответе (17.09.2026, план раздел 6, «Одна функция «Подбор»»):
   * та же шкала совпадения, что на карточке объекта (routes/matching.ts::
   * scoreClientProperty) — не вторая реализация. includeHotBonus: false — здесь
   * подбирают ОБЪЕКТЫ под одного клиента, бонус «горячий» одинаково прибавился
   * бы всем кандидатам и не изменил бы порядок, только исказил абсолютный балл
   * (см. докстрока scoreClientProperty). distanceM — из distanceById, посчитан
   * один раз выше вместе с сортировкой.
   *
   * Применяется ОДИН РАЗ до ветвления на три res.json ниже (unfiltered / без ИИ /
   * с ИИ) — иначе три копии одного и того же вызова.
   */
  const withMatchMeta = <T extends (typeof properties)[number]>(p: T) => ({
    ...p,
    score: scoreClientProperty(client, p, money, { weights, includeHotBonus: false }).score,
    distanceM: distanceById.get(p.id) ?? null,
  });
  const propertiesWithMeta = properties.map(withMatchMeta);

  /**
   * ПОДБОР БЕЗ ПАРАМЕТРОВ (пачка 10, 11.09.2026, п.5 — flow-audit-lead-to-showing-
   * 11-09.md, ТОП-10 п.8). Ни одного требования не заполнено — значит buildPropertyMatchWhere
   * выше не отсеял вообще ничего, и «подбор» — это топ-15 любых AVAILABLE объектов,
   * не подбор под клиента. Агент должен это видеть, а не принимать случайную
   * выдачу за осмысленный результат (тот же признак «хоть что-то заполнено», что
   * и в lib/propertyMatchFilter.ts::notifyWaitingBuyersOfNewProperty).
   */
  const unfiltered =
    !client.budgetMin &&
    !client.budgetMax &&
    !client.desiredDistrictId &&
    !client.desiredType &&
    !client.desiredRooms &&
    // Желаемое место (12.09.2026, блок D) — тоже осмысленный фильтр: клиент,
    // назвавший только ориентир («у ЦУМа»), уже сузил buildPropertyMatchWhere
    // радиусом, и «подбор» для него — не топ-15 чего попало.
    client.desiredPlaces.length === 0;

  if (!client.requirementsNotes || properties.length === 0) {
    return res.json({ unfiltered, total, properties: propertiesWithMeta.map((p) => ({ ...p, aiReason: null })) });
  }

  const ranked = await callAiText<{ ranking: { propertyId: string; reason: string }[] }>({
    endpoint: "match-rank",
    system:
      "Ты подбираешь объекты недвижимости под требования клиента. Проанализируй заметки клиента и список объектов, " +
      "верни ранжированный список с короткой причиной (до 60 знаков) для каждого подходящего объекта. " +
      'Ответь СТРОГО JSON: {"ranking":[{"propertyId":"...","reason":"..."}]} — от самого подходящего к менее подходящему.',
    user: `Требования клиента: ${client.requirementsNotes}\n\nОбъекты:\n${properties
      .map((p) => `id=${p.id}: ${p.title}, ${p.district?.name ?? "Без района"}, ${p.areaSqm} м², ${p.rooms ?? "?"} комн., ${p.price} ${p.currency}`)
      .join("\n")}`,
    // Выборка выше жёстко ограничена take: 15, а на объект приходится id плюс
    // причина до 60 знаков — весь ответ укладывается в ~500 токенов. 800 — потолок
    // с запасом. Без явного числа ушёл бы дефолт 4096 (geminiClient.ts), а подбор
    // агент запускает по многу раз за день, перебирая карточки клиентов.
    maxTokens: 800,
  });

  // Проверяем не только сам ответ, но и форму: модель могла вернуть валидный JSON
  // без поля ranking (или с null вместо массива) — тогда .map по undefined ронял
  // весь маршрут в 500, хотя объекты уже собраны и их можно честно отдать без
  // ИИ-подсказок. Отказ модели здесь не повод терять подбор.
  const ranking = Array.isArray(ranked?.ranking) ? ranked.ranking : null;
  if (!ranking) {
    return res.json({ unfiltered, total, properties: propertiesWithMeta.map((p) => ({ ...p, aiReason: null })) });
  }

  const reasonById = new Map(ranking.map((r) => [r.propertyId, r.reason]));
  const sorted = [...propertiesWithMeta].sort((a, b) => {
    const ai = ranking.findIndex((r) => r.propertyId === a.id);
    const bi = ranking.findIndex((r) => r.propertyId === b.id);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  res.json({ unfiltered, total, properties: sorted.map((p) => ({ ...p, aiReason: reasonById.get(p.id) ?? null })) });
});
