export type WizardDraftStatus =
  | { state: "saving" }
  | { state: "server"; savedAt?: string }
  | { state: "local"; message?: string }
  | { state: "error"; message: string };

export interface DraftSnapshot {
  values: Record<string, unknown>;
  step: number;
}
export interface DraftAcknowledgement { id: string; revision: number; updatedAt: string }

/** One writer per wizard. Acknowledgements belong to snapshots, never to whatever
 * happens to be in the form when the network returns. Server CAS also protects tabs. */
export class DraftAutosave {
  private snapshot: DraftSnapshot | null = null;
  private version = 0;
  private acknowledged = 0;
  private epoch = 0;
  private inFlight: Promise<void> | null = null;
  private keepalive = false;
  constructor(
    private readonly save: (snapshot: DraftSnapshot, keepalive: boolean) => Promise<DraftAcknowledgement>,
    private readonly notify: (status: WizardDraftStatus) => void,
  ) {}
  get dirty(): boolean { return this.snapshot !== null && this.version !== this.acknowledged; }
  stage(snapshot: DraftSnapshot): void {
    this.snapshot = snapshot;
    this.version++;
    this.notify({ state: "local" });
  }
  cancel(): void {
    this.epoch++;
    this.snapshot = null;
    this.acknowledged = this.version;
    this.inFlight = null;
  }
  flush(keepalive = false): Promise<void> {
    this.keepalive ||= keepalive;
    if (this.inFlight) return this.inFlight;
    if (!this.dirty) return Promise.resolve();
    const epoch = this.epoch;
    const task = this.drain(epoch).finally(() => { if (this.inFlight === task) this.inFlight = null; });
    this.inFlight = task;
    return task;
  }
  private async drain(epoch: number): Promise<void> {
    while (this.dirty && epoch === this.epoch) {
      const snapshot = this.snapshot!;
      const version = this.version;
      this.notify({ state: "saving" });
      try {
        const saved = await this.save(snapshot, this.keepalive);
        if (epoch !== this.epoch) return;
        this.acknowledged = version;
        if (!this.dirty) this.notify({ state: "server", savedAt: saved.updatedAt });
      } catch (error) {
        if (epoch !== this.epoch) return;
        const message = error instanceof Error ? error.message : "Не удалось сохранить черновик";
        const conflict = typeof error === "object" && error !== null && "status" in error && error.status === 409;
        this.notify({ state: conflict ? "error" : "local", message });
        throw error;
      }
    }
    this.keepalive = false;
  }
}
