import { prisma } from "../db.js";
import { createMetaPublicCapture } from "./metaPublicCommentCapture.js";
import { legacyCompatibleMetaPublicCapturePort as defaultMetaPublicCapturePort } from "./customerPublicCommentStore.js";
import { ingestManagedMetaPublicComments, parseIncomingComments } from "../messengers/comments.js";
import type { PublicSourceRef } from "@royal-home/shared";
const captureMetaPublic = createMetaPublicCapture(defaultMetaPublicCapturePort);
export type PublicCommentIntakeResult = { status: "bypassed" | "not_applicable" }
  | { status: "persisted"; sources: readonly PublicSourceRef[] }
  | { status: "held"; reason: string };
/** OFF/compat preserves legacy ingress; scoped lane never falls into post-ACK legacy processing.
 * Root HTTP adapter awaits this bounded producer BEFORE ACK; no model/provider call here. */
export async function persistVerifiedMetaPublicCommentBatch(request: object & { rawBody?: Buffer; aborted?: boolean; get(name: string): string | undefined }): Promise<PublicCommentIntakeResult> {
  let invalidBody = false;
  if (request.rawBody) {
    try {
      const parsed: unknown = JSON.parse(request.rawBody.toString("utf8"));
      // Pure classification only: ordinary DM/status bodies need no public DB read.
      if (parseIncomingComments(parsed).length === 0) return { status: "not_applicable" };
    } catch { invalidBody = true; }
  }
  const [policy] = await prisma.$queryRaw<Array<{ contractVersion: string; rolloutMode: string }>>`
    SELECT "contractVersion","rolloutMode" FROM "CustomerRuntimePolicy" WHERE "id"='singleton'`;
  if (!policy) return { status: "held", reason: "public_policy_missing" };
  // Verified LEGACY subjects are captured before OFF/compat async ingress too.
  if (!request.rawBody) return { status: "held", reason: "public_raw_body_missing" };
  if (invalidBody) return { status: "held", reason: "public_body_invalid" };
  const capture = await captureMetaPublic(request);
  if (capture.status === "held") return capture;
  const committed = await ingestManagedMetaPublicComments(capture.value);
  return committed.status === "held" ? committed : { status: "persisted", sources: committed.value };
}
