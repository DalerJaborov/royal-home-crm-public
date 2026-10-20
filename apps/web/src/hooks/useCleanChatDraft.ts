import { useEffect, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { useAuthStore } from "../store/auth";
import { clearCleanChatDrafts, draftWriteAfterRestore, readCleanChatDraft, writeCleanChatDraft } from "../lib/cleanChatDraft";

// Remains subscribed after the conversation unmounts so logout also clears dormant drafts.
let watchingSession = false;
function watchSession() {
  if (watchingSession) return;
  watchingSession = true;
  useAuthStore.subscribe((state, previous) => {
    if (previous.agent?.id && (state.sessionEpoch !== previous.sessionEpoch || state.agent?.id !== previous.agent.id)) clearCleanChatDrafts(previous.agent.id);
  });
}

/** Opt-in desktop draft. Caller must key its composer by conversationId (as Messages does). */
export function useCleanChatDraft({ enabled, conversationId, text, restore }: {
  enabled: boolean;
  conversationId: string;
  text: string;
  restore: Dispatch<SetStateAction<string>>;
}): void {
  const actorId = useAuthStore((state) => state.agent?.id);
  const epoch = useAuthStore((state) => state.sessionEpoch);
  const binding = useRef<{ actorId: string; conversationId: string; epoch: number; pending: string | null } | null>(null);
  const owner = useRef<{ actorId: string; epoch: number } | null>(null);
  const latestText = useRef(text);
  latestText.current = text;
  const setter = useRef(restore);
  setter.current = restore;
  useLayoutEffect(() => {
    watchSession();
    if (!enabled || !actorId) { binding.current = null; return; }
    const current = useAuthStore.getState();
    if (current.agent?.id !== actorId || current.sessionEpoch !== epoch) return;
    if (owner.current && (owner.current.actorId !== actorId || owner.current.epoch !== epoch)) { binding.current = null; return; }
    owner.current ??= { actorId, epoch };
    const draft = latestText.current ? null : readCleanChatDraft(actorId, conversationId);
    binding.current = { actorId, conversationId, epoch, pending: draft };
    if (draft !== null) setter.current((fresh) => {
      const live = useAuthStore.getState();
      return live.agent?.id === actorId && live.sessionEpoch === epoch ? fresh || draft : fresh;
    });
    return () => {
      const bound = binding.current;
      const live = useAuthStore.getState();
      // Flush pending typing on navigation, but never after logout/session change.
      if (bound && live.agent?.id === bound.actorId && live.sessionEpoch === bound.epoch && draftWriteAfterRestore(latestText.current, bound.pending).write) {
        writeCleanChatDraft(bound.actorId, bound.conversationId, latestText.current);
      }
      binding.current = null;
    };
  }, [enabled, actorId, conversationId, epoch]);
  useEffect(() => {
    const bound = binding.current;
    const current = useAuthStore.getState();
    if (!enabled || !bound || bound.actorId !== actorId || bound.conversationId !== conversationId || current.agent?.id !== bound.actorId || current.sessionEpoch !== bound.epoch) return;
    const next = draftWriteAfterRestore(text, bound.pending);
    bound.pending = next.pending;
    if (!next.write) return;
    if (!text) { writeCleanChatDraft(bound.actorId, bound.conversationId, text); return; }
    const timer = setTimeout(() => {
      const live = useAuthStore.getState();
      if (live.agent?.id === bound.actorId && live.sessionEpoch === bound.epoch) writeCleanChatDraft(bound.actorId, bound.conversationId, text);
    }, 250);
    return () => clearTimeout(timer);
  }, [enabled, actorId, conversationId, epoch, text]);
  useEffect(() => {
    const flush = () => {
      const bound = binding.current;
      const live = useAuthStore.getState();
      if (enabled && bound && live.agent?.id === bound.actorId && live.sessionEpoch === bound.epoch && draftWriteAfterRestore(latestText.current, bound.pending).write) {
        writeCleanChatDraft(bound.actorId, bound.conversationId, latestText.current);
      }
    };
    window.addEventListener?.("pagehide", flush);
    return () => window.removeEventListener?.("pagehide", flush);
  }, [enabled]);
}
