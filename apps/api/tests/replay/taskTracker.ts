import { ReplayLedger } from "./ledger.js";
export class ReplayTasks {
  readonly pending = new Set<Promise<unknown>>();
  track<T>(promise: Promise<T>): Promise<T> { this.pending.add(promise); promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise)); return promise; }
  assertSettled(ledger: ReplayLedger): void { if (this.pending.size) ledger.deny("effect", "incomplete-background-drain"); }
}
