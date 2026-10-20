import { describe, expect, it, vi } from "vitest";
import { parseLiveVoiceServerMessage } from "../src/ai/liveVoiceClient.js";
import { invokeLiveVoiceTranscriptionObserver, liveVoiceTranscriptionObservations, parseLiveVoiceTranscription } from "../src/ai/liveVoiceTranscription.js";

const context = { model: "unqualified-test-live", connectionEpoch: 1, messageOrder: 1 };

describe("Live transcription wire boundary without provider/model-profile activation", () => {
  it("preserves exact finished and nanosecond offsets separately from legacy text", () => {
    const update = parseLiveVoiceServerMessage({ serverContent: { inputTranscription: {
      text: "Не звоните завтра", finished: true, startOffset: "1.123456789s", endOffset: "2.000000001s",
    } } });
    expect(update.inputTranscript).toBe("Не звоните завтра");
    expect(update.inputTranscription).toEqual({ text: "Не звоните завтра", finished: true,
      startOffset: "1.123456789s", endOffset: "2.000000001s", metadataValid: true });
    expect(liveVoiceTranscriptionObservations(update, context)[0].humanFinality).toBe("unknown");
  });

  it.each([undefined, false, "true", 1, null])("never coerces finished=%s into final input", finished => {
    const update = parseLiveVoiceServerMessage({ serverContent: { inputTranscription: { text: "да", finished } } });
    expect(update.inputTranscript).toBe("да"); // legacy observer compatibility
    expect(update.inputTranscription?.finished === true).toBe(false);
    expect(liveVoiceTranscriptionObservations(update, context)[0].humanFinality).toBe("unknown");
  });

  it("retains an empty finished fragment without inventing a legacy transcript line", () => {
    const update = parseLiveVoiceServerMessage({ serverContent: { inputTranscription: { text: "", finished: true } } });
    expect(update.inputTranscript).toBeUndefined();
    expect(liveVoiceTranscriptionObservations(update, context)).toMatchObject([
      { stream: "input", fragment: { text: "", finished: true }, humanFinality: "unknown" },
    ]);
  });

  it("keeps interim independent and out of legacy human history even with finished=true", () => {
    const update = parseLiveVoiceServerMessage({ serverContent: { interimInputTranscription: { text: "позво", finished: true } } });
    expect(update.inputTranscript).toBeUndefined();
    expect(update.inputTranscription).toBeUndefined();
    expect(liveVoiceTranscriptionObservations(update, context)).toMatchObject([
      { stream: "interim_input", humanFinality: "unknown" },
    ]);
  });

  it("does not promote output turnComplete to human FINAL and keeps the three streams distinct", () => {
    const outputOnly = parseLiveVoiceServerMessage({ serverContent: { outputTranscription: { text: "Записали", finished: true }, turnComplete: true } });
    expect(outputOnly.turnComplete).toBe(true);
    expect(liveVoiceTranscriptionObservations(outputOnly, context)).toMatchObject([{ stream: "output", humanFinality: "unknown" }]);
    const all = parseLiveVoiceServerMessage({ serverContent: {
      interimInputTranscription: { text: "не" }, inputTranscription: { text: "не надо", finished: true },
      outputTranscription: { text: "Уточните" }, turnComplete: true,
    } });
    expect(liveVoiceTranscriptionObservations(all, context).map(row => row.stream)).toEqual(["interim_input", "input", "output"]);
  });

  it("marks malformed known metadata invalid without accepting negative, numeric or reversed offsets", () => {
    expect(parseLiveVoiceTranscription({ text: "да", finished: "true", startOffset: -1 }))
      .toEqual({ text: "да", metadataValid: false });
    expect(parseLiveVoiceTranscription({ text: "да", startOffset: "2s", endOffset: "1s" })?.metadataValid).toBe(false);
    expect(parseLiveVoiceTranscription({ text: "да", startOffset: "99999999.000000002s", endOffset: "99999999.000000001s" })?.metadataValid).toBe(false);
    expect(parseLiveVoiceTranscription({ text: "да", endOffset: "-1s" })?.metadataValid).toBe(false);
    expect(parseLiveVoiceTranscription([])).toBeUndefined();
  });

  it("does not fabricate input evidence from an output-only turnComplete", () => {
    const update = parseLiveVoiceServerMessage({ serverContent: { turnComplete: true } });
    expect(update.turnComplete).toBe(true);
    expect(liveVoiceTranscriptionObservations(update, context)).toEqual([]);
  });

  it("retains local connection epochs but never creates a provider utterance ID", () => {
    const update = parseLiveVoiceServerMessage({ serverContent: { inputTranscription: { text: "да", finished: true } } });
    const first = liveVoiceTranscriptionObservations(update, context)[0];
    const resumed = liveVoiceTranscriptionObservations(update, { ...context, connectionEpoch: 2 })[0];
    expect(first.connectionEpoch).not.toBe(resumed.connectionEpoch);
    expect(first).not.toHaveProperty("utteranceId");
    expect(liveVoiceTranscriptionObservations(update, { ...context, connectionEpoch: 0 })).toEqual([]);
  });
});

describe("deferred native transcription observation boundary", () => {
  it("consumes synchronous observer failure and does not pass its PII/error to diagnostics", async () => {
    const diagnostics = vi.fn();
    await expect(invokeLiveVoiceTranscriptionObserver(() => { throw new Error("synthetic private transcript"); },
      () => true, diagnostics)).resolves.toBeUndefined();
    expect(diagnostics).toHaveBeenCalledExactlyOnceWith();
  });

  it("consumes async observer rejection and diagnostic rejection without an unhandled promise", async () => {
    const diagnostics = vi.fn(async () => { throw new Error("synthetic logger outage"); });
    await expect(invokeLiveVoiceTranscriptionObserver(async () => { throw new Error("synthetic provider private error"); },
      () => true, diagnostics)).resolves.toBeUndefined();
    expect(diagnostics).toHaveBeenCalledExactlyOnceWith();
  });

  it("does not invoke an observer whose ORIGINAL session becomes obsolete before the microtask", async () => {
    let current = true;
    const observer = vi.fn(), diagnostics = vi.fn();
    const pending = invokeLiveVoiceTranscriptionObserver(observer, () => current, diagnostics);
    current = false;
    await pending;
    expect(observer).not.toHaveBeenCalled();
    expect(diagnostics).not.toHaveBeenCalled();
  });
});
