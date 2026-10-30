/**
 * ВЫПОЛНЕНИЕ ЗАЯВКИ АГЕНТА НА ИЗМЕНЕНИЕ ОПУБЛИКОВАННОГО ОБЪЕКТА ПОСЛЕ «ПРИНЯТЬ» (07.10.2026).
 *
 * Лежит в routes/properties/, а не в lib/: берёт `geocodeInBackground` и
 * `normalizePropertyAddress` из shared.ts роутов — как и сам PATCH карточки.
 *
 * ПОРЯДОК:
 *  1. «Захват» заявки и запись цены/данных — ОДНОЙ транзакцией под замком объекта
 *     (`withPropertyLock`): второй параллельный «Принять» видит уже не PENDING и получает 409.
 *     Сеть и очередь монтажа под замком не держим (`sendBackToMontajer` берёт тот же замок
 *     сам — вложенный вызов повис бы на втором соединении).
 *  2. Побочные эффекты — теми же функциями, что у PATCH карточки (lib/propertyUpdateEffects.ts):
 *     сайт, подпись в базе, цена в посты, автоподбор покупателей.
 *  3. Итог — `PropertyChangeResult`: что сделано и что остаётся РУКАМИ. Остаток уходит не в
 *     журнал ошибок, а адресату: push + запись в ленту (ответственному, приёмщику, маркетингу).
 *  4. Любой сбой → статус FAILED + человеческий текст в `error`, заявка остаётся видимой,
 *     ответ директору без 500.
 */
import {
  buildPropertyTitle,
  priceChangePayloadSchema,
  cardDataPayloadSchema,
  remakeVideoPayloadSchema,
  unpublishPayloadSchema,
  PROPERTY_CHANGE_KIND_LABELS,
  type PropertyChangeResult,
} from "@royal-home/shared";
import type { Prisma, Property } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { withPropertyLock } from "../../lib/videoHandoff.js";
import { logAgentAudit } from "../../lib/audit.js";
import { logSystemError } from "../../lib/systemError.js";
import { findAgentsWithPermission } from "../../lib/recipients.js";
import { closeLeadPushNotifications, sendPushToAgent } from "../../push.js";
import { publishPropertyUpdated, publishRequestUpdated } from "../../lib/livePublish.js";
import { formatPrice } from "../../ai/seoGenerator.js";
import { embedAndSaveProperty, EMBEDDING_RELEVANT_FIELDS } from "../../ai/embeddings.js";
import { describePropertyChanges } from "../../lib/propertyChanges.js";
import { refreshPublishedCaptions, removeFromSocial, sendBackToMontajer } from "../../lib/publishedVideoFix.js";
import { runPostUpdateEffects, seoFieldsForUpdate } from "../../lib/propertyUpdateEffects.js";
import {
  CHANGE_REQUEST_INCLUDE,
  channelName,
  parseCardPatch,
  summarizeChangeRequest,
  toChangeRequestDto,
  type PropertyUpdateInput,
} from "../../lib/propertyChangeRequests.js";
import { geocodeInBackground, normalizePropertyAddress } from "./shared.js";

export type ApproveOutcome =
  | { ok: false; status: number; error: string }
  | { ok: true; request: ReturnType<typeof toChangeRequestDto>; message: string };

/** Что захват записал в карточку (только для PRICE_CHANGE и CARD_DATA). */
interface AppliedWrite {
  before: Property;
  after: Property;
  changedFields: string[];
  priceChanged: boolean;
}

function newResult(): PropertyChangeResult {
  return { applied: [], manual: [], remakeQueued: false };
}

/**
 * «Принять»: захватить заявку, выполнить, записать итог, известить. Всегда возвращает ответ
 * для директора; исключений наружу не бросает (кроме потери базы на самом захвате).
 */
