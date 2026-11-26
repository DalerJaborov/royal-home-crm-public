/**
 * ОТПРАВКА ОБЪЕКТОВ ПРЯМО ИЗ ПЕРЕПИСКИ, БЕЗ КАРТОЧКИ КЛИЕНТА (26.11.2026).
 *
 * Владелец: «клиент должен СНАЧАЛА посмотреть объекты, а потом уже дать номер. Нужен
 * доступ отправлять любые объекты любому собеседнику, и без карточки, и без принятой
 * заявки». Раньше объект уходил только через POST /clients/:id/send-properties, то есть
 * только клиенту с карточкой, а карточка заводится ПОСЛЕ номера, — замкнутый круг.
 *
 * Что делает отправка (POST /conversations/:id/send-properties):
 *  - сообщение клиенту — короткая карточка каждого объекта (тип, район, площадь, этаж,
 *    цена) и личная ссылка /l/<токен>; контакты и точный адрес собственника не уходят
 *    никогда (в текст кладутся только поля объекта, не название и не адрес);
 *  - следом до нескольких лучших фото через очередь исходящих файлов
 *    (lib/outgoingMediaJobs.ts): сжатие и отправка в фоне, пузырь «В очереди» у сотрудника.
 *    Не готовы фото или канал их не умеет — клиент всё равно получил текст со ссылкой;
 *  - карточку клиента отправка НЕ создаёт и заявку не принимает. Журнал показов
 *    (PropertyExposure) пишется на пару (канал, собеседник) — тот же мост, что у бота, —
 *    и привяжется к карточке сам, когда она появится (linkExposuresToClient). Хронология
 *    клиента и «объект отправлен» пишутся, только если карточка у переписки есть;
 *  - рубильник `sendPropertiesWithoutCardEnabled`: выключен — прежний отказ «сначала
 *    примите заявку», отправка только клиенту с принятой карточкой.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Request } from "express";
import { maskPhones } from "@royal-home/shared";
import { prisma } from "../db.js";
import { can, scopeToOwnAgent } from "../auth/middleware.js";
import { uploadsDir } from "../upload.js";
import {
  agentSender,
  deliverToConversation,
  lastClientMessage,
  lastClientMessageAt,
  messagingWindowStateOfTarget,
  type DeliveryTarget,
} from "./conversationDelivery.js";
import { automationSwitchOn } from "./automationSwitches.js";
import { detectClientLanguage } from "../ai/clientLanguage.js";
import { PROPERTY_TYPE_LABELS } from "../ai/agencyVoice.js";
import { siteListingUrl } from "./siteListingUrl.js";
import { getOrCreatePropertyShareLinks } from "./propertyShareLink.js";
import { buildPropertyCardsText, formatPriceForClient } from "./propertyOfferText.js";
import { recordExposures } from "./propertyExposures.js";
import { recordPropertyDispatchAccepted } from "./clientWorkflowObservations.js";
import { CHANNEL_WORD, NOT_OFFERABLE_STATUSES, SENDABLE_CHANNELS, channelEnabled, exposureChannel, notifyPropertyOwners, targetChannel } from "./propertySendCommon.js";
import { enqueueOutgoingMedia, normalizeOutgoingMime, outgoingMediaChannelOf, outgoingMediaCompressOn, outgoingMediaSpoolDir, resolveMediaTarget } from "./outgoingMediaJobs.js";
import { pauseMinutesUntil } from "./replyPauseInput.js";
import { describeError } from "./describeError.js";
import { logAudit } from "./audit.js";
import { logSystemError } from "./systemError.js";
import { TG_PREFIX } from "./conversationId.js";
import { loadCustomerTransportForConversation } from "./customerConversationScope.js";

export const SEND_NEEDS_CARD_TEXT = "Сначала примите заявку: у этого диалога ещё нет карточки клиента";
/** Фото в одном отправлении не больше этого: десять объектов по четыре снимка — это сорок сообщений подряд. */
const MAX_PHOTOS_TOTAL = 8;

type Outcome = { status: number; body: Record<string, unknown> };

/** Сколько снимков брать с одного объекта: один объект — подробно, пачка — только обложки. */
export function photosPerProperty(propertyCount: number): number {
  if (propertyCount <= 1) return 4;
  if (propertyCount === 2) return 3;
  return 1;
}

interface ConversationInfo {
  rawId: string;
  target: DeliveryTarget;
  clientId: string | null;
  leadDraft: unknown;
}

