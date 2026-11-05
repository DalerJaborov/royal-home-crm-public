import { prisma, type TxClient } from "../db.js";
import type { Property } from "../generated/prisma/client.js";
import { logSystemError } from "./systemError.js";
import { formatPrice } from "../ai/seoGenerator.js";
import { loadMoneyContext, toTjs } from "./money.js";
import { buildPriceDisplay } from "./reelsCaptionTemplate.js";
import { publishPropertyPriceDropStory } from "./instagramStories.js";
import { formatShortCode } from "@royal-home/shared";
import { logSystemAudit } from "./audit.js";
import { sendPushToAgent } from "../push.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { CAPTION_FACT_FIELDS, rewriteStoredCaptionAfterEdit } from "./publishedVideoFix.js";
import { stagePriceCaptionTargets } from "./priceCaptionDelivery.js";

/**
 * Подпись правили руками — цену в ней автоматически не заменить. Тихо оставить
 * старую цену нельзя: ролик выйдет с ней (владелец 07.10.2026). Пишем в историю
 * объекта и зовём ответственного и руководство — а не в журнал ошибок, который
 * они не читают.
 */
async function reportCaptionNeedsManualFix(property: {
  id: string;
  shortId: number;
  assignedAgentId: string | null;
  intakeAgentId: string | null;
  createdById: string | null;
}): Promise<void> {
  const code = formatShortCode("ОБ", property.shortId);
  logSystemAudit("PROPERTY_FIELDS_CHANGED", "Property", property.id, {
    shortId: property.shortId,
    changes: [
      {
        field: "reelsCaption",
        label: "Подпись к ролику",
        was: "старая цена в тексте",
        becomes: "цену в подписи нужно поправить руками",
      },
    ],
  });
  const body = "Цена изменилась, а в подписи к ролику старой цены нет дословно — поправьте цену в подписи вручную, иначе ролик выйдет со старой.";
  const url = `/properties/${property.shortId}`;
  const responsible = property.assignedAgentId ?? property.intakeAgentId ?? property.createdById;
  if (responsible) {
    await sendPushToAgent(responsible, { kind: "task", title: `${code}: поправьте цену в подписи`, body, url, tag: `property-caption-manual-${property.id}` });
  }
  await enqueueDirectorAlert({
    title: `${code}: цену в подписи править руками`,
    body,
    url,
    kind: "task",
    tag: `property-caption-manual-dir-${property.id}`,
    recipientRoles: ["DIRECTOR", "ADMIN"],
  });
}


export interface PriceCaptionStage {
  captionNeedsManualFix: boolean;
  captionRewritten: boolean | null;
  descriptionChanged: boolean;
  queued: string[];
  manual: string[];
}

export interface PriceSyncResult {
  updated: string[];
  failed: { channel: string; error: string }[];
  skipped: string | null;
  captionNeedsManualFix: boolean;
  queued: string[];
  manual: string[];
}

/**
 * Stage the caption, the site description, and the intent for each published
 * target while the price writer owns the row. The next price sees this caption.
 */
export async function stagePublishedPriceChange(
  tx: TxClient,
  before: Property,
  after: Property,
  changedFields: readonly string[] = [],
): Promise<PriceCaptionStage> {
  let caption = after.reelsCaption;
  let captionRewritten: boolean | null = null;
  if (caption === before.reelsCaption && changedFields.some((field) => (CAPTION_FACT_FIELDS as readonly string[]).includes(field))) {
    captionRewritten = await rewriteStoredCaptionAfterEdit(before, after, tx);
    if (captionRewritten) {
      const current = await tx.property.findUniqueOrThrow({ where: { id: after.id }, select: { reelsCaption: true } });
      caption = current.reelsCaption;
    }
  }

  const money = await loadMoneyContext(tx);
  const oldSitePrice = formatPrice(toTjs(before.price, before.currency, money), "TJS");
  const newSitePrice = formatPrice(toTjs(after.price, after.currency, money), "TJS");
  const description = after.publishedOnSite && oldSitePrice !== newSitePrice
    ? after.description?.replaceAll(oldSitePrice, newSitePrice)
    : after.description;
  const descriptionChanged = description !== undefined && description !== after.description;

  const oldPrice = buildPriceDisplay(before.price, before.currency, money);
  const newPrice = buildPriceDisplay(after.price, after.currency, money);
  let captionNeedsManualFix = false;
  let updatedCaption: string | undefined;
  if (caption && oldPrice !== newPrice) {
    if (caption.includes(oldPrice)) updatedCaption = caption.replaceAll(oldPrice, newPrice);
    else captionNeedsManualFix = !caption.includes(newPrice);
  }

  if (updatedCaption !== undefined || descriptionChanged) {
    await tx.property.update({
      where: { id: after.id },
      data: { reelsCaption: updatedCaption, description: descriptionChanged ? description : undefined },
    });
  }
  const targets = oldPrice !== newPrice
    ? await stagePriceCaptionTargets(tx, after, captionNeedsManualFix ? null : updatedCaption ?? caption)
    : { queued: [], manual: [] };
  return { ...targets, captionNeedsManualFix, captionRewritten, descriptionChanged };
}

/** Price-drop announcements and staff alerts are one-shot effects of a committed edit. */
export async function reportPublishedPriceChange(before: Property, after: Property, stage: PriceCaptionStage): Promise<PriceSyncResult> {
  const result: PriceSyncResult = {
    updated: [], failed: [], queued: stage.queued, manual: stage.manual,
    skipped: stage.captionNeedsManualFix ? "подпись правили руками — старой цены в ней нет, пост остался как был" : null,
    captionNeedsManualFix: stage.captionNeedsManualFix,
  };
  try {
    const money = await loadMoneyContext();
    const oldTjs = toTjs(before.price, before.currency, money);
    const newTjs = toTjs(after.price, after.currency, money);
    if (newTjs < oldTjs && after.status === "AVAILABLE") {
      const latest = await prisma.property.findUnique({
        where: { id: after.id }, select: { version: true, deletedAt: true, status: true },
      });
      if (latest && !latest.deletedAt && latest.version === after.version && latest.status === "AVAILABLE") {
        await publishPropertyPriceDropStory(after.id, buildPriceDisplay(before.price, before.currency, money));
      }
    }
    if (stage.captionNeedsManualFix) await reportCaptionNeedsManualFix(after);
    if (stage.manual.length) {
      await logSystemError("meta", `Объект ${after.id}: после изменения цены проверьте подпись вручную (${stage.manual.join(", ")}).`);
    }
  } catch {
    await logSystemError("meta", `Объект ${after.id}: не удалось обработать уведомления после изменения цены.`);
  }
  return result;
}
