/** Long-lived authenticated connections outside the general event bus.
 * Register a synchronous closer so account/permission revocation and shutdown
 * apply to live audio too. No transport or database dependencies. */
const closers = new Map<string, Set<() => void>>();

export function registerAuthenticatedStream(agentId: string, close: () => void): () => void {
  const mine = closers.get(agentId) ?? new Set<() => void>();
  mine.add(close);
  closers.set(agentId, mine);
  return () => {
    mine.delete(close);
    if (mine.size === 0 && closers.get(agentId) === mine) closers.delete(agentId);
  };
}

export function closeAuthenticatedStreams(agentId?: string): number {
  const selected = agentId === undefined ? [...closers.entries()] : [[agentId, closers.get(agentId)]] as const;
  let closed = 0;
  for (const [id, mine] of selected) {
    if (!mine) continue;
    closers.delete(id);
    for (const close of [...mine]) {
      closed++;
      try { close(); } catch { /* A dead socket must not prevent closing the others. */ }
    }
  }
  return closed;
}