/** Переписка по id инбокса («uuid» или «tg_uuid»): адресат доставки и карточка клиента, если она есть. */
async function loadConversation(rawId: string): Promise<ConversationInfo | null> {
  const resolved = await resolveMediaTarget(rawId);
  if (!resolved) return null;
  // Как у resolveSendTarget (отправка из карточки): без аккаунта (transport) показ не записать в журнал,
  // а Meta-сообщение не уйдёт. У чата сайта аккаунта нет, и это норма.
  const transport = resolved.kind === "bot" && resolved.channel !== "WEBSITE" ? await loadCustomerTransportForConversation(resolved.id) : null;
  if (resolved.kind === "bot" && resolved.channel !== "WEBSITE" && !transport) return null;
  const target: DeliveryTarget = resolved.kind === "bot" && transport ? { ...resolved, transport } : resolved;
  if (rawId.startsWith(TG_PREFIX)) {
    const c = await prisma.telegramConversation.findUnique({ where: { id: target.id }, select: { clientId: true, leadDraft: true } });
    return c ? { rawId, target, clientId: c.clientId, leadDraft: c.leadDraft } : null;
  }
  const c = await prisma.botConversation.findUnique({ where: { id: target.id }, select: { clientId: true, leadDraft: true } });
  return c ? { rawId, target, clientId: c.clientId, leadDraft: c.leadDraft } : null;
}

const CLIENT_SELECT = { id: true, shortId: true, assignedAgentId: true, assignedAt: true, acceptedAt: true, deletedAt: true } as const;

/** Прежний запрет (рубильник выключен): объект уходит только клиенту с принятой карточкой. */
function legacyDenied(req: Request, client: { acceptedAt: Date | null } | null): string | null {
  if (!client) return SEND_NEEDS_CARD_TEXT;
  if (scopeToOwnAgent(req) && !client.acceptedAt) return "Сначала примите заявку — до принятия карточка закрыта";
  return null;
}

/** Что собрал бот о запросе собеседника — для вкладки «Рекомендуем» у диалога без карточки. */
export function draftCriteria(raw: unknown): { rooms?: number; districtId?: string; districtName?: string; budgetMin?: number; budgetMax?: number; type?: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const out = {
    rooms: num(d.rooms),
    districtId: str(d.districtId),
    districtName: str(d.districtName),
    budgetMin: num(d.budgetMin),
    budgetMax: num(d.budgetMax),
    type: str(d.type),
  };
  return Object.values(out).some((v) => v !== undefined) ? out : null;
}

/**
 * Состояние для шторки выбора (GET /conversations/:id/send-context): куда уйдёт, открыто ли
 * окно 24 ч, что уже отправляли этому собеседнику и что бот собрал о его запросе. Один лёгкий
 * запрос вместо тяжёлой карточки клиента.
 */
export async function loadSendContext(req: Request, rawId: string): Promise<Outcome> {
  const info = await loadConversation(rawId);
  if (!info) return { status: 404, body: { error: "Диалог не найден" } };
  const enabled = await automationSwitchOn("sendPropertiesWithoutCardEnabled");
  const client = info.clientId ? await prisma.client.findUnique({ where: { id: info.clientId }, select: CLIENT_SELECT }) : null;
  const denied = enabled ? null : legacyDenied(req, client);
  const channel = targetChannel(info.target);
  const word = CHANNEL_WORD[channel] ?? channel;
  const [enabledChannel, lastAt, windowState] = await Promise.all([
    channelEnabled(info.target),
    lastClientMessageAt(info.target),
    messagingWindowStateOfTarget(info.target),
  ]);
  const windowOpen = windowState !== "closed";
  const sendable = SENDABLE_CHANNELS.has(channel);
  const photos = outgoingMediaChannelOf(info.target) !== null;
  const hint = !sendable
    ? `Канал ${word} больше не поддерживается.`
    : !enabledChannel
      ? `${word} выключен в Настройках, сообщение не уйдёт.`
      : !windowOpen
        ? `Клиент не писал в ${word} больше суток, Meta не пропустит сообщение.`
        : photos
          ? `Уйдёт в ${word}: карточка со ссылкой и фото.`
          : `Уйдёт в ${word}: карточка со ссылкой.`;
  const { channel: exChannel, recipientId } = exposureChannel(info.target);
  const exposures = await prisma.propertyExposure.findMany({
    where: {
      sentAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      propertyId: { not: null },
      OR: [{ channel: exChannel, recipientId }, ...(info.clientId ? [{ clientId: info.clientId }] : [])],
    },
    select: { propertyId: true },
    distinct: ["propertyId"],
    take: 200,
  });
  return {
    status: 200,
    body: {
      hasCard: !!client && !client.deletedAt,
      clientId: client?.id ?? null,
      allowed: denied === null,
      deniedReason: denied,
      channel: sendable ? channel : null,
      channelEnabled: enabledChannel && sendable,
      windowOpen,
      lastClientMessageAt: lastAt?.toISOString() ?? null,
      photosSupported: photos,
      hint,
      sentPropertyIds: exposures.map((e) => e.propertyId).filter((id): id is string => !!id),
      draft: draftCriteria(info.leadDraft),
    },
  };
}

