import { createHash } from "node:crypto";
import { z } from "zod";
import { customerAgentStoredTextPayloadSchema } from "@royal-home/shared";
import { decryptSecret } from "../crypto.js";
import { customerDeliveryPayloadSchema, type CustomerDecodedDeliveryPayload, type CustomerOutboxRow } from "./customerDeliveryContracts.js";

/** Data-only codec. No planner, principal, delivery witness or authority issuer.
 * Readers must separately prove scope, source and actual provider acceptance. */
export function decodeCustomerAgentStoredTextPayload(raw: unknown) {
  const parsed = customerAgentStoredTextPayloadSchema.parse(raw);
  return { payload: { kind: "text" as const, text: parsed.text }, publicData: parsed.publicData ?? null };
}
type EncryptedPayloadRow = Pick<CustomerOutboxRow, "payloadVersion" | "payloadEncrypted" | "payloadHash">;
function readStoredPayload(row: EncryptedPayloadRow): unknown {
  if (row.payloadVersion !== 1 && row.payloadVersion !== 2) throw new Error("Unsupported delivery payload");
  const plaintext = decryptSecret(row.payloadEncrypted);
  if (createHash("sha256").update(plaintext).digest("hex") !== row.payloadHash) throw new Error("Delivery payload integrity mismatch");
  const parsed: unknown = JSON.parse(plaintext);
  if (row.payloadVersion === 2) {
    const text = decodeCustomerAgentStoredTextPayload(parsed);
    if (text.publicData?.guideFollow?.kind !== "buyer_guide_follow" || text.publicData.guideFollow.version !== 1) {
      throw new Error("Unsupported delivery payload");
    }
  }
  return parsed;
}
export function decodeCustomerOutboxPayload(row: EncryptedPayloadRow): CustomerDecodedDeliveryPayload {
  const raw = readStoredPayload(row);
  if (raw && typeof raw === "object" && "kind" in raw) {
    if (raw.kind === "text") return decodeCustomerAgentStoredTextPayload(raw).payload;
    // Historical payloads are retained for read/reconciliation only. A legacy
    // shape deliberately receives a different discriminant so no current
    // adapter can mistake its URL for a server-issued media witness.
    if (raw.kind === "image" && !Object.hasOwn(raw, "mediaWitness")) {
      const legacy = z.object({ kind: z.literal("image"), url: z.string().url().max(4096) }).strict().parse(raw);
      return { kind: "legacy_image", url: legacy.url };
    }
    if (raw.kind === "audio" && !Object.hasOwn(raw, "mediaWitness")) {
      const legacy = z.object({ kind: z.literal("audio"), url: z.string().url().max(4096) }).strict().parse(raw);
      return { kind: "legacy_audio", url: legacy.url };
    }
    if (raw.kind === "file" && !Object.hasOwn(raw, "mediaWitness")) {
      const legacy = z.object({ kind: z.literal("file"), url: z.string().url().max(4096), name: z.string().min(1).max(200) }).strict().parse(raw);
      return { kind: "legacy_file", url: legacy.url, name: legacy.name };
    }
  }
  return customerDeliveryPayloadSchema.parse(raw);
}
export function decodeCustomerOutboxPublicData(row: EncryptedPayloadRow) {
  const raw = readStoredPayload(row);
  if (raw && typeof raw === "object" && "kind" in raw && raw.kind === "text") return decodeCustomerAgentStoredTextPayload(raw).publicData;
  const decoded = decodeCustomerOutboxPayload(row);
  if (decoded.kind === "legacy_image" || decoded.kind === "legacy_audio" || decoded.kind === "legacy_file") return null;
  customerDeliveryPayloadSchema.parse(raw);
  return null;
}
