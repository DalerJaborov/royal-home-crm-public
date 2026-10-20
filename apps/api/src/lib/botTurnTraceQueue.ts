import type { BotTurnTracePayload } from "@royal-home/shared";

/** No timeout races: each trace is serialized until the real write settles. */
export function createTraceQueue(write: (payload: BotTurnTracePayload) => Promise<unknown>, onFailure: () => void, maxTraces = 64, maxPending = 4, onTask?: (task: Promise<void>) => void) {
  const queues = new Map<string, { pending: BotTurnTracePayload[]; running: boolean; highestSeq: number; finalSeen: boolean }>();
  const tasks = new Set<Promise<void>>();
  function enqueue(payload: BotTurnTracePayload): void {
    let state = queues.get(payload.traceId);
    if (!state) {
      if (queues.size >= maxTraces) { onFailure(); return; }
      state = { pending: [], running: false, highestSeq: -1, finalSeen: false }; queues.set(payload.traceId, state);
    }
    // A delayed producer must not replace the terminal snapshot in a full queue.
    if (payload.checkpointSeq <= state.highestSeq || state.finalSeen) return;
    state.highestSeq = payload.checkpointSeq;
    state.finalSeen = payload.completedAt !== null;
    const queue = state.pending;
    if (queue.length >= maxPending) {
      // Keep earliest crash checkpoint and latest state, bounded and observable.
      payload.checkpointGaps += queue[queue.length - 1].checkpointGaps + 1;
      queue[queue.length - 1] = payload;
      onFailure(); return;
    }
    queue.push(payload);
    if (state.running) return;
    state.running = true;
    const task = (async () => {
      while (queue.length) {
        const next = queue.shift()!;
        try { await write(next); } catch { onFailure(); }
      }
      queues.delete(payload.traceId);
    })();
    tasks.add(task); onTask?.(task); void task.finally(() => tasks.delete(task));
  }
  return { enqueue, drain: () => Promise.all([...tasks]), pendingTraces: () => queues.size };
}
