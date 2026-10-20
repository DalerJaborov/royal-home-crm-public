import { ReplayLedger } from "./ledger.js";
import { submitReplySchema, type SubmitReplyCapabilities } from "@royal-home/shared";

export interface ScriptedResult {
  endpoint: string;
  result: unknown;
  /** Positive fixtures use the real boundary; deliberate malformed outputs must say so. */
  qualification?: SubmitReplyCapabilities | "intentional-invalid";
}

export const STAND_QUALIFY_CAPABILITIES: SubmitReplyCapabilities = {
  showings: false, askOwner: false, vacancies: false, promptEconomy: false,
  canSendPhotos: false, canSendGuide: false, topicLock: true,
};
export const OFFLINE_QUALIFY_CAPABILITIES: SubmitReplyCapabilities = {
  ...STAND_QUALIFY_CAPABILITIES, showings: true, askOwner: true, topicLock: false,
};

export class ScriptedModel {
  private index = 0;
  constructor(private readonly script: readonly ScriptedResult[], private readonly ledger: ReplayLedger) {
    for (const item of script) {
      if (item.endpoint !== "lead-qualify" || item.qualification === "intentional-invalid") continue;
      if (!item.qualification || !submitReplySchema(item.qualification).safeParse(item.result).success) {
        ledger.deny("diagnostic", "invalid-positive-submit-reply-fixture");
      }
    }
  }
  async call(endpoint: string): Promise<unknown> {
    const item = this.script[this.index++];
    if (!item || item.endpoint !== endpoint) return this.ledger.deny("model", `unexpected-endpoint-or-extra-call:${/^[a-z][a-z0-9:_-]{0,60}$/.test(endpoint) ? endpoint : "invalid"}`);
    this.ledger.record("model", endpoint, true);
    return structuredClone(item.result);
  }
  assertConsumed(): void { if (this.index !== this.script.length) throw new Error("Scripted model calls not fully consumed"); this.ledger.assertClean(); }
}
