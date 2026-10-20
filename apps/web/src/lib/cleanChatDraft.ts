export const CLEAN_CHAT_DRAFT_KEY = "rh:clean-chat-drafts:v1";
export const CLEAN_CHAT_DRAFT_TTL = 24 * 60 * 60 * 1000;
export const CLEAN_CHAT_DRAFT_LIMIT = 40;
export const CLEAN_CHAT_DRAFT_MAX_LENGTH = 10000;
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Draft = { actorId: string; conversationId: string; text: string; updatedAt: number };
export function chatDraftStorage(): StorageLike | undefined {
  try { return typeof window === "undefined" ? undefined : window.sessionStorage; } catch { return undefined; }
}
function entries(storage: StorageLike | undefined, now: number): Draft[] {
  try {
    const data: unknown = JSON.parse(storage?.getItem(CLEAN_CHAT_DRAFT_KEY) ?? "[]");
    if (!Array.isArray(data)) return [];
    return data.filter((d): d is Draft => !!d && typeof d.actorId === "string" && typeof d.conversationId === "string" && typeof d.text === "string" && d.text.length > 0 && d.text.length <= CLEAN_CHAT_DRAFT_MAX_LENGTH && typeof d.updatedAt === "number" && d.updatedAt <= now && now - d.updatedAt < CLEAN_CHAT_DRAFT_TTL).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, CLEAN_CHAT_DRAFT_LIMIT);
  } catch { return []; }
}
function commit(storage: StorageLike | undefined, drafts: Draft[]) {
  try { if (drafts.length) storage?.setItem(CLEAN_CHAT_DRAFT_KEY, JSON.stringify(drafts)); else storage?.removeItem(CLEAN_CHAT_DRAFT_KEY); } catch (cause) { console.warn("Не удалось сохранить черновик переписки", cause); }
}
export function readCleanChatDraft(actorId: string, conversationId: string, storage = chatDraftStorage(), now = Date.now()): string | null {
  const drafts = entries(storage, now);
  commit(storage, drafts);
  return drafts.find((d) => d.actorId === actorId && d.conversationId === conversationId)?.text ?? null;
}
export function writeCleanChatDraft(actorId: string, conversationId: string, text: string, storage = chatDraftStorage(), now = Date.now()) {
  const drafts = entries(storage, now).filter((d) => d.actorId !== actorId || d.conversationId !== conversationId);
  // Never restore a silently truncated message. Oversized text remains in the composer only.
  if (text.length > 0 && text.length <= CLEAN_CHAT_DRAFT_MAX_LENGTH) drafts.unshift({ actorId, conversationId, text, updatedAt: now });
  commit(storage, drafts.slice(0, CLEAN_CHAT_DRAFT_LIMIT));
}
export function clearCleanChatDrafts(actorId: string, storage = chatDraftStorage()) {
  commit(storage, entries(storage, Date.now()).filter((d) => d.actorId !== actorId));
}
/** Suppress the initial empty render while restore's state update is being applied. */
export function draftWriteAfterRestore(text: string, pending: string | null): { write: boolean; pending: string | null } {
  return pending !== null && text === "" ? { write: false, pending } : { write: true, pending: null };
}
