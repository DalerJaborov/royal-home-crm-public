import { describe, expect, it, vi } from "vitest";
import { botTurnTracePayloadSchema, type BotTurnTracePayload } from "@royal-home/shared";
import { withBotTurnTrace, currentBotTurnTrace, traceBindConversation, traceOutcome, traceCheckpoint, traceModelStart, traceModelFinish, traceModelValidation, traceFilterDelta, traceObserveSend, traceProviderAccepted, traceStamp, traceWidgetAvailable, traceWebsiteMessagesPersisted, traceGrouped, traceDeferUntil, traceKnownSecrets, traceResolution } from "../src/lib/botTurnTrace.js";
import { sanitizeTraceText, tracePseudonym, projectTraceModel } from "../src/lib/botTurnTracePrivacy.js";
import { projectBotIngressShape } from "../src/lib/botTurnTraceIngress.js";
import { createTraceQueue } from "../src/lib/botTurnTraceQueue.js";

const SECRET = "fictional-trace-key-only-for-unit-tests-0000";
function recorder(text = false) {
  const rows: BotTurnTracePayload[] = [];
  return { rows, config: { enabled: true, secret: SECRET, text, write: (row: BotTurnTracePayload) => { rows.push(row); } } };
}
const turn = { channel: "WHATSAPP", account: "fake-account", peer: "fake-peer", event: "fake-event", text: "цена?" };
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("turn trace privacy boundary", () => {
  it("defaults to shapes; nested model secrets and contact fields never enter the projection", async () => {
    const { rows, config } = recorder();
    await withBotTurnTrace(turn, async () => {
      const index = traceModelStart("gemini-unit", true);
      traceModelFinish(index, "parsed", performance.now(), { reply: ["Имя Далер, +992901234567"], ready: false, confident: true,
        lead: { phone: "+992901234567", name: "Далер", notes: "PRIVATE_NOTES" }, jobApplication: { name: "PRIVATE_JOB" },
        headers: { authorization: "PRIVATE_SECRET" } });
    }, config);
    const json = JSON.stringify(rows);
    for (const secret of ["Далер", "+992901234567", "PRIVATE_NOTES", "PRIVATE_JOB", "PRIVATE_SECRET", "authorization", "headers"]) expect(json).not.toContain(secret);
    expect(rows.at(-1)?.modelAttempts[0].projection?.jobPresent).toBe(true);
    expect(rows.at(-1)?.modelAttempts[0].projection?.reply).toMatchObject({ present: true });
    expect(rows.at(-1)?.modelAttempts[0].projection?.reply.text).toBeUndefined();
  });
  it.each(["+992 90 123-45-67", "90(123)45.67", "９０１２３４５６７", "٩٠١٢٣٤٥٦٧", "+44 7700 900123"])("completely removes phone-like input %s", (phone) => {
    const result = sanitizeTraceText(`Телефон ${phone}`);
    expect(result.text).toBe("Телефон [PHONE]");
    expect(result.redactedKinds).toContain("phone");
  });
  it("keeps diagnostic prices/areas and removes known names, URLs, emails, handles and tokens", () => {
    const result = sanitizeTraceText("Далер: 1 221 000 сомони, 87 м². a@test.example @fake_user https://example.test/p?token=secret Bearer fictionalToken password=fictionalPassword", ["Далер"]);
    expect(result.text).toContain("1 221 000 сомони, 87 м²");
    for (const value of ["Далер", "a@test.example", "@fake_user", "https://", "fictionalToken", "fictionalPassword"]) expect(result.text).not.toContain(value);
  });
  it("registers transient arbitrary-format provider secrets without serializing the dictionary", async () => {
    const { rows, config } = recorder(true);
    await withBotTurnTrace(turn, async () => {
      traceKnownSecrets(["odd_format_fictional_credential"]);
      const index = traceModelStart("gemini-unit", false);
      traceModelFinish(index, "parsed", performance.now(), { reply: ["odd_format_fictional_credential"] });
    }, config);
    expect(JSON.stringify(rows)).not.toContain("odd_format_fictional_credential");
    expect(rows.at(-1)?.redactedKinds).toContain("credential");
  });
  it("uses HMAC domain/account/channel separation", () => {
    const a = tracePseudonym(SECRET, "mid", "WHATSAPP", "a", "fake-id");
    for (const b of [tracePseudonym(SECRET, "event", "WHATSAPP", "a", "fake-id"), tracePseudonym(SECRET, "mid", "WHATSAPP", "b", "fake-id"), tracePseudonym(SECRET, "mid", "INSTAGRAM", "a", "fake-id")]) expect(a).not.toBe(b);
    expect(tracePseudonym(SECRET, "mid", "WHATSAPP", "a", null)).toBeNull();
  });
  it("schema diagnostics omit unknown key names and nested values", async () => {
    const { rows, config } = recorder();
    await withBotTurnTrace(turn, async () => {
      traceModelStart("gemini-unit", false);
      traceModelValidation({ reply: [], arbitrary_private_key: "secret_value" }, [{ path: ["arbitrary_private_key"], code: "unrecognized_keys" }, { path: ["jobApplication", "private_name"], code: "invalid_type" }]);
    }, config);
    expect(JSON.stringify(rows)).not.toMatch(/arbitrary_private_key|secret_value|private_name/);
    expect(rows.at(-1)?.modelAttempts[0].schemaIssues).toEqual([{ path: "other", code: "unrecognized_keys" }, { path: "jobApplication", code: "invalid_type" }]);
  });
  it("schema validation cannot erase a provider protocol fault or infer absent cache metadata", async () => {
    const { rows, config } = recorder();
    await withBotTurnTrace(turn, async () => {
      for (const issue of ["wrong_tool", "multiple_calls"] as const) {
        const raw = { reply: ["Ответ"], ready: false, confident: true };
        const index = traceModelStart("gemini-unit", null); traceModelFinish(index, issue, performance.now(), raw); traceModelValidation(raw);
      }
    }, config);
    expect(rows.at(-1)?.modelAttempts.map((attempt) => [attempt.outcome, attempt.protocolIssue, attempt.cacheUsed])).toEqual([["parsed", "wrong_tool", null], ["parsed", "multiple_calls", null]]);
  });
  it("rejects unknown schema fields instead of stripping them into a seemingly valid trace", async () => {
    const { rows, config } = recorder();
    await withBotTurnTrace(turn, async () => {}, config);
    expect(botTurnTracePayloadSchema.safeParse({ ...rows[0], rawProviderBody: {} }).success).toBe(false);
  });
  it("projector failures never serialize the raw value", async () => {
    const { rows, config } = recorder();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const expected = {};
    const result = await withBotTurnTrace(turn, async () => {
      const index = traceModelStart("gemini-unit", false);
      traceModelFinish(index, "parsed", performance.now(), new Proxy({}, { get() { throw new Error("PRIVATE_ERROR"); } }));
      return expected;
    }, config);
    expect(result).toBe(expected); expect(JSON.stringify(rows)).not.toContain("PRIVATE_ERROR"); warning.mockRestore();
  });
  it("bounds UTF-8 payloads and reports collection truncation", async () => {
    const { rows, config } = recorder(true);
    await withBotTurnTrace(turn, async () => { for (let i = 0; i < 100; i++) traceFilterDelta("reply_chain", "я".repeat(30000), "б".repeat(30000)); }, config);
    for (const row of rows) { expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThanOrEqual(32768); expect(botTurnTracePayloadSchema.safeParse(row).success).toBe(true); }
    expect(rows.at(-1)?.truncated).toBe(true);
    expect(rows.at(-1)?.omittedCounts.filterDeltas).toBeGreaterThan(0);
  });
});

