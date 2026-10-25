/**
 * Подбор объектов клиенту: POST /:id/send-properties, GET /:id/match (Г2, §1.2).
 * Перенос verbatim. formatPriceForClient переехал в lib/propertyOfferText.ts
 * (24.09.2026): им же пользуется ссылка на объект после первого сообщения в
 * WhatsApp (lib/whatsappFirstContact.ts), а цена в двух местах не должна разойтись.
 */
import { Router, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { confirmedClientIntents, clientPropertyMatchQuerySchema, maskPhones, sendPropertiesSchema, type SendPropertiesFallback, type SendTargetInfo } from "@royal-home/shared";
import { z } from "zod";
import { prisma } from "../../db.js";
import { foreignWriteDenied } from "./shared.js";
import { can, canAccessAssignedAgent, requireAuth, scopeToOwnAgent } from "../../auth/middleware.js";
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
import { recordExposures } from "../../messengers/propertyShowcase.js";
import { loadMatchPolicy } from "../../lib/matchPolicy.js";
import { propertyOwnerAgentId } from "../../lib/propertyOwner.js";
import { sendPushToAgent } from "../../push.js";
import { clientPropertyMatchingCatalog } from "../../lib/clientPropertyMatchingCatalog.js";
import { currentBuyerMatchingCriteria } from "../../lib/clientPropertyMatching.js";
import { phoneSafeText } from "../../lib/clientPhone.js";

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
  if (!z.guid().safeParse(req.params.id).success) { res.status(400).json({ error: "Неверный идентификатор клиента" }); return null; }
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
  const query = z.object({ conversationId: z.string().min(1).max(80).optional() }).safeParse(req.query);
  if (!query.success) return res.status(400).json({ error: "Неверные параметры диалога" });
  const client = await loadSendableClient(req, res);
  if (!client) return;
  const inboxId = query.data.conversationId;
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
    conversationId: target.kind === "telegram" ? `tg_${target.id}` : target.id,
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

  const propertyIds = [...new Set(parsed.data.propertyIds)];
  const found = await prisma.property.findMany({
    where: { id: { in: propertyIds }, deletedAt: null,
      ...(!can(req, "properties.delete") ? { deleteRequests: { none: { requestedById: req.agent!.id, status: "PENDING" } } } : {}),
    },
  });
  if (found.length === 0) return res.status(404).json({ error: "Объекты не найдены" });
  if (found.length !== propertyIds.length) return res.status(409).json({ error: "Часть выбранных объектов недоступна. Обновите подборку и повторите — ничего не отправлено" });
  const byId = new Map(found.map(property => [property.id, property]));
  const properties = propertyIds.map(id => byId.get(id)!);
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
  const safeTitles = new Map(properties.map(property => [property.id, phoneSafeText(property.title, false)]));
  const titleMasked = properties.some(property => safeTitles.get(property.id) !== property.title);
  const { text, masked: messageMasked } = maskPhones(buildPropertyOfferText(
    properties.map((p) => ({
      shortId: p.shortId,
      title: safeTitles.get(p.id)!,
      price: formatPriceForClient(p.price, p.currency),
      url: propertyLinks.get(p.id)!,
    })),
    language
  ));
  const fallback: SendPropertiesFallback = {
    text,
    links: properties.map((p) => ({ propertyId: p.id, shortId: p.shortId, url: propertyLinks.get(p.id)! })),
  };
  // Integrity token, not authorization: all ordinary ownership/channel checks remain.
  // Hash only stable recipient identity, never transport credentials.
  const previewFingerprint = createHash("sha256").update(JSON.stringify({
    clientId: client.id, propertyIds, text,
    target: !target ? null : { kind: target.kind, id: target.id, subscriberId: target.subscriberId,
      channel: target.kind === "bot" ? target.channel : "TELEGRAM",
      accountId: target.kind === "bot" ? target.accountId ?? null : null,
      endpointScopeId: target.kind === "bot" ? target.transport?.endpointScopeId ?? null : null,
      scopeRevision: target.kind === "bot" ? target.transport?.scopeRevision ?? null : null },
  })).digest("hex");

  // Подготовка без отправки: текст и ссылки (личные ссылки уже заведены выше —
  // по ним СМС и «открыл/не открыл»), бот не трогается, в хронологию не пишем.
  if (parsed.data.prepareOnly) {
    return res.json({ ok: true, prepared: true, sent: 0, propertyIds, fallback, previewFingerprint });
  }

  if (parsed.data.previewFingerprint && parsed.data.previewFingerprint !== previewFingerprint) {
    return res.status(409).json({ code: "PREVIEW_CHANGED", error: "Подборка или адресат изменились после предпросмотра. Проверьте текст заново — ничего не отправлено." });
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
    propertyIds,
    masked: delivery.masked || titleMasked || messageMasked,
    pausedUntil: delivery.pausedUntil,
    channel: targetChannel(target),
  });
});

/** 7.4 Шаг 1: SQL-фильтр без AI. Ранжирование с AI-причинами — см. /ai/match в фазе AI. */
matchingRouter.get("/:id/match", requireAuth, async (req, res) => {
  const id = z.guid().safeParse(req.params.id);
  const parsed = clientPropertyMatchQuerySchema.safeParse(req.query);
  if (!id.success || !parsed.success) return res.status(400).json({ error: "Неверные параметры подбора" });
  const client = await prisma.client.findUnique({ where: { id: id.data }, include: { desiredPlaces: true } });
  if (!client || client.deletedAt) return res.status(404).json({ error: "Клиент не найден" });
  if (!canAccessAssignedAgent(req, client.assignedAgentId)) return res.status(403).json({ error: "Недостаточно прав" });
  const { page, pageSize, scope } = parsed.data;
  const empty = (reason: "not_buyer" | "pending_acceptance") => ({
    unfiltered: false, scanned: 0, eligible: 0, total: 0, mineTotal: 0, page, pageSize,
    scope, hasMore: false, reason, requirementsSummary: [], properties: [],
  });
  const ownAgentId = scopeToOwnAgent(req);
  if (ownAgentId && ownAgentId === client.assignedAgentId && !client.acceptedAt) {
    return res.json(empty("pending_acceptance"));
  }
  // A second role is intentional, human-confirmed data; old raw dualIntent is not evidence.
  if (!confirmedClientIntents(client).buys) {
    return res.json(empty("not_buyer"));
  }
  const result = await clientPropertyMatchingCatalog(client.id, currentBuyerMatchingCriteria(client), {
    viewerId: req.agent!.id, canDeleteProperties: can(req, "properties.delete"), page, pageSize, scope,
  });
  const seesPhone = can(req, "clients.viewPhone");
  return res.json({ ...result, properties: result.properties.map(property => ({
    ...property,
    title: phoneSafeText(property.title, seesPhone),
    district: property.district ? { ...property.district, name: phoneSafeText(property.district.name, seesPhone) } : null,
  })) });
});
