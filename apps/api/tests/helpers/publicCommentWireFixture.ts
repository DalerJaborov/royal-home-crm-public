import { vi } from "vitest";
import { sendRecordedPublicReply, type PublicReplyReceipt, type PublicReplyStore, type PublicReplyTarget } from "../../src/messengers/publicCommentReply.js";
/** Wire fixture only. It supplies no customer principal/private/write rights. */
export function publicCommentWireFixture(target: PublicReplyTarget) {
  const state = { current: true, receipt: null as PublicReplyReceipt | null };
  const store: PublicReplyStore = {
    claim: vi.fn(async (_revision, attemptKey, _target, targetHash) => ({ attemptKey, targetHash, sourceRevision: 1n })),
    isCurrent: vi.fn(async () => state.current),
    complete: vi.fn(async (_lease, receipt) => { state.receipt = receipt; return state.current; }),
  };
  return { state, store, run: (send: (beforePost: () => Promise<void>) => Promise<unknown>) => sendRecordedPublicReply({
    target, provider: target.channel, expectedSourceRevision: 1n, text: "Synthetic wire reply", store, send,
  }) };
}