describe("context, delivery and final fencing", () => {
  it("isolates simultaneous accounts through await and records honest unknown retry event", async () => {
    const { rows, config } = recorder();
    await Promise.all(["one", "two"].map((account) => withBotTurnTrace({ ...turn, account, source: "ai_retry", event: null }, async () => {
      await pause(); traceBindConversation(`conversation-${account}`); traceResolution("ad", `property-${account}`);
    }, config)));
    const finals = rows.filter((row) => row.completedAt);
    expect(finals).toHaveLength(2); expect(finals[0].accountKey).not.toBe(finals[1].accountKey);
    expect(finals[0].conversationKey).not.toBe(finals[1].conversationKey); expect(finals.every((row) => row.eventKey === null)).toBe(true);
  });
  it("groups captured source keys without mixing another concurrent context", async () => {
    const { rows, config } = recorder();
    let entry: ReturnType<typeof currentBotTurnTrace>;
    await withBotTurnTrace(turn, async () => { entry = currentBotTurnTrace(); traceOutcome("batched"); }, config);
    await withBotTurnTrace({ ...turn, event: "second" }, async () => { traceGrouped([entry!]); }, config);
    expect(rows.at(-1)?.groupedTraceIds).toEqual([entry!.traceId]);
    expect(rows.at(-1)?.groupedEventKeys).toEqual([entry!.eventKey]);
  });
  it("accepted transport remains accepted after tail/stamp failure; no MID does not imply failure", async () => {
    const { rows, config } = recorder();
    await withBotTurnTrace(turn, async () => {
      await expect(traceObserveSend("text", "price", "bot", async () => { traceProviderAccepted("fake-mid"); throw new Error("tail failure"); })).rejects.toThrow("tail failure");
      traceStamp("fake-mid", false);
      await traceObserveSend("image", "", "bot", async () => { traceProviderAccepted(null); return null; });
    }, config);
    expect(rows.at(-1)?.outgoing.map((part) => part.providerOutcome)).toEqual(["accepted", "accepted"]);
    expect(rows.at(-1)?.outgoing[0].stampOutcome).toBe("failed"); expect(rows.at(-1)?.outgoing[1].midKey).toBeNull();
  });
  it("ambiguous network failure stays unknown; explicit provider refusal stays failed", async () => {
    const { rows, config } = recorder();
    await withBotTurnTrace(turn, async () => {
      for (const error of [new TypeError("fetch failed"), new Error("Graph API HTTP 400: refused")]) await traceObserveSend("text", "", "bot", async () => { throw error; }).catch(() => {});
    }, config);
    expect(rows.at(-1)?.outgoing.map((part) => part.providerOutcome)).toEqual(["unknown", "failed"]);
  });
  it("success without an observed provider acceptance remains unknown", async () => {
    const { rows, config } = recorder();
    await withBotTurnTrace(turn, () => traceObserveSend("text", "", "bot", async () => "unobserved-mid"), config);
    expect(rows.at(-1)?.outgoing[0].providerOutcome).toBe("unknown");
  });
  it("accepted first part plus blocked second part is partially sent", async () => {
    const { rows, config } = recorder();
    await withBotTurnTrace(turn, async () => {
      await traceObserveSend("text", "first", "bot", async () => traceProviderAccepted("fake-mid"));
      const error = new Error("shield"); error.name = "OutboundBlockedError";
      await traceObserveSend("text", "second", "bot", async () => { throw error; }).catch(() => traceOutcome("blocked"));
    }, config);
    expect(rows.at(-1)?.outcome).toBe("partially_sent");
    expect(rows.at(-1)?.outgoing.map((part) => part.providerOutcome)).toEqual(["accepted", "blocked"]);
  });
  it("excludes staff and different recipients while preserving the exact send count/results", async () => {
    const { rows, config } = recorder(); let calls = 0;
    await withBotTurnTrace(turn, async () => {
      const send = async () => { calls++; return "same"; };
      expect(await traceObserveSend("text", "private", "staff", send)).toBe("same");
      expect(await traceObserveSend("text", "private", "bot", send, { channel: "WHATSAPP", peer: "another-peer" })).toBe("same");
    }, config);
    expect(calls).toBe(2); expect(rows.at(-1)?.outgoing).toEqual([]);
  });
  it("widget availability is distinct from delivered/read", async () => {
    const { rows, config } = recorder();
    await withBotTurnTrace({ ...turn, channel: "WEBSITE" }, async () => traceWidgetAvailable("reply"), config);
    expect(rows.at(-1)?.outgoing[0].providerOutcome).toBe("available_to_widget");
  });
  it("records only actually persisted bot messages of the bound website conversation", async () => {
    const { rows, config } = recorder();
    await withBotTurnTrace({ ...turn, channel: "WEBSITE", conversation: "web-1" }, async () => {
      const messages = [{ role: "assistant", content: "Ответ", by: { kind: "bot" }, visibleAt: "2031-01-01T10:00:00.000Z" }];
      traceWebsiteMessagesPersisted("web-1", messages, 0);
      traceWebsiteMessagesPersisted("web-other", messages, 1);
      traceWebsiteMessagesPersisted("web-1", [{ role: "assistant", content: "Сотрудник", by: { kind: "agent" } }], 1);
      traceWebsiteMessagesPersisted("web-1", messages, 1);
    }, config);
    expect(rows.at(-1)?.outgoing).toHaveLength(1);
    expect(rows.at(-1)?.outgoing[0]).toMatchObject({ providerOutcome: "available_to_widget", stampOutcome: "success", visibleAt: "2031-01-01T10:00:00.000Z" });
  });
  it("missing MID and zero-row stamp remain missing while provider acceptance is retained", async () => {
    const { rows, config } = recorder();
    await withBotTurnTrace(turn, async () => {
      await traceObserveSend("text", "reply", "bot", async () => traceProviderAccepted(null)); traceStamp(null, "missing");
      await traceObserveSend("text", "reply2", "bot", async () => traceProviderAccepted("fake-mid2")); traceStamp("fake-mid2", "missing");
    }, config);
    expect(rows.at(-1)?.outgoing.map((part) => [part.providerOutcome, part.stampOutcome])).toEqual([["accepted", "missing"], ["accepted", "missing"]]);
  });
  it("does not let detached callbacks reopen a final snapshot", async () => {
    const { rows, config } = recorder(); let release!: () => void;
    const later = new Promise<void>((resolve) => { release = resolve; });
    let detached!: Promise<void>;
    await withBotTurnTrace(turn, async () => { detached = later.then(() => { traceOutcome("failed"); traceCheckpoint(); }); }, config);
    const count = rows.length; const final = rows.at(-1)!;
    release(); await detached;
    expect(rows).toHaveLength(count); expect(final.outcome).toBe("completed"); expect(final.completedAt).not.toBeNull();
  });
  it("explicit retry creates a fresh trace under an inherited closed parent", async () => {
    const { rows, config } = recorder(); let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; }); let retry!: Promise<void>;
    await withBotTurnTrace(turn, async () => {
      retry = pending.then(() => withBotTurnTrace({ ...turn, event: null, source: "ai_retry" }, async () => { traceBindConversation("retry-conversation"); }, config));
    }, config);
    const originalId = rows.at(-1)!.traceId;
    release(); await retry;
    const finals = rows.filter((row) => row.completedAt);
    expect(finals).toHaveLength(2); expect(finals[1].traceId).not.toBe(originalId);
    expect(finals[1].eventKey).toBeNull(); expect(finals[1].source).toBe("ai_retry");
  });
  it("deferred existing background task retains context without delaying foreground return", async () => {
    const { rows, config } = recorder(); let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const result = await withBotTurnTrace(turn, async () => { const background = pending.then(() => traceWidgetAvailable("later")); traceDeferUntil(background); return "ack"; }, config);
    expect(result).toBe("ack"); expect(rows.some((row) => row.completedAt)).toBe(false);
    release(); await pause(); expect(rows.at(-1)?.completedAt).not.toBeNull();
    expect(rows.at(-1)?.outgoing[0].providerOutcome).toBe("available_to_widget");
  });
  it("trace off, unsupported channel and failed writer preserve business results", async () => {
    const { rows, config } = recorder(); const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await withBotTurnTrace(turn, async () => "same", { ...config, enabled: false })).toBe("same");
    expect(await withBotTurnTrace({ ...turn, channel: "TELEGRAM" }, async () => "same", config)).toBe("same");
    expect(await withBotTurnTrace(turn, async () => "same", { ...config, secret: "too-short" })).toBe("same");
    expect(rows).toEqual([]);
    expect(await withBotTurnTrace(turn, async () => "same", { ...config, write: async () => { throw new Error("PRIVATE_STORAGE_ERROR"); } })).toBe("same");
    await pause(); warning.mockRestore();
  });
});