/** Копия снимка объекта в спул очереди: очередь забирает файл себе, а оригинал нужен сайту и карточке. */
async function enqueuePropertyPhotos(
  agentId: string,
  rawId: string,
  photos: { url: string }[],
  pauseMinutes: number | undefined
): Promise<{ queued: string[]; skipped: number }> {
  const queued: string[] = [];
  let skipped = 0;
  const spool = outgoingMediaSpoolDir();
  for (const photo of photos) {
    // Имя файла из базы берём только через basename: склейка папки с чужой строкой — выход за её пределы.
    const name = path.basename(photo.url);
    const source = path.join(uploadsDir, name);
    if (!name || name.startsWith(".") || !fs.existsSync(source)) {
      skipped += 1;
      continue;
    }
    const copy = path.join(spool, `${randomUUID()}${path.extname(name).toLowerCase()}`);
    try {
      await fs.promises.copyFile(source, copy);
      const size = (await fs.promises.stat(copy)).size;
      const outcome = await enqueueOutgoingMedia({
        agentId,
        conversationId: rawId,
        file: { path: copy, size, mimetype: normalizeOutgoingMime("", name), originalname: name },
        pauseMinutes,
      });
      if (outcome.status === 202 && typeof outcome.body.jobId === "string") queued.push(outcome.body.jobId);
      else skipped += 1;
    } catch (err) {
      await fs.promises.rm(copy, { force: true }).catch(() => {});
      skipped += 1;
      void logSystemError("meta", `Фото объекта не поставлено в очередь отправки: ${describeError(err)}`);
    }
  }
  return { queued, skipped };
}

export interface SendFromConversationInput {
  req: Request;
  rawId: string;
  propertyIds: string[];
  caption?: string;
  pausedUntil?: Date;
  prepareOnly?: boolean;
}

