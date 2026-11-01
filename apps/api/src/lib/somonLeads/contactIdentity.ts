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
/** Ключ автора объявления: тот же ключ HMAC, свой префикс. Сырой ID пользователя
 * Somon не храним — для счёта объявлений автора достаточно сравнения ключей. */
export function somonSellerKey(sellerId: string): string {
  if (!/^\d{1,20}$/.test(sellerId)) throw new Error("Invalid Somon seller ID");
  return createHmac("sha256", key()).update(`somon-seller:v1:${sellerId}`).digest("hex");
}
