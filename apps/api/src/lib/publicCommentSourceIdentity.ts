import { createHash } from "node:crypto";
import type { PublicInstallation, ServerPublicCommentSnapshot } from "@royal-home/shared";
export function samePublicInstallation(a: PublicInstallation, b: PublicInstallation): boolean {
  return a.id === b.id && a.revision === b.revision && a.channel === b.channel && a.accountId === b.accountId &&
    a.resourceId === b.resourceId && a.transportKey === b.transportKey;
}
export function publicCommentSourceDigest(row: Pick<ServerPublicCommentSnapshot, "source" | "target" | "text">): string {
  return createHash("sha256").update(JSON.stringify([row.source.table, row.source.id, row.target.channel, row.target.accountExternalId,
    row.target.publicationId, row.target.commentId, row.target.parentId, row.target.threadId, row.target.threadKind, row.text])).digest("hex");
}