export async function approvePropertyChangeRequest(input: {
  requestId: string;
  actorId: string;
  note: string | null;
}): Promise<ApproveOutcome> {
  const { requestId, actorId } = input;
  const pre = await prisma.propertyChangeRequest.findUnique({
    where: { id: requestId },
    include: { property: true, author: { select: { id: true, fullName: true } } },
  });
  if (!pre) return { ok: false, status: 404, error: "Заявка не найдена" };
  if (pre.status !== "PENDING") return { ok: false, status: 409, error: "По этой заявке уже вынесено решение" };
  if (pre.property.deletedAt) return { ok: false, status: 409, error: "Объект в Корзине — по нему заявки не выполняются" };

  // ПОДГОТОВКА ВНЕ ЗАМКА: разбор тела и платная часть (SEO через ИИ) — под замком объекта их не держим.
  let pricePlan: {
    newPrice: number;
    newCurrency: string;
    remake: boolean;
    seo: Awaited<ReturnType<typeof seoFieldsForUpdate>>;
  } | null = null;
  let cardPlan: {
    patch: PropertyUpdateInput;
    changed: string[];
    remake: boolean;
    seo: Awaited<ReturnType<typeof seoFieldsForUpdate>>;
    districtName: string | null;
  } | null = null;
  let prepareError: string | null = null;

  if (pre.kind === "PRICE_CHANGE") {
    const body = priceChangePayloadSchema.safeParse(pre.payload);
    if (!body.success) prepareError = "Тело заявки повреждено (цена) — отклоните её и попросите отправить заново";
    else {
      const newCurrency = body.data.currency ?? pre.property.currency;
      const district = pre.property.districtId
        ? await prisma.district.findUnique({ where: { id: pre.property.districtId }, select: { name: true } })
        : null;
      const priceWillChange = Number(pre.property.price) !== body.data.newPrice || pre.property.currency !== newCurrency;
      pricePlan = {
        newPrice: body.data.newPrice,
        newCurrency,
        remake: body.data.remake,
        // SEO-мета (ИИ-текст в сомони) — та же, что пересобирает PATCH при смене цены; считается вне замка.
        seo: priceWillChange
          ? await seoFieldsForUpdate(pre.property, { price: body.data.newPrice, currency: newCurrency }, district?.name, [
              "price",
              "currency",
            ])
          : null,
      };
    }
  } else if (pre.kind === "CARD_DATA") {
    const body = cardDataPayloadSchema.safeParse(pre.payload);
    if (!body.success) prepareError = "Тело заявки повреждено (данные) — отклоните её и попросите отправить заново";
    else {
      const parsed = parseCardPatch(body.data.patch, pre.property as unknown as Record<string, unknown>);
      if (parsed.ok) {
        const effDistrictId =
          parsed.patch.districtId !== undefined ? parsed.patch.districtId : pre.property.districtId;
        const district = effDistrictId
          ? await prisma.district.findUnique({ where: { id: effDistrictId }, select: { name: true } })
          : null;
        cardPlan = {
          patch: parsed.patch,
          changed: parsed.changed,
          remake: body.data.remake,
          seo: await seoFieldsForUpdate(pre.property, parsed.patch, district?.name, parsed.changed),
          districtName: district?.name ?? null,
        };
      } else if (parsed.noop) {
        cardPlan = { patch: {}, changed: [], remake: body.data.remake, seo: null, districtName: null };
      } else prepareError = parsed.error;
    }
  }

  // ЗАХВАТ + ЗАПИСЬ под замком объекта.
  type Claim = { conflict: string } | { write: AppliedWrite | null; property: Property };
  let claim: Claim;
  try {
    claim = await withPropertyLock(pre.propertyId, async (tx): Promise<Claim> => {
      const fresh = await tx.propertyChangeRequest.findUnique({ where: { id: requestId }, select: { status: true } });
      if (!fresh || fresh.status !== "PENDING") return { conflict: "По этой заявке уже вынесено решение" };
      const property = await tx.property.findUnique({ where: { id: pre.propertyId } });
      if (!property || property.deletedAt) return { conflict: "Объект в Корзине — по нему заявки не выполняются" };

      await tx.propertyChangeRequest.update({
        where: { id: requestId },
        data: { status: "APPROVED", decidedById: actorId, decidedAt: new Date(), decisionNote: input.note },
      });
      if (prepareError) return { write: null, property };

      if (pricePlan) {
        const priceChanged = Number(property.price) !== pricePlan.newPrice || property.currency !== pricePlan.newCurrency;
        if (!priceChanged) return { write: null, property };
        await tx.priceChange.create({
          data: {
            propertyId: property.id,
            oldPrice: property.price,
            oldCurrency: property.currency,
            newPrice: pricePlan.newPrice,
            newCurrency: pricePlan.newCurrency as "USD" | "TJS",
            changedById: actorId,
          },
        });
        const { description: _keepAgentDescription, ...seoMeta } = pricePlan.seo ?? {};
        const after = await tx.property.update({
          where: { id: property.id },
          data: {
            price: pricePlan.newPrice,
            currency: pricePlan.newCurrency as "USD" | "TJS",
            ...seoMeta,
            version: { increment: 1 },
          },
        });
        const changedFields = ["price", ...(property.currency !== pricePlan.newCurrency ? ["currency"] : [])];
        return { write: { before: property, after, changedFields, priceChanged: true }, property };
      }

      if (cardPlan && cardPlan.changed.length > 0) {
        const { patch } = cardPlan;
        const title = buildPropertyTitle({
          type: patch.type ?? property.type,
          rooms: patch.rooms !== undefined ? patch.rooms : property.rooms,
          districtName: cardPlan.districtName ?? undefined,
        });
        const addressChanged = patch.address !== undefined && patch.address !== property.address;
        const { description: _keepAgentDescription, ...seoMeta } = cardPlan.seo ?? {};
        const after = await tx.property.update({
          where: { id: property.id },
          data: {
            ...patch,
            title,
            ...(patch.address !== undefined ? { canonicalAddress: normalizePropertyAddress(patch.address) } : {}),
            // Адрес сменился — точка, найденная автогеокодером по старому адресу, устарела (как в PATCH).
            ...(addressChanged && property.geocodedAt != null && property.lat != null
              ? { lat: null, lng: null, geocodedAt: null }
              : {}),
            ...seoMeta,
            version: { increment: 1 },
          } as Prisma.PropertyUncheckedUpdateInput,
        });
        return { write: { before: property, after, changedFields: cardPlan.changed, priceChanged: false }, property };
      }
      return { write: null, property };
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    void logSystemError("api", `Заявка на изменение ${requestId}: захват не удался — ${reason}`);
    return { ok: false, status: 500, error: "Не удалось принять заявку — попробуйте ещё раз" };
  }
  if ("conflict" in claim) return { ok: false, status: 409, error: claim.conflict };

  // ВЫПОЛНЕНИЕ. Любое исключение → FAILED с текстом, а не 500.
  const result = newResult();
  let error: string | null = prepareError;
  const property = claim.property;
  const authorName = pre.author.fullName;
  const url = `/properties/${property.shortId}?changeRequest=${requestId}`;
  try {
    if (!prepareError) {
      switch (pre.kind) {
        case "PRICE_CHANGE":
        case "CARD_DATA":
          error = await executeFieldsChange({ pre, claim: claim.write, pricePlan, cardPlan, result, actorId });
          break;
        case "REMAKE_VIDEO": {
          const body = remakeVideoPayloadSchema.safeParse(pre.payload);
          if (!body.success) {
            error = "Тело заявки повреждено (перемонтаж) — отклоните её и попросите отправить заново";
            break;
          }
          error = await executeRemake({
            propertyId: property.id,
            actorId,
            reason: body.data.reason,
            comment: pre.comment,
            removeSocial: body.data.removeFromSocial,
            result,
          });
          break;
        }
        case "UNPUBLISH": {
          const body = unpublishPayloadSchema.safeParse(pre.payload);
          if (!body.success) {
            error = "Тело заявки повреждено (снятие) — отклоните её и попросите отправить заново";
            break;
          }
          error = await executeUnpublish(property.id, body.data.channels, result);
          break;
        }
        case "OTHER":
          result.applied.push("Принято к сведению — директор сделает сам");
          break;
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    void logSystemError("api", `Заявка на изменение ${requestId} (${pre.kind}): выполнение упало — ${reason}`, { url });
    error = `Не удалось выполнить автоматически: ${reason}`;
  }

  const status = error ? "FAILED" : "APPROVED";
  const row = await prisma.propertyChangeRequest.update({
    where: { id: requestId },
    data: { status, result: result as unknown as Prisma.InputJsonValue, error },
    include: CHANGE_REQUEST_INCLUDE,
  });

  const summary = summarizeChangeRequest(pre.kind, pre.payload, pre.property);
  logAgentAudit(actorId, "PROPERTY_CHANGE_REQUEST_DECIDED", "Property", property.id, {
    requestId,
    kind: pre.kind,
    decision: status,
    summary,
    authorId: pre.authorId,
    authorName,
    note: input.note,
    applied: result.applied,
    manual: result.manual.map((m) => `${channelName(m.channel)}: ${m.text}`),
    error,
  });
  if (claim.write) {
    // Хроника объекта: «было → стало», как у обычной правки карточки (PATCH).
    const w = claim.write;
    const changes = describePropertyChanges(
      w.changedFields,
      w.after as unknown as Record<string, unknown>,
      w.before as unknown as Record<string, unknown>
    );
    if (changes.length > 0) {
      logAgentAudit(actorId, "PROPERTY_FIELDS_CHANGED", "Property", property.id, {
        shortId: property.shortId,
        changes,
        viaChangeRequest: requestId,
      });
    }
  }

  await notifyAfterDecision({ requestId, kind: pre.kind, status, error, result, authorId: pre.authorId, actorId, property, summary, url });

  publishRequestUpdated({
    requestId,
    propertyId: property.id,
    agentIds: [pre.authorId],
    stage: status,
    actorId,
  });
  if (claim.write) publishPropertyUpdated({ propertyId: property.id, actorId, stage: claim.write.after.status });

  const message = error
    ? `Не выполнилось: ${error}`
    : result.manual.length > 0
      ? `Принято. Автоматически сделано: ${result.applied.length}. Руками осталось: ${result.manual.length} — напоминание отправлено`
      : "Принято и выполнено";
  return { ok: true, request: toChangeRequestDto(row), message };
}

/** PRICE_CHANGE / CARD_DATA: эффекты записи и (по желанию агента) перемонтаж. Возвращает текст сбоя или null. */
async function executeFieldsChange(a: {
  pre: { id: string; kind: string; propertyId: string; comment: string | null; property: Property };
  claim: AppliedWrite | null;
  pricePlan: { remake: boolean } | null;
  cardPlan: { remake: boolean } | null;
  result: PropertyChangeResult;
  actorId: string;
}): Promise<string | null> {
  const { pre, claim, result } = a;
  const remake = a.pricePlan?.remake ?? a.cardPlan?.remake ?? false;
  const channels = pre.property.publishedChannels ?? [];

  if (!claim) {
    result.applied.push(
      pre.kind === "PRICE_CHANGE" ? "Цена в карточке уже такая — менять нечего" : "Данные в карточке уже такие — менять нечего"
    );
  } else if (pre.kind === "PRICE_CHANGE") {
    result.applied.push(
      `Цена в карточке: ${formatPrice(Number(claim.before.price), claim.before.currency)} → ${formatPrice(Number(claim.after.price), claim.after.currency)}`
    );
    const fx = await runPostUpdateEffects({
      existing: claim.before,
      updated: claim.after,
      changedFields: claim.changedFields,
      priceActuallyChanged: true,
      staysAvailable: true,
      resyncSite: claim.before.publishedOnSite,
      resyncReason: "заявка на изменение: цена",
      awaitPriceSync: true,
    });
    if (claim.before.publishedOnSite) result.applied.push("Сайт: новая цена отправлена на витрину");
    const sync = fx.priceSync;
    for (const c of sync?.updated ?? []) result.applied.push(`${channelName(c)}: цена в подписи обновлена`);
    if (sync?.skipped) {
      for (const c of channels.filter((x) => ["FACEBOOK", "TELEGRAM", "YOUTUBE"].includes(x))) {
        result.manual.push({ channel: c, text: `${channelName(c)}: ${sync.skipped} — поправьте цену в подписи вручную` });
      }
    }
    for (const f of sync?.failed ?? []) {
      result.manual.push({
        channel: f.channel,
        text: `${f.channel === "—" ? "Соцсети" : channelName(f.channel)}: не обновилось автоматически (${f.error}) — поправьте цену в подписи вручную`,
      });
    }
    // Площадки, где подпись через API менять НЕЛЬЗЯ (Meta / TikTok / Threads) — человеку, а не в журнал.
    if (channels.includes("INSTAGRAM")) {
      result.manual.push({ channel: "INSTAGRAM", text: "Instagram: поправьте цену в подписи Reels (Meta не даёт менять её через API)" });
    }
    if (channels.includes("TIKTOK")) {
      result.manual.push({ channel: "TIKTOK", text: "TikTok: поправьте цену в подписи видео в приложении (через API нельзя)" });
    }
    if (channels.includes("THREADS")) {
      result.manual.push({ channel: "THREADS", text: "Threads: поправьте цену в тексте поста вручную (через API нельзя)" });
    }
  } else {
    const fx = await runPostUpdateEffects({
      existing: claim.before,
      updated: claim.after,
      changedFields: claim.changedFields,
      priceActuallyChanged: false,
      staysAvailable: true,
      resyncSite: claim.before.publishedOnSite,
      resyncReason: "заявка на изменение: данные карточки",
      awaitPriceSync: false,
    });
    result.applied.push(`Карточка обновлена (полей: ${claim.changedFields.length})`);
    if (claim.before.publishedOnSite) result.applied.push("Сайт: данные отправлены на витрину");
    if (EMBEDDING_RELEVANT_FIELDS.some((f) => claim.changedFields.includes(f))) void embedAndSaveProperty(claim.after.id);
    if (
      (claim.changedFields.includes("address") || claim.changedFields.includes("districtId")) &&
      claim.after.address
    ) {
      geocodeInBackground(claim.after.id);
    }
    // Как кнопка «Готово» (finish-edit): подпись из базы — в вышедшие посты.
    if (channels.length > 0) {
      if (fx.captionRewritten === false) {
        result.manual.push({
          channel: "CAPTION",
          text: "Подпись ролика правили руками — факты в ней не заменены автоматически, поправьте текст в карточке и в постах",
        });
      } else {
        const captions = await refreshPublishedCaptions(claim.after.id, { keepStoredCaption: true });
        for (const c of captions.updated) result.applied.push(`${channelName(c)}: подпись обновлена`);
        for (const f of captions.failed) {
          result.manual.push({
            channel: f.channel,
            text: `${channelName(f.channel)}: подпись не обновилась (${f.error}) — поправьте вручную`,
          });
        }
        for (const m of captions.manual) {
          result.manual.push({ channel: m.channel, text: `${channelName(m.channel)}: ${m.reason}${m.url ? ` (${m.url})` : ""}` });
        }
        logAgentAudit(a.actorId, "PROPERTY_EDIT_FINISHED", "Property", claim.after.id, {
          shortId: claim.after.shortId,
          updated: captions.updated,
          failed: captions.failed.map((f) => f.channel),
          site: claim.before.publishedOnSite,
          viaChangeRequest: pre.id,
        });
      }
    }
  }

  if (!remake) return null;
  const label = pre.kind === "PRICE_CHANGE" && claim
    ? `Новая цена: ${formatPrice(Number(claim.after.price), claim.after.currency)}.`
    : pre.kind === "PRICE_CHANGE"
      ? "Цена изменилась."
      : "Данные карточки изменились.";
  // Старый ролик со старой ценой/данными снимается, КОГДА ВЫЙДЕТ НОВЫЙ (владелец 30.10.2026):
  // пока монтажёр работает, объект остаётся виден. Снимает задание публикации нового ролика
  // (replaceOldPostsBeforeRemakePublish) — иначе публикация пропустила бы занятые каналы.
  const failure = await executeRemake({
    propertyId: pre.propertyId,
    actorId: a.actorId,
    reason: "CARD_DATA_CHANGED",
    comment: [label, pre.comment?.trim()].filter(Boolean).join(" "),
    removeSocial: "on-new-video",
    result,
  });
  return failure ? `Данные обновлены, но ролик не ушёл на перемонтаж: ${failure}` : null;
}

/** Возврат ролика монтажёру. Возвращает текст отказа или null. */
async function executeRemake(a: {
  propertyId: string;
  actorId: string;
  reason: Parameters<typeof sendBackToMontajer>[2];
  comment: string | null;
  removeSocial: boolean | "on-new-video";
  result: PropertyChangeResult;
}): Promise<string | null> {
  const sent = await sendBackToMontajer(a.propertyId, a.actorId, a.reason, a.comment?.trim() || null, null, {
    removeFromSocial: a.removeSocial,
  });
  if (!sent.ok) return sent.error;
  a.result.remakeQueued = true;
  a.result.applied.push(sent.message);
  if (sent.social) collectSocialRemoval(sent.social, a.result);
  return null;
}

/** «Убрать из соцсетей»: снять там, где площадка позволяет; остальное — списком руками. */
async function executeUnpublish(propertyId: string, only: string[] | undefined, result: PropertyChangeResult): Promise<string | null> {
  const prop = await prisma.property.findUnique({ where: { id: propertyId }, select: { publishedChannels: true } });
  const published = prop?.publishedChannels ?? [];
  if (published.length === 0) {
    result.applied.push("Ролик нигде не отмечен опубликованным — снимать нечего");
    return null;
  }
  const social = await removeFromSocial(propertyId, only && only.length > 0 ? only : undefined);
  if (social.blocked) return social.blocked;
  collectSocialRemoval(social, result);
  if (social.removed.length === 0 && social.manual.length === 0 && social.failed.length === 0 && social.notes.length === 0) {
    result.applied.push("Выбранные площадки уже сняты — менять нечего");
  }
  return null;
}

function collectSocialRemoval(
  social: Awaited<ReturnType<typeof removeFromSocial>>,
  result: PropertyChangeResult
): void {
  for (const c of social.removed) result.applied.push(`${channelName(c)}: ролик снят`);
  for (const n of social.notes) result.applied.push(`${channelName(n.channel)}: ${n.note}`);
  for (const f of social.failed) {
    result.manual.push({ channel: f.channel, text: `${channelName(f.channel)}: не удалось снять (${f.error}) — снимите вручную` });
  }
  for (const m of social.manual) {
    result.manual.push({ channel: m.channel, text: `${channelName(m.channel)}: ${m.reason}${m.url ? ` (${m.url})` : ""}` });
  }
}

/**
 * Извещения после решения: автору — итог; остаток руками — тем, кто может его сделать
 * (ответственный, приёмщик, маркетинг); остальным руководителям — гасим уведомление о заявке.
 */
async function notifyAfterDecision(a: {
  requestId: string;
  kind: keyof typeof PROPERTY_CHANGE_KIND_LABELS;
  status: "APPROVED" | "FAILED";
  error: string | null;
  result: PropertyChangeResult;
  authorId: string;
  actorId: string;
  property: Property;
  summary: string;
  url: string;
}): Promise<void> {
  const { result, property } = a;
  const manualText = result.manual.map((m) => m.text).join("\n");
  try {
    const title = a.error ? "Заявка принята, но не выполнилась" : "Заявка принята";
    const parts = [`${property.title}: ${a.summary}`];
    if (a.error) parts.push(a.error);
    else if (result.manual.length > 0) parts.push(`Осталось руками:\n${manualText}`);
    void sendPushToAgent(a.authorId, {
      title,
      body: parts.join("\n"),
      url: a.url,
      tag: `property-change-request-${a.requestId}-result`,
    });

    if (result.manual.length > 0) {
      const marketing = await findAgentsWithPermission("properties.aiListing");
      const recipients = [...new Set([property.assignedAgentId, property.intakeAgentId, ...marketing])].filter(
        (id): id is string => !!id && id !== a.authorId && id !== a.actorId
      );
      for (const id of recipients) {
        void sendPushToAgent(id, {
          title: `Нужно сделать руками: объект №${property.shortId}`,
          body: `${a.summary}\n${manualText}`,
          url: a.url,
          tag: `property-change-manual-${a.requestId}`,
          kind: "task",
        });
      }
    }

    const reviewers = await findAgentsWithPermission("properties.delete");
    await closeLeadPushNotifications(
      reviewers.filter((id) => id !== a.actorId).map((agentId) => ({ agentId, tag: `property-change-request-${a.requestId}` }))
    );
  } catch (err) {
    void logSystemError(
      "api",
      `Заявка на изменение ${a.requestId}: извещения после решения не ушли — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
