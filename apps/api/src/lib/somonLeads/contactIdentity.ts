import { createHmac } from "node:crypto";
import { normalizeSomonPhone } from "./card.js";

/** Never persist the number itself. A missing/invalid key fails closed. */
function key(): Buffer {
  const key = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!key || !/^[0-9a-f]{64}$/i.test(key)) throw new Error("Somon contact matching is unavailable");
  return Buffer.from(key, "hex");
}
export function somonKeyFingerprint(): string {
  return createHmac("sha256", key()).update("somon-contact-key-check:v1").digest("hex");
}
export function somonPhoneHash(phone: string): string {
  const normalized = normalizeSomonPhone(phone);
  if (!normalized) throw new Error("Somon contact matching is unavailable");
  return createHmac("sha256", key()).update(`somon-contact:v1:${normalized}`).digest("hex");
}
