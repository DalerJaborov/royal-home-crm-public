import { claimSomonRequest, recordSomonResponse } from "./sourceBudgetStore.js";

const INTERVAL_MS = 10000;
export class SomonSourceUnavailable extends Error {
  constructor(public readonly reason: "not_ready" | "http" | "network", public readonly status?: number) { super(`Somon source unavailable: ${reason}`); }
}

function retryDelay(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  if (/^\d+$/.test(header.trim())) return Number(header) * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** All background Somon calls must go through this budgeted entry point. */
export async function fetchSomon(path: string, now = new Date(), request: typeof fetch = fetch): Promise<Response> {
  const permitted = /^\/nedvizhimost\/prodazha-kvartir\/dushanbe\/(?:\?page=\d{1,5})?$/.test(path)
    || /^\/api\/items\/get_phone\/\d{1,20}\/$/.test(path)
    || /^\/api\/v2\/spa\/adverts\/card\/[\w%-]+\/$/.test(path);
  if (!permitted) throw new Error("Invalid Somon source path");
  const token = await claimSomonRequest(now, INTERVAL_MS);
  if (!token) throw new SomonSourceUnavailable("not_ready");
  let response: Response;
  try {
    response = await request(`https://somon.tj${path}`, { headers: { Accept: "application/json, text/html", "User-Agent": "RoyalHomeBot/1.0 (+https://royalhome.tj)" }, signal: AbortSignal.timeout(12000), redirect: "error" });
    if (response.ok) {
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error("Somon response too large"); }
          chunks.push(part.value);
        }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      response = new Response(size ? bytes : null, { status: response.status, headers: response.headers });
    }
  } catch {
    await recordSomonResponse(token, 0, new Date());
    throw new SomonSourceUnavailable("network");
  }
  await recordSomonResponse(token, response.status, new Date(), retryDelay(response.headers.get("retry-after"), Date.now()));
  if (!response.ok) throw new SomonSourceUnavailable("http", response.status);
  return response;
}

