import { prisma, type TxClient } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import type { MetaCredentials, MetaChannel } from "../messengers/metaTypes.js";
import { CustomerScopeDenied, resolveCustomerEndpoint, type CustomerTransportReference } from "./customerConversationScope.js";

/** A captured server transport determines both namespace and WA POST resource.
 * Never combine A's token with today's B phone-number ID after an await.
 * Validation is point-in-time, not an atomic transaction with provider POST. */
export async function bindCustomerMetaSendCredentials(credentials: MetaCredentials, channel: MetaChannel, peer: string,
  tokenOverride: string | undefined, transport: CustomerTransportReference,
  db: Pick<TxClient, "messengerAccount" | "$queryRaw" | "$executeRaw"> = prisma): Promise<{ credentials: MetaCredentials; token: string }> {
  const input = { channel, subscriberId: peer, transport };
  const endpoint = await resolveCustomerEndpoint(input, db);
  let token: string | undefined, waPhoneId = credentials.waPhoneId, pageId = credentials.pageId;
  if (endpoint.accountId) {
    const account = await db.messengerAccount.findUnique({ where: { id: endpoint.accountId }, select: { channel: true, token: true, externalId: true, enabled: true } });
    if (!account || account.channel !== channel || !account.enabled) throw new CustomerScopeDenied("account_mismatch");
    token = decryptSecretSafe(account.token) || undefined;
    if (channel === "WHATSAPP") waPhoneId = account.externalId;
    if (channel === "FACEBOOK") pageId = account.externalId;
  } else {
    token = channel === "WHATSAPP" ? credentials.waToken : channel === "FACEBOOK" ? credentials.pageToken : undefined;
    if (channel === "WHATSAPP") waPhoneId = endpoint.accountExternalId;
    if (channel === "FACEBOOK") pageId = endpoint.accountExternalId;
  }
  if (!token || (tokenOverride && tokenOverride !== token) || (channel === "WHATSAPP" && !waPhoneId) ||
      (channel === "FACEBOOK" && !pageId)) throw new CustomerScopeDenied("account_mismatch");
  // Account-token fetch/config loading must not adopt a newer scope revision.
  await resolveCustomerEndpoint(input, db);
  return { credentials: { ...credentials, waPhoneId, pageId }, token };
}
/** Explicit legacy compatibility routing: only one configured provider token
 * namespace may match. It is not inbound provenance, customer identity, private
 * proof, or permission to resume a saved job from another namespace. New core
 * callers must supply their previously captured reference instead. */
export async function resolveLegacyMetaSendTransport(credentials: MetaCredentials, channel: MetaChannel, peer: string,
  tokenOverride: string | undefined, db: Pick<TxClient, "messengerAccount" | "$queryRaw" | "$executeRaw"> = prisma): Promise<CustomerTransportReference> {
  const token = tokenOverride || (channel === "WHATSAPP" ? credentials.waToken : channel === "FACEBOOK" ? credentials.pageToken : credentials.igToken);
  if (!token) throw new CustomerScopeDenied("account_unknown");
  const rows = await db.messengerAccount.findMany({ where: { channel, enabled: true }, select: { id: true, token: true, externalId: true } });
  const matched = rows.filter(row => decryptSecretSafe(row.token) === token);
  const installedId = channel === "WHATSAPP" ? credentials.waPhoneId : channel === "FACEBOOK" ? credentials.pageId : undefined;
  const installedToken = channel === "WHATSAPP" ? credentials.waToken : channel === "FACEBOOK" ? credentials.pageToken : undefined;
  const installed = !!installedId && !!installedToken && installedToken === token;
  if (matched.length > 1 || (matched.length && installed)) throw new CustomerScopeDenied("account_mismatch");
  if (matched.length === 1) return resolveCustomerEndpoint({ channel, subscriberId: peer, accountId: matched[0].id,
    accountExternalId: matched[0].externalId }, db);
  if (installed && installedId) return resolveCustomerEndpoint({ channel, subscriberId: peer, accountExternalId: installedId }, db);
  throw new CustomerScopeDenied("account_unknown");
}
