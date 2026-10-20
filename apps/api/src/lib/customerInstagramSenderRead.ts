import { createHash } from "node:crypto";
import { z } from "zod";
import type { TxClient } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { GRAPH_VERSION, instagramApiUrl, instagramRequest } from "../messengers/metaGraph.js";

/** Exact DB token, never env/global default, another account or a profile cache. */
export async function readRecoveryInstagramCredential(db: Pick<TxClient, "$queryRaw">, accountId: string, externalId: string) {
  const rows = await db.$queryRaw<Array<{ token: string; enabled: boolean }>>`SELECT "token","enabled" FROM "MessengerAccount"
    WHERE "id"=${accountId} AND "channel"='INSTAGRAM' AND ("externalId"=${externalId} OR "messagingId"=${externalId} OR ${externalId}=ANY("extraExternalIds"))`;
  const row = rows.length === 1 ? rows[0] : null;
  const token = row?.enabled ? decryptSecretSafe(row.token) : null;
  if (!row || !token) return null;
  return { token, fingerprint: createHash("sha256").update(JSON.stringify(["customer-sender-token-v1", accountId, row.token, token])).digest("hex") };
}

/** Existing exact Instagram username GET, with existing proxy/auth shaping.
 * One bounded read, no cache/retry/fallback, no model/paid inference and no log
 * containing a URL/token/name. A failure never means "not our account". */
export async function readRecoveryInstagramUsername(peer: string, token: string, originalReceivedAt: number): Promise<string | null> {
  if (!peer || peer.length > 512 || !token || !Number.isSafeInteger(originalReceivedAt)) return null;
  const remaining = originalReceivedAt + 15 * 60_000 - Date.now();
  if (remaining <= 0 || Date.now() < originalReceivedAt) return null;
  const request = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/${encodeURIComponent(peer)}?fields=username`), token);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, Math.min(2500, remaining)); });
  const read = async (): Promise<string | null> => {
    try {
      const response = await fetch(request.url, { method: "GET", headers: request.headers, signal: controller.signal, redirect: "error" });
      if (!response.ok || controller.signal.aborted) return null;
      if (Number(response.headers.get("content-length") ?? 0) > 16_384 || !response.body) return null;
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 16_384 || controller.signal.aborted) {
          controller.abort(); void reader.cancel().catch(() => {}); return null;
        }
        chunks.push(item.value);
      }
      if (Date.now() >= originalReceivedAt + 15 * 60_000 || controller.signal.aborted) return null;
      const text = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8");
      const parsed = z.object({ id: z.string().optional(), username: z.string().regex(/^[A-Za-z0-9._]{1,30}$/) }).strip().safeParse(JSON.parse(text));
      if (!parsed.success || parsed.data.id !== undefined && parsed.data.id !== peer) return null;
      return parsed.data.username;
    } catch { return null; }
  };
  // Even a faulty/custom fetch that ignores AbortSignal cannot hang the worker.
  // A late GET result is consumed, never accepted after the original deadline.
  try { return await Promise.race([read(), timeout]); }
  finally { clearTimeout(timer!); }
}
