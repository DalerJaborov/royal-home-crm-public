import { prisma, type PropertyRecord, type TxClient } from "../db.js";
import { logSystemError } from "./systemError.js";
import { formatPrice } from "../ai/seoGenerator.js";
import { loadMoneyContext, loadUsdRateInfo, toTjs } from "./money.js";
import { buildPriceDisplay } from "./reelsCaptionTemplate.js";
import { queuePropertyPriceDropStory } from "./instagramStories.js";
import { formatShortCode, propertyPriceTjs } from "@royal-home/shared";
import { logSystemAudit } from "./audit.js";
import { sendPushToAgent } from "../push.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { CAPTION_FACT_FIELDS, rewriteStoredCaptionAfterEdit } from "./publishedVideoFix.js";
import { stagePriceCaptionTargets } from "./priceCaptionDelivery.js";
import { replaceCaptionPriceLines, replacePriceMentions } from "./captionPriceLine.js";

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
  before: PropertyRecord,
  after: PropertyRecord,
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
  // Описание сайта: сначала точная старая сумма, а если её нет (текст писали по
  // другому курсу или другими словами) — суммы рядом со старой ценой (объект 164,
  // 15.11.2026). Раньше условие ещё и требовало publishedOnSite: объект, цену
  // которого правили ДО выхода на сайт, выходил туда со старой ценой в тексте.
  let description = after.description;
  if (description && oldSitePrice !== newSitePrice) {
    if (description.includes(oldSitePrice)) description = description.replaceAll(oldSitePrice, newSitePrice);
    else {
      description = replacePriceMentions(
        description,
        { tjs: toTjs(before.price, before.currency, money), usd: before.currency === "USD" ? Number(before.price) : null },
        { tjsText: newSitePrice, usdText: after.currency === "USD" ? formatPrice(Number(after.price), "USD") : null },
      ).text;
    }
  }
  const descriptionChanged = description != null && description !== after.description;

  const oldPrice = buildPriceDisplay(before.price, before.currency, money);
  const newPrice = buildPriceDisplay(after.price, after.currency, money);
  let captionNeedsManualFix = false;
  let updatedCaption: string | undefined;
  if (caption && oldPrice !== newPrice) {
    if (caption.includes(oldPrice)) updatedCaption = caption.replaceAll(oldPrice, newPrice);
    else if (!caption.includes(newPrice)) {
      // Старой суммы дословно нет (курс дня написания, ручная правка пробелов) —
      // переписываем строку цены по месту. Не нашлась и строка — тогда руками.
      const byLine = replaceCaptionPriceLines(caption, newPrice);
      if (byLine.replaced > 0) updatedCaption = byLine.text;
      else captionNeedsManualFix = true;
    }
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
export async function reportPublishedPriceChange(before: PropertyRecord, after: PropertyRecord, stage: PriceCaptionStage): Promise<PriceSyncResult> {
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
        // История «цена снижена» — не мгновенной картинкой, а роликом объекта с карточкой (25.11.2026): задание
        // дождётся озвучки с новой ценой и выложит. Старая цена числом в сомони — курс только из Настроек.
        const usdRate = before.currency === "USD" || after.currency === "USD" ? (await loadUsdRateInfo()).rate : null;
        await queuePropertyPriceDropStory(after.id, buildPriceDisplay(before.price, before.currency, money), propertyPriceTjs(before.price, before.currency, usdRate));
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