export async function sendPropertiesFromConversation(input: SendFromConversationInput): Promise<Outcome> {
  const { req, rawId } = input;
  const agentId = req.agent!.id;
  const info = await loadConversation(rawId);
  if (!info) return { status: 404, body: { error: "Диалог не найден" } };

  const client = info.clientId ? await prisma.client.findUnique({ where: { id: info.clientId }, select: CLIENT_SELECT }) : null;
  if (client?.deletedAt) return { status: 409, body: { error: "Карточка в Корзине — сначала восстановите её" } };
  const withoutCardOn = await automationSwitchOn("sendPropertiesWithoutCardEnabled");
  if (!withoutCardOn) {
    const denied = legacyDenied(req, client);
    if (denied) return { status: 403, body: { error: denied } };
  }

  const propertyIds = [...new Set(input.propertyIds)];
  const found = await prisma.property.findMany({
    where: {
      id: { in: propertyIds },
      deletedAt: null,
      ...(!can(req, "properties.delete") ? { deleteRequests: { none: { requestedById: agentId, status: "PENDING" } } } : {}),
    },
    include: {
      district: { select: { name: true } },
      photos: { orderBy: { order: "asc" }, take: 4, select: { url: true } },
    },
  });
  if (found.length === 0) return { status: 404, body: { error: "Объекты не найдены" } };
  if (found.length !== propertyIds.length) {
    return { status: 409, body: { error: "Часть выбранных объектов недоступна. Обновите список и повторите — ничего не отправлено" } };
  }
  const byId = new Map(found.map((p) => [p.id, p]));
  const properties = propertyIds.map((id) => byId.get(id)!);
  const notOfferable = properties.filter((p) => NOT_OFFERABLE_STATUSES.has(p.status));
  if (notOfferable.length > 0) {
    return { status: 409, body: { error: `Продан или снят с продажи: ${notOfferable.map((p) => `№${p.shortId}`).join(", ")}. Уберите из выбора и повторите.` } };
  }

  // Ссылка: страница на сайте, если объект там есть; иначе личная /l/<токен>. С карточкой —
  // ссылка этого клиента (по ней видно «открыл»), без карточки — своя на каждую отправку.
  const linkIds = properties.filter((p) => p.offSite || siteListingUrl(p) === null).map((p) => p.id);
  const shareLinks = await getOrCreatePropertyShareLinks(prisma, {
    propertyIds: linkIds,
    clientId: client?.id ?? null,
    createdByAgentId: agentId,
    fresh: !client,
  });
  const urlOf = (p: (typeof properties)[number]) => shareLinks.get(p.id)?.url ?? siteListingUrl(p)!;

  const lastIncoming = await lastClientMessage(info.target);
  const language = lastIncoming ? detectClientLanguage(lastIncoming) : "unknown";
  const { text, masked: messageMasked } = maskPhones(
    buildPropertyCardsText(
      properties.map((p) => ({
        shortId: p.shortId,
        kind: p.rooms ? `${p.rooms}-комн` : PROPERTY_TYPE_LABELS[p.type] ?? String(p.type),
        district: p.district?.name ?? null,
        areaSqm: p.areaSqm ? Number(p.areaSqm) : null,
        floor: p.floor,
        totalFloors: p.totalFloors,
        price: formatPriceForClient(p.price, p.currency),
        url: urlOf(p),
      })),
      language,
      input.caption
    )
  );
  const fallback = {
    text,
    links: properties.map((p) => ({ propertyId: p.id, shortId: p.shortId, url: urlOf(p) })),
  };
  if (input.prepareOnly) return { status: 200, body: { ok: true, prepared: true, sent: 0, propertyIds, fallback } };

  const sender = await agentSender(agentId);
  const delivery = await deliverToConversation(info.target, text, input.pausedUntil, { sender });
  if (!delivery.ok) {
    return { status: delivery.status, body: { error: delivery.error, code: delivery.code, fallback } };
  }

  // Фото — следом, в фоне. Любой сбой здесь не отменяет уже ушедшую карточку со ссылкой.
  let photos: { queued: number; jobIds: string[]; skipped: number; note: string | null } = { queued: 0, jobIds: [], skipped: 0, note: null };
  if (outgoingMediaChannelOf(info.target) === null) {
    photos.note = "Этот канал не принимает фото, клиент получил карточку со ссылкой.";
  } else if (!(await outgoingMediaCompressOn())) {
    photos.note = "Отправка фото выключена в Настройках, клиент получил карточку со ссылкой.";
  } else {
    const per = photosPerProperty(properties.length);
    const picked = properties.flatMap((p) => p.photos.slice(0, per)).slice(0, MAX_PHOTOS_TOTAL);
    if (picked.length === 0) photos.note = "У выбранных объектов нет фото, клиент получил карточку со ссылкой.";
    else {
      const pauseMinutes = input.pausedUntil ? pauseMinutesUntil(input.pausedUntil) : undefined;
      const r = await enqueuePropertyPhotos(agentId, rawId, picked, pauseMinutes);
      photos = { queued: r.queued.length, jobIds: r.queued, skipped: r.skipped, note: r.skipped > 0 ? "Часть фото не удалось поставить в очередь, ссылка и карточка ушли." : null };
    }
  }

  // Журнал показов: с карточкой — на клиента, без — на пару (канал, собеседник); к карточке
  // привяжется, когда она появится. Ошибка записи сообщение клиенту уже не отменяет.
  const { channel: exChannel, recipientId } = exposureChannel(info.target);
  await recordExposures(
    exChannel,
    recipientId,
    properties.map((p) => ({ propertyId: p.id, shortId: p.shortId, kind: photos.queued > 0 ? ("PHOTO" as const) : ("LINK" as const) })),
    client?.id,
    info.target.kind === "bot" ? info.target.transport : undefined
  );
  if (client) {
    await recordPropertyDispatchAccepted(client.id, client.assignedAt ?? new Date(), propertyIds, targetChannel(info.target), agentId).catch(() => {});
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
        .catch((err) => console.error("[conversations] запись отправки объектов:", err instanceof Error ? err.message : err));
    }
  }

  const who = sender.kind === "agent" ? sender.agentName : "Сотрудник";
  await notifyPropertyOwners(
    properties,
    agentId,
    client ? `агент ${who} предложил его своему клиенту №${client.shortId}` : `агент ${who} предложил его собеседнику в переписке`
  );

  logAudit(req, "PROPERTIES_SENT_FROM_CONVERSATION", rawId.startsWith(TG_PREFIX) ? "TelegramConversation" : "BotConversation", info.target.id, {
    propertyShortIds: properties.map((p) => p.shortId),
    channel: targetChannel(info.target),
    hasCard: !!client,
    photosQueued: photos.queued,
    textHash: createHash("sha256").update(text).digest("hex").slice(0, 12),
  });

  return {
    status: 200,
    body: {
      ok: true,
      sent: properties.length,
      propertyIds,
      masked: delivery.masked || messageMasked,
      pausedUntil: delivery.pausedUntil,
      channel: targetChannel(info.target),
      hasCard: !!client,
      photos,
    },
  };
}
