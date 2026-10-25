import fs from "node:fs/promises";
import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { loadCredentials } from "../messengers/meta.js";
import { editMessageCaption, isTelegramEnabled } from "../telegram/api.js";
import { metadataCoverPath } from "./publicationMetadataCover.js";
import { updateFacebookVideoDescription, updateYouTubeDescription, setFacebookVideoThumbnail, setYouTubeThumbnail } from "./socialPublish.js";
import { metadataHash, type MetadataPayload, type MetadataResult } from "./publicationMetadataPolicy.js";

/** No scheduler or UI activates this adapter. Caller must own the durable LIVE claim. */
export async function applyPublicationMetadata(channel: string, operation: string, payload: MetadataPayload, target: MetadataPayload["targets"][number]): Promise<MetadataResult> {
  if (process.env.PUBLICATION_METADATA_EXECUTION !== "LIVE") return { status: "FAILED", code: "EXECUTION_DISABLED" };
  let coverPath: string | null = null;
  if (operation === "COVER") {
    coverPath = payload.coverKey ? metadataCoverPath(payload.coverKey) : null;
    if (!coverPath || !payload.coverDigest) return { status: "FAILED", code: "COVER_UNAVAILABLE" };
    try { if (metadataHash(await fs.readFile(coverPath)) !== payload.coverDigest) return { status: "FAILED", code: "COVER_CHANGED" }; }
    catch { return { status: "FAILED", code: "COVER_UNAVAILABLE" }; }
  }
  try {
    if (channel === "FACEBOOK") {
      const creds = await loadCredentials();
      if (!creds.pageToken) return { status: "FAILED", code: "CREDENTIALS_MISSING" };
      const ok = operation === "CAPTION" ? (await updateFacebookVideoDescription(target.postId, creds.pageToken, payload.caption, true)).ok : (await setFacebookVideoThumbnail(target.postId, creds.pageToken, coverPath!, true)) === null;
      return { status: ok ? "APPLIED" : "UNKNOWN", code: ok ? "PROVIDER_ACKNOWLEDGED" : "PROVIDER_OUTCOME_UNCONFIRMED" };
    }
    if (channel === "YOUTUBE") {
      const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { youtubeClientId: true, youtubeClientSecret: true, youtubeRefreshToken: true } });
      const creds = { clientId: settings?.youtubeClientId ?? undefined, clientSecret: decryptSecretSafe(settings?.youtubeClientSecret ?? null) ?? undefined, refreshToken: decryptSecretSafe(settings?.youtubeRefreshToken ?? null) ?? undefined };
      if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) return { status: "FAILED", code: "CREDENTIALS_MISSING" };
      const ok = operation === "CAPTION" ? (await updateYouTubeDescription(creds, target.postId, payload.caption, payload.caption, true)).ok : (await setYouTubeThumbnail(creds, target.postId, coverPath!, true)) === null;
      return { status: ok ? "APPLIED" : "UNKNOWN", code: ok ? "PROVIDER_ACKNOWLEDGED" : "PROVIDER_OUTCOME_UNCONFIRMED" };
    }
    if (channel === "TELEGRAM" && operation === "CAPTION") {
      if (!isTelegramEnabled() || !target.chatId || !/^\d+$/.test(target.postId) || !Number.isSafeInteger(Number(target.postId))) return { status: "FAILED", code: "TARGET_UNAVAILABLE" };
      // Existing adapter truncates at1024; never silently send a different preview.
      if (payload.caption.length > 1024) return { status: "FAILED", code: "CAPTION_TOO_LONG" };
      await editMessageCaption(target.chatId, Number(target.postId), payload.caption, undefined, true);
      return { status: "APPLIED", code: "PROVIDER_ACKNOWLEDGED" };
    }
    return { status: "FAILED", code: "UNSUPPORTED_OPERATION" };
  } catch { return { status: "UNKNOWN", code: "PROVIDER_OUTCOME_UNCONFIRMED" }; }
}
