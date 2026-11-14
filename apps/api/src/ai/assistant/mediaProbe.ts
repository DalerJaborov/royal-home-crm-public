import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

function run(command: string, args: string[], maxBuffer = 65_536, timeout = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer, windowsHide: true, encoding: "utf8" },
      (error, stdout) => error ? reject(new Error("media_probe_unavailable")) : resolve(stdout));
  });
}

async function withTemporaryInput<T>(
  buffer: Buffer, name: "input.pdf" | "input.audio", operation: (path: string, directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "assistant-media-"));
  try {
    const path = join(directory, name);
    await writeFile(path, buffer, { mode: 0o600 });
    return await operation(path, directory);
  } finally {
    // Only the exact directory freshly created above; no user-controlled path components.
    await rm(directory, { recursive: true, force: true });
  }
}

async function checkPdf(path: string, maximumPages: number): Promise<number> {
  const info = await run("pdfinfo", [path]);
  const pages = Number(/^Pages:\s+(\d+)\s*$/m.exec(info)?.[1]);
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > maximumPages || !/^Encrypted:\s+no\s*$/m.test(info)) {
    throw new Error("media_pdf_limit");
  }
  return pages;
}

/** Текст страницы — не больше 256 КБ (таблица расходов, а не книга). */
const PDF_PAGE_TEXT_BYTES = 256 * 1024;

/**
 * Многостраничный PDF расходов (10.11.2026): число страниц и текстовый слой каждой страницы
 * (`pdftotext -layout` — колонки остаются колонками). Пустой текст — страница-скан, её читает ИИ
 * картинкой. Пароль, больше `maximumPages` страниц или подмена байтов — отказ до разбора.
 */
export function readExpensePdfText(buffer: Buffer, maximumPages: number): Promise<string[]> {
  validatePdfSignature(buffer);
  return withTemporaryInput(buffer, "input.pdf", async (path) => {
    const pages = await checkPdf(path, maximumPages);
    const texts: string[] = [];
    for (let page = 1; page <= pages; page++) {
      texts.push(await run("pdftotext", ["-f", String(page), "-l", String(page), "-layout", "-enc", "UTF-8", "-nopgbrk", path, "-"], PDF_PAGE_TEXT_BYTES));
    }
    return texts;
  });
}

/** Одна страница PDF картинкой для разбора ИИ (как одиночный чек: 2400 px, JPEG). */
export function renderExpensePdfPage(buffer: Buffer, page: number, maximumPages: number): Promise<Buffer> {
  validatePdfSignature(buffer);
  return withTemporaryInput(buffer, "input.pdf", async (path, directory) => {
    const pages = await checkPdf(path, maximumPages);
    if (!Number.isSafeInteger(page) || page < 1 || page > pages) throw new Error("media_pdf_limit");
    const output = join(directory, "page");
    // Плотная страница-скан рендерится дольше чека: 20 секунд, а не 5.
    await run("pdftoppm", ["-f", String(page), "-l", String(page), "-singlefile", "-cropbox", "-scale-to", "2400", "-jpeg", "-jpegopt", "quality=85", path, output], 65_536, 20_000);
    return readFile(`${output}.jpg`);
  });
}

function validatePdfSignature(buffer: Buffer): void {
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("media_invalid_pdf");
}

/** OCR only what the director can see on the page, with no hidden PDF text or metadata. */
export function renderExpenseReceiptPdf(buffer: Buffer): Promise<Buffer> {
  validatePdfSignature(buffer);
  return withTemporaryInput(buffer, "input.pdf", async (path, directory) => {
    await checkPdf(path, 1);
    const output = join(directory, "receipt");
    await run("pdftoppm", ["-f", "1", "-l", "1", "-singlefile", "-cropbox", "-scale-to", "2400", "-jpeg", "-jpegopt", "quality=85", path, output]);
    return readFile(`${output}.jpg`);
  });
}

/** Local, fail-closed inspection; never accepts a caller-controlled filesystem path. */
export async function inspectAssistantMedia(buffer: Buffer, mimeType: string, maxAudioSeconds = 120): Promise<void> {
  if (mimeType.startsWith("image/")) {
    const metadata = await sharp(buffer, { limitInputPixels: 20_000_000 }).metadata();
    const format = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" }[mimeType];
    if (metadata.format !== format || !metadata.width || !metadata.height
      || metadata.width * metadata.height > 20_000_000 || (metadata.pages ?? 1) !== 1) {
      throw new Error("media_invalid_image");
    }
    return;
  }
  if (mimeType === "application/pdf") {
    validatePdfSignature(buffer);
    await withTemporaryInput(buffer, "input.pdf", path => checkPdf(path, 20));
    return;
  }
  return withTemporaryInput(buffer, "input.audio", async path => {
    const info = JSON.parse(await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", path]));
    const duration = Number(info.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > maxAudioSeconds || !Array.isArray(info.streams)
      || !info.streams.length || info.streams.some((stream: { codec_type?: string }) => stream.codec_type !== "audio")) {
      throw new Error("media_audio_limit");
    }
  });
}
