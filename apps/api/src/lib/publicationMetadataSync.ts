import fs from "node:fs/promises";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { metadataCoverPath } from "./publicationMetadataCover.js";
import { metadataHash, metadataPayloadSchema, planPublicationMetadata, performMetadataTargets } from "./publicationMetadataPolicy.js";
import { applyPublicationMetadata } from "./publicationMetadataAdapter.js";

async function snapshot(propertyId: string) {
  const [property, settings] = await Promise.all([
    prisma.property.findUnique({ where: { id: propertyId } }),
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { telegramChannelId: true } }),
  ]);
  if (!property || property.deletedAt) return null;
  const key = property.socialCoverSquareUrl;
  const file = key ? metadataCoverPath(key) : null;
  let coverDigest: string | null = null;
  if (file) { try { coverDigest = metadataHash(await fs.readFile(file)); } catch { /* Unavailable local cover becomes manual, never fetched externally. */ } }
  const input = { caption: property.reelsCaption ?? "", coverKey: key, coverDigest, channels: property.publishedChannels, postIds: property.publishedPostIds, telegramChatId: settings?.telegramChannelId ?? null };
  return { updatedAt: property.updatedAt, hash: metadataHash({ ...input, price: String(property.price), currency: property.currency }), plans: planPublicationMetadata(input) };
}
/** Default previews cannot be drained when a future runtime enables LIVE. */
export async function preparePublicationMetadataPreview(propertyId: string, executionMode: "PREVIEW" | "LIVE" = "PREVIEW") {
  if (executionMode === "LIVE" && process.env.PUBLICATION_METADATA_EXECUTION !== "LIVE") throw new Error("Publication execution disabled");
  const current = await snapshot(propertyId);
  if (!current) return [];
  const revisionHash = metadataHash({ contentHash: current.hash, executionMode });
  const rows = [];
  for (const plan of current.plans) {
    rows.push(await prisma.publicationMetadataSync.upsert({
      where: { propertyId_revisionHash_channel_operation: { propertyId, revisionHash, channel: plan.channel, operation: plan.operation } },
      create: { propertyId, revisionHash, ...plan, payload: plan.payload as Prisma.InputJsonValue, executionMode }, update: {},
    }));
  }
  return rows;
}
/** Internal entrypoint only: no API route, cron registration, activation setting or automatic retries. */
export async function executePublicationMetadataSync(id: string, attemptedById: string, deps?: { adapter: typeof applyPublicationMetadata; allowLive: boolean }) {
  if (process.env.PUBLICATION_METADATA_EXECUTION !== "LIVE" || !deps?.allowLive) return { status: "DISABLED" };
  const row = await prisma.publicationMetadataSync.findUnique({ where: { id } });
  if (!row || row.executionMode !== "LIVE" || row.status !== "PREVIEW") return { status: "NOT_CLAIMABLE" };
  const actor = await prisma.agent.findFirst({ where: { id: attemptedById, isActive: true, role: { in: ["ADMIN", "DIRECTOR"] } }, select: { id: true } });
  if (!actor) return { status: "FORBIDDEN" };
  const parsed = metadataPayloadSchema.safeParse(row.payload);
  const current = await snapshot(row.propertyId);
  const revisionHash = current ? metadataHash({ contentHash: current.hash, executionMode: row.executionMode }) : null;
  if (!parsed.success || !current || revisionHash !== row.revisionHash) return { status: "STALE_PREVIEW" };
  // The compare-and-swap closes concurrent execution; abandoned EXECUTING is intentionally not reclaimable.
  const startedAt = new Date();
  const claimed = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${row.propertyId} FOR UPDATE`;
    const latest = await tx.property.findUnique({ where: { id: row.propertyId }, select: { updatedAt: true, deletedAt: true } });
    if (!latest || latest.deletedAt || latest.updatedAt.getTime() !== current.updatedAt.getTime()) return false;
    const unresolved = await tx.publicationMetadataSync.findFirst({ where: { propertyId: row.propertyId, channel: row.channel, operation: row.operation, status: { in: ["EXECUTING", "UNKNOWN"] } }, select: { id: true } });
    if (unresolved) return false;
    const claim = await tx.publicationMetadataSync.updateMany({ where: { id, status: "PREVIEW", executionMode: "LIVE", revisionHash: row.revisionHash }, data: { status: "EXECUTING", startedAt, attemptedById } });
    return claim.count === 1;
  });
  if (!claimed) return { status: "NOT_CLAIMABLE" };
  const result = await performMetadataTargets({ channel: row.channel, operation: row.operation, payload: parsed.data }, deps.adapter);
  const recorded = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "PublicationMetadataSync" WHERE id = ${id} FOR UPDATE`;
    const current = await tx.publicationMetadataSync.findUnique({ where: { id } });
    if (!current?.startedAt || current.startedAt.getTime() !== startedAt.getTime()) throw new Error("Publication attempt fence changed; do not retry");
    if (current.status === "EXECUTING") {
      const changed = await tx.publicationMetadataSync.updateMany({ where: { id, status: "EXECUTING", startedAt }, data: { status: result.status, finishedAt: new Date(), result: result as Prisma.InputJsonValue, reason: result.status === "APPLIED" ? "Площадка подтвердила запрос. Независимая проверка отображения не выполнена." : "Автоповтор запрещён; необходима проверка результата на площадке." } });
      if (changed.count !== 1) throw new Error("Publication acknowledgement not recorded; do not retry");
      return result;
    }
    if (["APPLIED_MANUAL", "FAILED_MANUAL"].includes(current.status)) {
      const prior = current.result && typeof current.result === "object" && !Array.isArray(current.result) ? current.result as Record<string, Prisma.InputJsonValue> : {};
      await tx.publicationMetadataSync.updateMany({ where: { id, status: current.status, startedAt }, data: { result: { ...prior, lateProviderEvidence: result as Prisma.InputJsonValue, lateProviderObservedAt: new Date().toISOString() } } });
      return { status: current.status, lateProviderEvidence: result };
    }
    throw new Error("Publication result already settled; do not retry");
  });
  return recorded;
}
