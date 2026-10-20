import { expect, it, vi } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { offlineLedger, useModel, assertOfflineDrained } from "./setupOffline.js";
import { loadReplayDataset, locateQuote } from "./dataset.js";
import { ASSERTION_ADAPTERS, SYNTHETIC_PHONE } from "./caseAdapters.js";
import { assertion, unavailable } from "./assertions.js";
import { replayReport, writeReplayReport, type ReplayCase } from "./report.js";
import { OFFLINE_QUALIFY_CAPABILITIES } from "./scriptedModel.js";

// SHA must be supplied by the parent CLI before the child installs its sandbox.
it("accounts for immutable200/210 and executes eleven declared structural companions twice", async () => {
  const directory = process.env.REPLAY_DATASET_DIR; const artifact = process.env.REPLAY_ARTIFACT; const sha = process.env.REPLAY_SOURCE_SHA;
  if (!directory || !artifact || !sha) throw new Error("Explicit dataset/artifact/source SHA required");
  const dataset = loadReplayDataset(directory);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-10-14T10:17:00.000Z");
  const { runQualifyTurn, mergeDraft } = await import("../../src/ai/leadQualifier.js");
  const { finalizeBotReply, NEUTRAL_REPLIES } = await import("../../src/messengers/replyChain.js");
  const abilities = { showings: true, askOwner: true, vacancies: false, promptEconomy: false, callback: false, links: false, cautious: false };
  async function run() {
    const cases: ReplayCase[] = [];
    for (const item of dataset.cases) for (const [turnIndex, goldenTurn] of item.record.goldenTurns.entries()) {
      const key = `${item.record.id}/t${turnIndex + 1}/occ1`;
      const adapter = turnIndex === 0 ? ASSERTION_ADAPTERS.find((candidate) => candidate.id === item.record.id) : undefined;
      const entry: ReplayCase = { key, channel: item.source.channel, language: adapter?.language ?? item.source.language, media: item.source.media, historicalLabel: item.record.error,
        assertions: [unavailable(`${key}:full-behavior`, goldenTurn.expectedBehavior, "Historical facts/provider outputs/initial CRM state unavailable; full semantic oracle not implemented")], transcript: [], draft: null, receipts: [], attempts: [], unavailable: typeof item.record.limitations === "string" ? [item.record.limitations] : item.record.limitations };
      if (item.quoteEvidence[turnIndex].status === "unavailable") entry.unavailable.push(item.quoteEvidence[turnIndex].reason!);
      if (adapter) {
        const index = locateQuote(item.turns, goldenTurn.clientText, 1, "substring" in adapter && adapter.substring);
        const clientText = item.turns[index].content.replace(/\[ТЕЛЕФОН\]/g, SYNTHETIC_PHONE);
        const initial = adapter.knownPhone ? { phone: SYNTHETIC_PHONE, stage: "chatting" as const } : {};
        const before = structuredClone(initial); const attemptStart = offlineLedger.attempts.length;
        const model = useModel([{ endpoint: "lead-qualify", result: { reply: ["MODEL-UNTRUSTED-RECEIPT"], ready: "false", confident: true,
          lead: { phone: SYNTHETIC_PHONE, notes: "MALFORMED-STATE-SENTINEL" }, showing: { action: "cancel" } }, qualification: "intentional-invalid" }]);
        const result = await runQualifyTurn([{ role: "user", content: clientText }], initial, { abilities });
        model.assertConsumed();
        entry.assertions.push(assertion(`${key}:malformed`, "Whole malformed model object rejected", result, null), assertion(`${key}:state`, "Input known contact/state not mutated by rejected result", initial, before));
        entry.transcript.push({ role: "user", content: clientText }); entry.draft = structuredClone(initial);
        if (adapter.id === "Д037" || adapter.id === "Д086") {
          const validModel = useModel([{ endpoint: "lead-qualify", result: { reply: [adapter.language === "tg" ? "Рақаматонро нависед. Кадом ноҳия?" : "Напишите номер телефона. Уточните район."], ready: false, confident: false, lead: null }, qualification: OFFLINE_QUALIFY_CAPABILITIES }]);
          const history = [{ role: "user" as const, content: clientText }];
          const validResult = await runQualifyTurn(history, initial, { abilities, phoneKnown: true });
          validModel.assertConsumed();
          if (!validResult) throw new Error("Declared valid known-contact model fixture rejected");
          const merged = mergeDraft(initial, validResult, clientText);
          const final = await finalizeBotReply({ reply: validResult.reply, conversationId: `replay-valid-${adapter.id}`, channelLabel: item.source.channel, openUrl: "/replay", botSpokeBefore: true,
            botSaidBefore: [], clientSaidTrusted: clientText, clientTurnText: clientText, previousBotText: "", language: adapter.language,
            draft: merged, jobConversation: false, phoneAsksSent: 1, phoneKnown: true, fallbackLanguageWords: [clientText] });
          entry.assertions.push(assertion(`${key}:valid-phone-state`, "Actual valid qualifier/merge preserves declared known contact", (merged as { phone?: string }).phone, SYNTHETIC_PHONE),
            assertion(`${key}:valid-no-reask`, "Actual reply chain removes the scripted repeated contact request", /Рақаматонро нависед|номер телефона|рақам/i.test(final.bubbles.join(" ")), false),
            assertion(`${key}:valid-reply`, "Known-contact valid path yields a substantive/recovery reply", final.bubbles.length > 0, true));
          entry.draft = merged; entry.transcript.push(...final.bubbles.map((content) => ({ role: "assistant", content })));
        }
        if ("recovery" in adapter && adapter.recovery) {
          const old = NEUTRAL_REPLIES.statement[adapter.language];
          const recovered = await finalizeBotReply({ reply: [old], conversationId: `replay-${item.record.id}`, channelLabel: item.source.channel, openUrl: "/replay", botSpokeBefore: true,
            botSaidBefore: [old], clientSaidTrusted: clientText, clientTurnText: clientText, previousBotText: old, language: adapter.language,
            draft: { stage: "chatting" }, jobConversation: false, phoneAsksSent: 0, phoneKnown: true, fallbackLanguageWords: [clientText] });
          const legal = Object.values(NEUTRAL_REPLIES).map((template) => template[adapter.language]);
          entry.assertions.push(assertion(`${key}:recovery-language`, "Explicit recovery emits an established template in assigned language", recovered.bubbles.length === 1 && legal.includes(recovered.bubbles[0]), true),
            assertion(`${key}:no-receipt`, "No false booking/contact receipt in recovery", /записал|қайд кардам|MODEL-UNTRUSTED-RECEIPT/.test(recovered.bubbles.join(" ")), false));
          entry.transcript.push(...recovered.bubbles.map((content) => ({ role: "assistant", content })));
        }
        entry.attempts = offlineLedger.snapshot().slice(attemptStart);
      }
      cases.push(entry);
    }
    return replayReport({ sha: sha!, hashes: dataset.hashes, cases, integrity: { records: dataset.records, selectedTurns: dataset.selectedTurns }, quoteAccounting: dataset.quoteAccounting,
      layer: "real-qualifier-and-explicit-recovery; synthetic-read-context; no-DB/no-CRM-or-transport-execution", flags: { propertyContext: false, turnTrace: false } });
  }
  try {
    const first = await run(); const second = await run();
    // Cached DB-read count may differ between cold/warm imports. It is reported
    // as implementation evidence but excluded from the versioned semantic view.
    const semantic = (report: typeof first) => ({ ...report, cases: report.cases.map((entry) => ({ ...entry, attempts: entry.attempts.filter((attempt) => (attempt as { kind?: string }).kind !== "db") })) });
    expect(isDeepStrictEqual(semantic(second), semantic(first))).toBe(true);
    await assertOfflineDrained(); offlineLedger.assertClean(); loadReplayDataset(directory);
    if (artifact.toLowerCase().replace(/\\/g, "/").startsWith(`${dataset.root.toLowerCase().replace(/\\/g, "/")}/`)) throw new Error("Replay artifact cannot overwrite dataset");
    writeReplayReport(artifact, first);
    expect(first.accounting.turnsAccounted).toBe(210); expect(first.accounting.evaluatedCases).toBe(11); expect(first.exitCode).toBe(0);
  } finally { vi.useRealTimers(); }
});
