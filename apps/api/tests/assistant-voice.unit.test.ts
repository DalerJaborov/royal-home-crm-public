import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
let testCacheRoot: string;
const audioFixture = Buffer.from("OggS0000000000000000000000000000OpusHead00000000");
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { query, settings, sendVoice, sendVoiceId, fetchMock } = vi.hoisted(() => ({ query: vi.fn(), settings: vi.fn(), sendVoice: vi.fn(), sendVoiceId: vi.fn(), fetchMock: vi.fn() }));
vi.mock("../src/db.js", () => ({ prisma: { $queryRaw: query, settings: { findUnique: settings } } }));
vi.mock("../src/ai/liveVoiceProvider.js", () => ({ resolveElevenLabsKey: (key: string) => key }));
vi.mock("../src/telegram/api.js", () => ({ sendVoiceFile: sendVoice, sendAssistantVoiceId: sendVoiceId, TelegramApiError: class extends Error { constructor(public errorCode: number, _method: string, text: string) { super(text); } } }));
import { sendAssistantVoiceReply, speechTextFromReply } from "../src/telegram/assistantVoice.js";
import { TelegramApiError } from "../src/telegram/api.js";
import { assistantVoiceCacheKey, readAssistantVoiceCache, writeAssistantVoiceCache } from "../src/telegram/assistantVoiceCache.js";
import { claimAssistantTtsChars } from "../src/telegram/assistantVoiceBudget.js";
beforeEach(async () => {
  testCacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-voice-test-"));
  vi.stubEnv("PRIVATE_UPLOADS_DIR", testCacheRoot);
  sendVoiceId.mockReset().mockResolvedValue({});
  vi.clearAllMocks();
  query.mockReset().mockResolvedValue([{ count: 20 }]);
  settings.mockReset().mockResolvedValue({ elevenLabsApiKey: 'test-key' });
  sendVoice.mockReset().mockResolvedValue({});
  fetchMock.mockReset().mockResolvedValue({ ok: true, arrayBuffer: async () => Uint8Array.from(audioFixture).buffer });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('ELEVENLABS_API_KEY', 'test-key');
  vi.stubEnv('ASSISTANT_TTS_VOICE_ID', 'test-voice');
  vi.stubEnv('ASSISTANT_TTS_VOICE_ID_TG', '');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-bot');
  vi.stubEnv('ASSISTANT_TTS_DAILY_CHARS', '8000');
});
it('successful synthesis charges before fetch and sends audio', async () => { expect(await sendAssistantVoiceReply('test', 'Готово.')).toBe(true); const body = JSON.parse(fetchMock.mock.calls[0][1].body); expect(body.language_code).toBe('ru'); expect(body.model_id).toBe('eleven_v3'); expect(body.text).toBe('Готово.'); expect(query.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]); expect(sendVoice).toHaveBeenCalledTimes(1); });
it('budget exhausted prevents synthesis', async () => { query.mockResolvedValue([]); expect(await sendAssistantVoiceReply('test', 'Готово.')).toBe(false); expect(fetchMock).not.toHaveBeenCalled(); });
it('budget failure fails closed', async () => { query.mockRejectedValue(new Error('unavailable')); expect(await sendAssistantVoiceReply('test', 'Готово.')).toBe(false); expect(fetchMock).not.toHaveBeenCalled(); });
it('Tajik rejects before budget', async () => { expect(await sendAssistantVoiceReply('test', 'Салом, ман ёфтам.')).toBe(false); expect(query).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled(); });
it('missing voice avoids spending', async () => { vi.stubEnv('ASSISTANT_TTS_VOICE_ID', ''); expect(await sendAssistantVoiceReply('test', 'Готово.')).toBe(false); expect(query).not.toHaveBeenCalled(); });
it('missing key avoids spending', async () => { vi.stubEnv('ELEVENLABS_API_KEY', ''); settings.mockResolvedValue(null); expect(await sendAssistantVoiceReply('test', 'Готово.')).toBe(false); expect(query).not.toHaveBeenCalled(); });
it.each([429, 500])('HTTP %s leaves fallback', async (status) => { fetchMock.mockResolvedValue({ ok: false, status }); expect(await sendAssistantVoiceReply('test', 'Готово.')).toBe(false); expect(sendVoice).not.toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(1); });
it('transport error never synthesizes again', async () => { sendVoice.mockRejectedValue(new Error('timeout')); expect(await sendAssistantVoiceReply('test', 'Готово.')).toBe(false); expect(fetchMock).toHaveBeenCalledTimes(1); });
it('zero budget disables voice and rejects invalid amounts', async () => { vi.stubEnv('ASSISTANT_TTS_DAILY_CHARS', '0'); expect(await claimAssistantTtsChars(1)).toBe(false); expect(await claimAssistantTtsChars(-1)).toBe(false); expect(query).not.toHaveBeenCalled(); });
it('budget uses shared atomic reservations', async () => { await claimAssistantTtsChars(10); await claimAssistantTtsChars(12); for (const [sql] of query.mock.calls) {
  expect(sql.strings.join(' ')).toContain('assistant-tts-global');
  expect(sql.strings.join(' ')).toContain('ON CONFLICT');
  expect(sql.strings.join(' ')).toContain('EXCLUDED."count" <=');
} expect(query.mock.calls[0][0].values).toContain(10); expect(query.mock.calls[1][0].values).toContain(12); });
it('speech retains amounts and dates', () => expect(speechTextFromReply('Бюджет 1 200 000 сомони, дата 03-11-2026')).toContain('1 200 000 сомони, дата 03-11-2026'));

