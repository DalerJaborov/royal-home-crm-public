import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db.js";
import { videoHandoffDir } from "../upload.js";
import { localVideoDelete } from "./localVideoStorage.js";
import { logSystemError } from "./systemError.js";
import { publishedSourceCutoff } from "./publishedRawVideoRetention.js";
export { PROPERTY_VIDEO_RETENTION_DAYS } from "./publishedRawVideoRetention.js";

const MAX_PROPERTIES_PER_RUN = 50;

export interface PropertyVideoCleanupResult {
  properties: number;
  videosDeleted: number;
  failed: number;
}

/** Raw sources only, seven full days after a successful publication receipt.
 * Editing, unpublished, trashed, reviewed/replaced and actively used files stay.
 * Old objects without an exact receipt stay too; stage age is not publication age.
 */
export async function cleanupStalePropertyVideos(): Promise<PropertyVideoCleanupResult> {
  const result: PropertyVideoCleanupResult = { properties: 0, videosDeleted: 0, failed: 0 };
  const now = new Date();
  const candidates = await prisma.property.findMany({
    where: { deletedAt: null, status: { in: ["AVAILABLE", "RESERVED", "SOLD", "WITHDRAWN"] },
      publishedChannels: { isEmpty: false }, videos: { some: {} } },
    orderBy: { id: "asc" },
  });
  for (const candidate of candidates) {
    if (!publishedSourceCutoff(candidate, now)) continue;
    if (result.properties >= MAX_PROPERTIES_PER_RUN) break;
    try {
      // Serialize with normal Property updates (return to editor, trash, new final).
      const deleted = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${candidate.id} FOR UPDATE`;
        const property = await tx.property.findUnique({ where: { id: candidate.id }, include: { videos: true } });
        const publishedAt = property && publishedSourceCutoff(property, now);
        if (!property || !publishedAt) return 0;
        if (await tx.videoUploadSession.count({ where: { propertyId: property.id } })) return 0;
        if (await tx.backgroundJob.count({ where: { status: { in: ["PENDING", "RUNNING"] },
          payload: { path: ["propertyId"], equals: property.id } } })) return 0;
        // Keep the finished video and require it to exist before removing sources.
        await fs.access(path.join(videoHandoffDir, path.basename(property.videoHandoffFinalPath!)));
        let count = 0;
        for (const video of property.videos) {
          // A source added after this publication belongs to a later editing round.
          if (video.uploadedAt > publishedAt) continue;
          if (await tx.propertyDraftMedia.count({ where: { storageKey: video.storageKey } })) continue;
          if (!await localVideoDelete(video.storageKey)) { result.failed++; continue; }
          await tx.propertyVideo.delete({ where: { id: video.id } });
          if (property.videoHandoffVideoId === video.id) {
            await tx.property.update({ where: { id: property.id }, data: { videoHandoffVideoId: null } });
          }
          await tx.auditLog.create({ data: { action: "PROPERTY_VIDEO_CLEANUP", entityType: "Property",
            entityId: property.id, agentId: null, agentName: "Система",
            meta: { shortId: property.shortId, videoId: video.id, reason: "published-source-retention-7d",
              publishedAt: publishedAt.toISOString(), retentionDays: 7 } } });
          count++;
        }
        return count;
      }, { timeout: 30_000 });
      if (deleted) { result.properties++; result.videosDeleted += deleted; }
    } catch (err) {
      result.failed++;
      void logSystemError("storage", `Уборка исходников объекта ${candidate.shortId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
