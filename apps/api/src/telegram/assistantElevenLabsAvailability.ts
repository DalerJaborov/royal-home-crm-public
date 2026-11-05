import { createHash } from "node:crypto";
import { z } from "zod";

type Operation = "recognition" | "synthesis";
type Pause = { account: string; until: number };
const quotaError = z.object({ detail: z.object({ status: z.string() }) });
const pauses: Partial<Record<Operation | "quota", Pause>> = {};

const accountOf = (key: string) => createHash("sha256").update(key).digest("hex");

export function assistantElevenLabsPaused(key: string, operation: Operation): boolean {
  const account = accountOf(key);
  const now = Date.now();
  return [pauses.quota, pauses[operation]].some(pause => pause?.account === account && pause.until > now);
}

/** Account quota affects both operations; an endpoint-specific rate limit does not. */
export async function noteAssistantElevenLabsFailure(key: string, operation: Operation, response: Response): Promise<void> {
  const account = accountOf(key);
  const now = Date.now();
  if (response.status === 429) pauses[operation] = { account, until: now + 15_000 };
  if (response.status === 402) pauses.quota = { account, until: now + 5 * 60_000 };
  if ([400, 401, 403].includes(response.status)) {
    const error = quotaError.safeParse(await response.json().catch(() => null));
    if (error.success && error.data.detail.status === "quota_exceeded") {
      pauses.quota = { account, until: now + 5 * 60_000 };
    } else if (response.status === 401 || response.status === 403) {
      pauses[operation] = { account, until: now + 60_000 };
    }
  } else {
    await response.body?.cancel().catch(() => undefined);
  }
}