describe("bounded writer and ingress projection", () => {
  it("keeps TTL fixed at seven days across checkpoints", async () => {
    const { rows, config } = recorder();
    await withBotTurnTrace(turn, async () => { traceCheckpoint(); await pause(); traceCheckpoint(); }, config);
    expect(new Set(rows.map((row) => row.expiresAt)).size).toBe(1);
    expect(new Date(rows[0].expiresAt).getTime() - new Date(rows[0].createdAt).getTime()).toBe(7 * 86400000);
  });
  it("hung writes plus thousands of dropped checkpoints leave bounded tracked workers", async () => {
    const { rows, config } = recorder(); await withBotTurnTrace(turn, async () => {}, config);
    const blocked = new Promise<void>(() => {}); let tracked = 0; let dropped = 0;
    const queue = createTraceQueue(async () => blocked, () => { dropped++; }, 2, 2, () => { tracked++; });
    for (let i = 0; i < 1000; i++) queue.enqueue({ ...structuredClone(rows[0]), traceId: `00000000-0000-4000-8000-${String(i % 3).padStart(12, "0")}`, checkpointSeq: i });
    expect(queue.pendingTraces()).toBe(2); expect(tracked).toBe(2); expect(dropped).toBeGreaterThan(900);
  });
  it("keeps true completion order under coalescing and records dropped checkpoints", async () => {
    const { rows, config } = recorder(); await withBotTurnTrace(turn, async () => {}, config);
    let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; }); const seen: BotTurnTracePayload[] = [];
    const queue = createTraceQueue(async (row) => { seen.push(row); if (seen.length === 1) await pending; }, () => {}, 1, 1);
    for (let i = 1; i <= 4; i++) queue.enqueue({ ...structuredClone(rows[0]), checkpointSeq: i });
    release(); await queue.drain();
    expect(seen.map((row) => row.checkpointSeq)).toEqual([1, 4]); expect(seen.at(-1)?.checkpointGaps).toBe(2);
  });
  it("a late lower sequence cannot displace the terminal snapshot from a full queue", async () => {
    const { rows, config } = recorder(); await withBotTurnTrace(turn, async () => {}, config);
    let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; }); const seen: BotTurnTracePayload[] = [];
    const queue = createTraceQueue(async (row) => { seen.push(row); if (seen.length === 1) await pending; }, () => {}, 1, 1);
    const base = { ...structuredClone(rows[0]), completedAt: null };
    queue.enqueue({ ...base, checkpointSeq: 1 }); queue.enqueue({ ...base, checkpointSeq: 2 });
    queue.enqueue({ ...base, checkpointSeq: 5, completedAt: "2031-01-01T10:00:00.000Z" });
    queue.enqueue({ ...base, checkpointSeq: 3 }); queue.enqueue({ ...base, checkpointSeq: 6 });
    release(); await queue.drain();
    expect(seen.map((row) => row.checkpointSeq)).toEqual([1, 5]); expect(seen.at(-1)?.completedAt).not.toBeNull();
  });
  it("shows raw postback referral presence and normalized absence without copying payload", () => {
    const shape = projectBotIngressShape({ postback: { payload: "PRIVATE_PAYLOAD", referral: { ad_id: "PRIVATE_AD" } } }, null, false);
    expect(shape).toMatchObject({ postbackReferral: true, postbackPayload: true, normalizedReferral: false });
    expect(JSON.stringify(shape)).not.toContain("PRIVATE");
  });
  it("projects WA referral/reply-to and IG quick-reply/story metadata", () => {
    expect(projectBotIngressShape(null, { referral: {}, context: { id: "private" }, type: "audio", audio: {} }, true)).toMatchObject({ messageReferral: true, replyTo: true, attachments: 1 });
    expect(projectBotIngressShape({}, { quick_reply: { payload: "private" }, reply_to: { story: {} }, attachments: [{}] }, false)).toMatchObject({ quickReplyPayload: true, story: true, attachments: 1 });
  });
  it("WA text buttons are not media; actual images remain one attachment", () => {
    expect(projectBotIngressShape(null, { type: "button", button: { text: "Подробнее" } }, false).attachments).toBe(0);
    expect(projectBotIngressShape(null, { type: "image", image: { id: "fake-image" } }, false).attachments).toBe(1);
  });
  it("projects malformed reply shape without traversing unknown values", () => {
    expect(projectTraceModel({ reply: 17, ready: "yes", unexpected: new Proxy({}, { get() { throw Error("must not read"); } }) }, (v) => ({ present: !!v, chars: v.length }))).toMatchObject({ replyType: "other", readyType: "other" });
  });
  it("measures 200 synthetic turns on/off without changing mock model/send calls", async () => {
    async function measure(enabled: boolean) {
      const { rows, config } = recorder(); let models = 0; let sends = 0;
      const start = performance.now();
      for (let i = 0; i < 200; i++) {
        expect(await withBotTurnTrace({ ...turn, event: `fake-${i}` }, async () => {
          models++; const attempt = traceModelStart("gemini-unit", false);
          traceModelFinish(attempt, "parsed", performance.now(), { reply: ["Цена 1 221 000 сомони"], ready: false, confident: true });
          traceFilterDelta("reply_chain", "Цена 1 221 000 сомони", "Цена 1 221 000 сомони");
          return traceObserveSend("text", "Цена 1 221 000 сомони", "bot", async () => { sends++; traceProviderAccepted(`fake-mid-${i}`); return "same"; });
        }, { ...config, enabled })).toBe("same");
      }
      return { models, sends, ms: Number((performance.now() - start).toFixed(2)), rows: rows.length, maxBytes: Math.max(0, ...rows.map((row) => Buffer.byteLength(JSON.stringify(row)))) };
    }
    const off = await measure(false); const on = await measure(true);
    expect([off.models, off.sends, on.models, on.sends]).toEqual([200, 200, 200, 200]);
    expect(on.maxBytes).toBeLessThanOrEqual(32768);
    console.info("[bot-trace synthetic CPU-only; no DB/network]", JSON.stringify({ off, on }));
  });
});
