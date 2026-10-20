import { decryptSecretSafe } from "../crypto.js";
import type { TxClient } from "../db.js";
import { customerDbVerifierCredential, type CustomerVerifierCredential } from "./customerOriginCredential.js";

export interface InstalledCustomerTransport {
  channel: "FACEBOOK" | "WHATSAPP";
  externalId: string;
  transportKey: string;
  signingSecret: string | null;
  endpointScopeId: string | null;
  scopeRevision: string | null;
  policyRevision: string | null;
  signingCredential?: CustomerVerifierCredential | null;
}
/** Server configuration only. The resource ID and signing key/revisions share
 * one statement snapshot; no provider lookup, guessed peer or default account.
 * Signing material stays inside the verifier and never enters a scope/ref/log. */
export async function readInstalledCustomerTransport(db: Pick<TxClient, "$queryRaw">,
  channel: string, requestedExternalId?: string): Promise<InstalledCustomerTransport | null> {
  if ((channel !== "FACEBOOK" && channel !== "WHATSAPP") || !requestedExternalId) return null;
  const rows = await db.$queryRaw<Array<{ externalId: string | null; token: string | null; appSecret: string | null;
    endpointScopeId: string | null; scopeRevision: bigint | null; policyRevision: bigint | null }>>`
    SELECT CASE WHEN ${channel}='FACEBOOK' THEN st."metaPageId" ELSE st."metaWaPhoneId" END AS "externalId",
      CASE WHEN ${channel}='FACEBOOK' THEN st."metaPageToken" ELSE st."metaWaToken" END AS "token",
      st."metaAppSecret" AS "appSecret", s."id" AS "endpointScopeId", s."scopeRevision", p."policyRevision"
    FROM "Settings" st LEFT JOIN "CustomerEndpointScope" s ON s."realmKey"='royal-home'
      AND s."channel"=${channel} AND s."transportKey"=${`settings:${channel}:${requestedExternalId}`}
      AND s."kind"='NORMAL' AND s."messengerAccountId" IS NULL
    LEFT JOIN "CustomerRuntimePolicy" p ON p."id"='singleton' WHERE st."id"='singleton'`;
  if (rows.length !== 1) return null;
  const row = rows[0];
  const externalId = row.externalId || (channel === "FACEBOOK" ? process.env.META_PAGE_ID : process.env.META_WA_PHONE_ID);
  const token = decryptSecretSafe(row.token) || (channel === "FACEBOOK" ? process.env.META_PAGE_TOKEN : process.env.META_WA_TOKEN);
  if (externalId !== requestedExternalId || !token) return null;
  const persistedSigningSecret = decryptSecretSafe(row.appSecret);
  return { channel, externalId, transportKey: `settings:${channel}:${externalId}`,
    signingSecret: persistedSigningSecret || process.env.META_APP_SECRET || null,
    signingCredential: customerDbVerifierCredential("settings_meta_app_secret", "singleton", row.appSecret, persistedSigningSecret),
    endpointScopeId: row.endpointScopeId, scopeRevision: row.scopeRevision?.toString() ?? null,
    policyRevision: row.policyRevision?.toString() ?? null };
}
