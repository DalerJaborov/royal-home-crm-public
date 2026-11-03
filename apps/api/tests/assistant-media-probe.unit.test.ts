import { beforeEach, expect, it, vi } from "vitest";
const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execute }));
import sharp from "sharp";
import { inspectAssistantMedia } from "../src/ai/assistant/mediaProbe.js";
beforeEach(() => { vi.resetAllMocks(); });
function output(text: string) { execute.mockImplementation((_cmd, _args, _opts, callback) => callback(null, text)); }
it("accepts a decoded PNG and rejects a spoofed image MIME", async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
  await expect(inspectAssistantMedia(png, "image/png")).resolves.toBeUndefined();
  await expect(inspectAssistantMedia(png, "image/jpeg")).rejects.toThrow("media_invalid_image");
});
it.each(["Pages: 21\nEncrypted: no\n", "Pages: 1\nEncrypted: yes\n", "Pages: bad\nEncrypted: no\n"])("rejects PDF page/encryption bounds", async (info) => {
  output(info); await expect(inspectAssistantMedia(Buffer.from("%PDF-1.7"), "application/pdf")).rejects.toThrow("media_pdf_limit");
});
it("accepts bounded unencrypted PDF metadata", async () => {
  output("Pages: 20\nEncrypted: no\n");
  await expect(inspectAssistantMedia(Buffer.from("%PDF-1.7"), "application/pdf")).resolves.toBeUndefined();
  expect(execute.mock.calls[0][2]).toMatchObject({ timeout: 5000, windowsHide: true, maxBuffer: 65536 });
});
it.each([{ duration: "121", streams: [{ codec_type: "audio" }] }, { duration: "10", streams: [{ codec_type: "video" }] }, { duration: "N/A", streams: [{ codec_type: "audio" }] }, { duration: "1", streams: [] }])("rejects unsafe audio duration/streams", async ({ duration, streams }) => {
  output(JSON.stringify({ format: { duration }, streams }));
  await expect(inspectAssistantMedia(Buffer.from("audio"), "audio/ogg")).rejects.toThrow("media_audio_limit");
});
it("fails closed when the probe binary is unavailable", async () => {
  execute.mockImplementation((_cmd, _args, _opts, callback) => callback(new Error("ENOENT"), ""));
  await expect(inspectAssistantMedia(Buffer.from("audio"), "audio/ogg")).rejects.toThrow("media_probe_unavailable");
});
