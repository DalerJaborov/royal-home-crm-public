import type { TxClient } from "../db.js";
import type { Property } from "../generated/prisma/client.js";
import { stagePublishedPriceChange, type PriceCaptionStage } from "./publishedListingSync.js";
import { enqueueSiteResyncInTransaction } from "./siteResyncQueue.js";
import { isSiteListedStatus } from "./siteSync.js";

export interface PropertyPriceDelivery {
  caption: PriceCaptionStage;
  siteQueued: boolean;
}

export async function stagePropertyPriceDelivery(
  tx: TxClient,
  before: Property,
  after: Property,
  changedFields: readonly string[],
  context: string,
): Promise<PropertyPriceDelivery> {
  const caption = await stagePublishedPriceChange(tx, before, after, changedFields);
  const siteQueued = after.publishedOnSite && !after.offSite && !after.deletedAt && isSiteListedStatus(after.status);
  if (siteQueued) await enqueueSiteResyncInTransaction(tx, after.id, context);
  return { caption, siteQueued };
}
