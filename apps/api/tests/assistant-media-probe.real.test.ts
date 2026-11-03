import { expect, it } from "vitest";
import sharp from "sharp";
import { inspectAssistantMedia } from "../src/ai/assistant/mediaProbe.js";

// Deterministic synthetic documents only; no CRM data, providers, DB or env setup.
function pdf(pages: number): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(" ")}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>")];
  let text = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  text += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}
function wav(seconds: number): Buffer {
  const bytes = seconds * 8_000 * 2;
  const buffer = Buffer.alloc(44 + bytes);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + bytes, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8_000, 24); buffer.writeUInt32LE(16_000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(bytes, 40);
  return buffer;
}
it("decodes a real local PNG", async () => {
  const buffer = await sharp({ create: { width: 16, height: 16, channels: 3, background: "white" } }).png().toBuffer();
  await expect(inspectAssistantMedia(buffer, "image/png")).resolves.toBeUndefined();
});
it("runs actual pdfinfo on a valid synthetic one-page PDF", async () => {
  await expect(inspectAssistantMedia(pdf(1), "application/pdf")).resolves.toBeUndefined();
});
it("rejects an actual 21-page PDF", async () => {
  await expect(inspectAssistantMedia(pdf(21), "application/pdf")).rejects.toThrow("media_pdf_limit");
});
it("runs actual ffprobe on a valid synthetic one-second WAV", async () => {
  await expect(inspectAssistantMedia(wav(1), "audio/wav")).resolves.toBeUndefined();
});
it("rejects an actual 121-second WAV", async () => {
  await expect(inspectAssistantMedia(wav(121), "audio/wav")).rejects.toThrow("media_audio_limit");
});
it("rejects corrupt audio without provider calls", async () => {
  await expect(inspectAssistantMedia(Buffer.from("not audio"), "audio/ogg")).rejects.toThrow("media_probe_unavailable");
});
