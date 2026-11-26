import { createHash } from "node:crypto";
import { z } from "zod";

type Operation = "recognition" | "synthesis";
type Pause = { account: string; until: number };
const errorDetail = z.object({ detail: z.object({ status: z.string() }) });
const pauses: Partial<Record<Operation | "quota", Pause>> = {};
/** Словари произношения, которые аккаунт ключа отверг (аккаунт:словарь:версия). Живёт до перезапуска процесса. */
const rejectedDictionaries = new Set<string>();

const accountOf = (key: string) => createHash("sha256").update(key).digest("hex");
const dictionaryOf = (key: string, dictionaryId: string, versionId: string) => `${accountOf(key)}:${dictionaryId}:${versionId}`;

export function assistantElevenLabsPaused(key: string, operation: Operation): boolean {
  const account = accountOf(key);
  const now = Date.now();
  return [pauses.quota, pauses[operation]].some(pause => pause?.account === account && pause.until > now);
}

/**
 * Account quota affects both operations; an endpoint-specific rate limit does not.
 * Возвращает машинный код ElevenLabs (`detail.status`, например `quota_exceeded`) — без текста ответа:
 * сообщение может повторять присланное. Код идёт в журнал, чтобы отказ был виден (26.11.2026: двенадцать
 * дней каждый синтез падал, а журнал говорил только «этап synthesis»).
 */
export async function noteAssistantElevenLabsFailure(key: string, operation: Operation, response: Response): Promise<string | null> {
  const account = accountOf(key);
  const now = Date.now();
  let code: string | null = null;
  if (response.status >= 400 && response.status < 500 && response.status !== 429) {
    let body: unknown = null;
    try { body = await response.json(); } catch { body = null; }
    const parsed = errorDetail.safeParse(body);
    if (parsed.success && /^[a-z0-9_]{1,64}$/u.test(parsed.data.detail.status)) code = parsed.data.detail.status;
  } else {
    try { await response.body?.cancel(); } catch { /* тело не нужно */ }
  }
  if (response.status === 429) pauses[operation] = { account, until: now + 15_000 };
  if (response.status === 402 || code === "quota_exceeded") pauses.quota = { account, until: now + 5 * 60_000 };
  else if (response.status === 401 || response.status === 403) pauses[operation] = { account, until: now + 60_000 };
  return code;
}

export function assistantDictionaryRejected(key: string, dictionaryId: string, versionId: string): boolean {
  return rejectedDictionaries.has(dictionaryOf(key, dictionaryId, versionId));
}

/** Синтез без словаря прошёл, со словарём — нет: словарь чужого аккаунта или удалён. Дальше этот ключ шлём без него. */
export function noteAssistantDictionaryRejected(key: string, dictionaryId: string, versionId: string): void {
  rejectedDictionaries.add(dictionaryOf(key, dictionaryId, versionId));
}
