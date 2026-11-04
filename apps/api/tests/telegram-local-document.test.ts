import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: { $disconnect: vi.fn() } }));

describe("Telegram local document upload", () => {
  let fixture: string;
  let volume: string;
  let original: string;
  const contents = Buffer.from([0, 1, 10, 255]);
  const filename = "192_2из2.mov";

  beforeEach(async () => {
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-document-test-"));
    volume = path.join(fixture, "volume");
    original = path.join(fixture, "original.mov");
    await fs.mkdir(volume);
    await fs.writeFile(original, contents);
    vi.stubEnv("TELEGRAM_API_BASE_URL", "http://telegram-bot-api.test");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "fixture-token");
    vi.stubEnv("TELEGRAM_LOCAL_FILES_DIR", volume);
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fs.rm(fixture, { recursive: true, force: true });
  });

  it.each([false, true])("sends a shared file URI and retains it only on uncertain delivery (network failure: %s)", async (networkFailure) => {
    let staged: string | undefined;
    const telegram = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/sendChatAction")) return Response.json({ ok: true, result: true });
      expect(String(url)).toBe("http://telegram-bot-api.test/botfixture-token/sendDocument");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ chat_id: "123", document: expect.stringMatching(/^file:/), caption: "Объект №192" });
      staged = fileURLToPath(body.document);
      expect(path.dirname(path.dirname(staged))).toBe(volume);
      expect(path.basename(staged)).toBe(filename);
      expect(await fs.readFile(staged)).toEqual(contents);
      if (networkFailure) throw new TypeError("connection reset");
      return Response.json({ ok: true, result: { message_id: 5, document: { file_id: "doc" } } });
    });
    vi.stubGlobal("fetch", telegram);
    const { sendDocumentFile } = await import("../src/telegram/api.js");
    const upload = sendDocumentFile("123", { path: original }, filename, "Объект №192");
    if (networkFailure) {
      await expect(upload).rejects.toThrow("connection reset");
      expect(await fs.readFile(staged!)).toEqual(contents);
    } else {
      await expect(upload).resolves.toMatchObject({ message_id: 5, document: { file_id: "doc" } });
      expect(await fs.readdir(volume)).toEqual([]);
    }
    expect(telegram.mock.calls.filter(([url]) => String(url).endsWith("/sendDocument"))).toHaveLength(1);
    expect(await fs.readFile(original)).toEqual(contents);
  });
});
