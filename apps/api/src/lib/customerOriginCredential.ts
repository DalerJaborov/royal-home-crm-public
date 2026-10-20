import { createHash } from "node:crypto";
import { z } from "zod";

/** A persisted verifier version, not the secret and not an identity grant. */
export const customerVerifierCredentialSchema = z.object({
  source: z.enum(["account_app_secret", "settings_meta_app_secret", "settings_meta_ig_app_secret"]),
  sourceId: z.string().min(1).max(128), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type CustomerVerifierCredential = z.infer<typeof customerVerifierCredentialSchema>;

/** Call only with the exact DB value AND the exact key used for verification.
 * No env-only fallback may acquire a restart witness. Re-encryption intentionally
 * changes this fingerprint; monotonic namespace/policy revs also fence ABA. */
export function customerDbVerifierCredential(source: CustomerVerifierCredential["source"], sourceId: string,
  persistedValue: string | null | undefined, verifiedSecret: string | null | undefined): CustomerVerifierCredential | null {
  if (!persistedValue || !verifiedSecret) return null;
  return customerVerifierCredentialSchema.parse({ source, sourceId,
    fingerprint: createHash("sha256").update(JSON.stringify(["customer-verifier-v1", source, sourceId, persistedValue, verifiedSecret])).digest("hex") });
}
