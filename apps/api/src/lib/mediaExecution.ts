import { createHmac } from "node:crypto";

/** Deployment-only gates. Persisted PREVIEW work is never promoted by changing these. */
export function mediaExecutionMode(kind: "NARRATION" | "OWNER_REPORT"): "LIVE" | "PREVIEW" {
  return process.env[`CRM_${kind}_EXECUTION_MODE`] === "LIVE" ? "LIVE" : "PREVIEW";
}
export function mediaRecipientHash(context: string, recipient: string): string {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error("JWT_ACCESS_SECRET is required");
  return createHmac("sha256", secret).update(JSON.stringify(["media-recipient-v1", context, recipient])).digest("hex");
}
export function ownerReportPeriod(now = new Date()): string {
  return new Date(now.getTime() + 5 * 3600_000).toISOString().slice(0, 7);
}
