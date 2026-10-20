import { afterAll, it } from "vitest";
import { offlineLedger, useModel } from "./setupOffline.js";
import { replayReport, writeReplayReport } from "./report.js";
import { assertion } from "./assertions.js";

it("an intentionally preliminary green case never publishes a green final artifact after a forbidden/fatal outcome", async () => {
  if (!process.env.REPLAY_ARTIFACT || !process.env.REPLAY_SOURCE_SHA) throw new Error("Explicit probe run metadata required");
  const report = replayReport({ sha: process.env.REPLAY_SOURCE_SHA, hashes: {}, integrity: { records: 0, selectedTurns: 0 }, layer: "intentional-negative-control", flags: {}, cases: [{ key: "control", channel: "synthetic", language: "ru", media: "text", historicalLabel: "not-golden", transcript: [], draft: null, receipts: [], unavailable: [], attempts: [],
    assertions: [assertion("oracle", "Independent oracle mutation", "TJS", process.env.REPLAY_NEGATIVE_PROBE === "wrong-oracle" ? "USD" : "TJS")] }] });
  writeReplayReport(process.env.REPLAY_ARTIFACT, report);
  if (process.env.REPLAY_NEGATIVE_PROBE === "unfinished-drain") {
    const { trackBackgroundTask } = await import("../../src/lib/shutdownState.js"); trackBackgroundTask(new Promise(() => {}));
  }
  if (process.env.REPLAY_NEGATIVE_PROBE === "extra-model") {
    try { await useModel([]).call("lead-qualify"); } catch { /* business fallback catches it */ }
  }
});
afterAll(async () => {
  if (process.env.REPLAY_NEGATIVE_PROBE === "late-caught-network") {
    // Unregistered timer after preliminary artifact write. Provider hooks remain
    // installed and the private sticky marker rejects final publication.
    await new Promise<void>((resolve) => setTimeout(async () => { try { await fetch("https://example.invalid/"); } catch { /* caught */ } resolve(); }, 20));
    void offlineLedger; // Ledger independent of assertion status/report snapshot.
  }
});