afterEach(async () => {
  if (!testCacheRoot.startsWith(path.join(os.tmpdir(), "assistant-voice-test-"))) throw new Error("Unsafe test cleanup path");
  await fs.rm(testCacheRoot, {recursive:true,force:true});
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
it("reuses Telegram file_id without spending TTS budget", async () => {
  sendVoice.mockResolvedValue({voice:{file_id:"test-file-id"}});
  expect(await sendAssistantVoiceReply("first-chat", "Готово.")).toBe(true);
  expect(await sendAssistantVoiceReply("second-chat", "Готово.")).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1); expect(query).toHaveBeenCalledTimes(1);
  expect(sendVoiceId).toHaveBeenCalledWith("second-chat", "test-file-id", undefined);
});
it("coalesces concurrent synthesis but sends to both chats", async () => {
  await Promise.all([sendAssistantVoiceReply("first", "Готово."), sendAssistantVoiceReply("second", "Готово.")]);
  expect(fetchMock).toHaveBeenCalledTimes(1); expect(sendVoice).toHaveBeenCalledTimes(2);
});
it("does not globally cache a business answer", async () => {
  await sendAssistantVoiceReply("first", "Цена квартиры 200 сомони.");
  await sendAssistantVoiceReply("second", "Цена квартиры 200 сомони.");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(await fs.readdir(testCacheRoot)).toEqual([]);
});
it("changing voice invalidates cache", async () => {
  await sendAssistantVoiceReply("first", "Готово."); vi.stubEnv("ASSISTANT_TTS_VOICE_ID", "test-new-voice");
  await sendAssistantVoiceReply("first", "Готово."); expect(fetchMock).toHaveBeenCalledTimes(2);
});
it("cache hit remains available after budget is exhausted", async () => {
  await sendAssistantVoiceReply("first", "Готово."); query.mockResolvedValue([]);
  expect(await sendAssistantVoiceReply("second", "Готово.")).toBe(true); expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("uses explicit Tajik voice with tg, never ru", async () => {
  vi.stubEnv("ASSISTANT_TTS_VOICE_ID_TG", "test-tajik-voice");
  expect(await sendAssistantVoiceReply("test", "Салом, ман ёфтам.")).toBe(true);
  expect(fetchMock.mock.calls[0][0]).toContain("test-tajik-voice");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).language_code).toBe("tg");
});
it("reuploads cached audio only after invalid file_id", async () => {
  sendVoice.mockResolvedValue({ voice: { file_id: "test-file-id" } });
  await sendAssistantVoiceReply("first", "Готово.");
  sendVoiceId.mockRejectedValue(new TelegramApiError(400, "sendVoice", "wrong file identifier"));
  expect(await sendAssistantVoiceReply("second", "Готово.")).toBe(true);
  expect(sendVoice).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledTimes(1);
});
it.each([new Error("timeout"), new TelegramApiError(429, "sendVoice", "Too Many Requests")])("does not reupload after uncertain or rate-limited send", async (error) => {
  sendVoice.mockResolvedValue({ voice: { file_id: "test-file-id" } });
  await sendAssistantVoiceReply("first", "Готово.");
  sendVoiceId.mockRejectedValue(error);
  expect(await sendAssistantVoiceReply("second", "Готово.")).toBe(false);
  expect(sendVoice).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("bot identity invalidates Telegram file cache", async () => {
  await sendAssistantVoiceReply("first", "Готово.");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-another-bot");
  await sendAssistantVoiceReply("second", "Готово.");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it("rejects expired, future and malformed cache entries", async () => {
  const key = assistantVoiceCacheKey("Готово.", {});
  for (const createdAt of [Date.now() - 31 * 24 * 60 * 60_000, Date.now() + 60_000]) {
    await writeAssistantVoiceCache(key, { createdAt, audio: audioFixture.toString("base64") });
    expect(await readAssistantVoiceCache(key)).toBeNull();
  }
  const cacheFile = path.join(testCacheRoot, "voice", "assistant-opus", `${key}.json`);
  await fs.writeFile(cacheFile, JSON.stringify({ createdAt: Date.now(), audio: "invalid%base64" }));
  expect(await readAssistantVoiceCache(key)).toBeNull();
  await fs.writeFile(cacheFile, "{broken json");
  expect(await readAssistantVoiceCache(key)).toBeNull();
});

it("rejects non-audio provider success without uploading", async () => {
  fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode("not audio").buffer });
  expect(await sendAssistantVoiceReply("test", "Готово.")).toBe(false);
  expect(sendVoice).not.toHaveBeenCalled();
});
it("regenerates valid-base64 but non-audio cached data", async () => {
  await sendAssistantVoiceReply("first", "Готово.");
  const cacheDir = path.join(testCacheRoot, "voice", "assistant-opus");
  const [name] = await fs.readdir(cacheDir);
  await fs.writeFile(path.join(cacheDir, name), JSON.stringify({ createdAt: Date.now(), audio: Buffer.from("garbage").toString("base64") }));
  expect(await sendAssistantVoiceReply("second", "Готово.")).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
