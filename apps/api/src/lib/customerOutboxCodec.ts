import { createHash } from "node:crypto";
import { customerAgentStoredTextPayloadSchema } from "@royal-home/shared";
import { decryptSecret } from "../crypto.js";
import { customerDeliveryPayloadSchema, type CustomerDeliveryPayload, type CustomerOutboxRow } from "./customerDeliveryContracts.js";

/** Data-only codec. No planner, principal, delivery witness or authority issuer.
 * Readers must separately prove scope, source and actual provider acceptance. */
export function decodeCustomerAgentStoredTextPayload(raw: unknown) {
  const parsed = customerAgentStoredTextPayloadSchema.parse(raw);
  return { payload: { kind: "text" as const, text: parsed.text }, publicData: parsed.publicData ?? null };
}
type EncryptedPayloadRow = Pick<CustomerOutboxRow, "payloadVersion" | "payloadEncrypted" | "payloadHash">;
function readStoredPayload(row: EncryptedPayloadRow): unknown {
  if (row.payloadVersion !== 1) throw new Error("Unsupported delivery payload");
  const plaintext = decryptSecret(row.payloadEncrypted);
  if (createHash("sha256").update(plaintext).digest("hex") !== row.payloadHash) throw new Error("Delivery payload integrity mismatch");
  return JSON.parse(plaintext);
}
export function decodeCustomerOutboxPayload(row: EncryptedPayloadRow): CustomerDeliveryPayload {
  const raw = readStoredPayload(row);
  return raw && typeof raw === "object" && "kind" in raw && raw.kind === "text"
    ? decodeCustomerAgentStoredTextPayload(raw).payload : customerDeliveryPayloadSchema.parse(raw);
}
export function decodeCustomerOutboxPublicData(row: EncryptedPayloadRow) {
  const raw = readStoredPayload(row);
  if (raw && typeof raw === "object" && "kind" in raw && raw.kind === "text") return decodeCustomerAgentStoredTextPayload(raw).publicData;
  customerDeliveryPayloadSchema.parse(raw);
  return null;
}
