import type { PropertyDraftView } from "@royal-home/shared";
import { api } from "./api";
import { useAuthStore } from "../store/auth";

export interface PropertyDraftSession { draft: PropertyDraftView | null; revision: number }
let owner = "";
let generation = 0;
let current: PropertyDraftSession | null = null;
let starting: Promise<PropertyDraftView> | null = null;
let startId: string | null = null;

function sessionOwner(): string {
  const { agent, sessionEpoch, hasSession } = useAuthStore.getState();
  return hasSession && agent ? `${agent.id}:${sessionEpoch}` : "";
}
function syncOwner(): string {
  const next = sessionOwner();
  if (next !== owner) {
    owner = next;
    generation++;
    current = null;
    starting = null;
    startId = null;
  }
  return next;
}
export function propertyDraftSessionToken(): string { return `${syncOwner()}:${generation}`; }
export function isPropertyDraftSessionCurrent(token: string): boolean { return token === propertyDraftSessionToken(); }
export function adoptPropertyDraftSession(session: PropertyDraftSession): void {
  syncOwner();
  if (!current || session.revision >= current.revision) current = session;
}
export function getPropertyDraftSession(): PropertyDraftSession | null { syncOwner(); return current; }
/** Explicit close/restart invalidates late client callbacks; the server tombstone
 * independently rejects a late PUT/start from this or another tab. */
export function invalidatePropertyDraftSession(session: PropertyDraftSession | null = null): void {
  syncOwner();
  generation++;
  current = session;
  starting = null;
  startId = null;
}
export async function loadPropertyDraftSession(): Promise<PropertyDraftSession> {
  const token = propertyDraftSessionToken();
  const agentId = useAuthStore.getState().agent?.id;
  const session = await api<PropertyDraftSession>("/properties/drafts/current", { expectAgentId: agentId });
  if (!isPropertyDraftSessionCurrent(token)) throw new Error("Сессия черновика изменилась. Откройте мастер заново");
  adoptPropertyDraftSession(session);
  return current!;
}
export async function ensurePropertyDraftSession(): Promise<PropertyDraftView> {
  syncOwner();
  if (current?.draft) return current.draft;
  if (starting) return starting;
  const token = propertyDraftSessionToken();
  startId ??= crypto.randomUUID();
  const id = startId;
  starting = (async () => {
    const session = current ?? await loadPropertyDraftSession();
    if (session.draft) return session.draft;
    const opened = await api<PropertyDraftSession>("/properties/drafts/current/start", {
      method: "POST", body: { sessionId: id, revision: session.revision },
      expectAgentId: useAuthStore.getState().agent?.id,
    });
    if (!isPropertyDraftSessionCurrent(token)) throw new Error("Сессия черновика изменилась. Откройте мастер заново");
    adoptPropertyDraftSession(opened);
    if (!opened.draft) throw new Error("Не удалось открыть черновик");
    return opened.draft;
  })().finally(() => { if (isPropertyDraftSessionCurrent(token)) starting = null; });
  return starting;
}
