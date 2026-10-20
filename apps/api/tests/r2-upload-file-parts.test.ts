import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Файл с диска уходит в R2 частями, в память целиком не читается (аудит
 * 23.09.2026, №74). Видео сотрудника клиенту из переписки — до 300 МБ, а
 * процесс API живёт в 768 МБ. Сеть подменена: проверяется, какие запросы
 * уходят и какого размера тело у каждого.
 */

vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn().mockResolvedValue(undefined) }));

process.env.R2_ACCOUNT_ID = "acc-test";
process.env.R2_ACCESS_KEY_ID = "key-test";
process.env.R2_SECRET_ACCESS_KEY = "secret-test";

const { r2UploadFile, R2_FILE_PART_SIZE } = await import("../src/lib/r2Client.js");

type Call = { method: string; url: string; bytes: number };
let calls: Call[] = [];
let failPart: number | null = null;

async function bodyBytes(req: Request): Promise<number> {
  const buf = await req.arrayBuffer();
  return buf.byteLength;
}

const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url);
  const call = { method: req.method, url: url.pathname + url.search, bytes: await bodyBytes(req) };
  calls.push(call);
  if (req.method === "POST" && url.searchParams.has("uploads")) {
    return new Response("<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>", { status: 200 });
  }
  if (req.method === "PUT" && url.searchParams.has("partNumber")) {
    const n = Number(url.searchParams.get("partNumber"));
    // 403, а не 5xx: aws4fetch сам повторяет 5xx с паузами.
    if (failPart === n) return new Response("boom", { status: 403 });
    return new Response("", { status: 200, headers: { etag: `"etag-${n}"` } });
  }
  if (req.method === "POST" && url.searchParams.has("uploadId")) {
    return new Response("<CompleteMultipartUploadResult/>", { status: 200 });
  }
  if (req.method === "DELETE") return new Response("", { status: 204 });
  if (req.method === "PUT") return new Response("", { status: 200 });
  return new Response("unexpected", { status: 400 });
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-r2-file-"));
function makeFile(name: string, size: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(size, 1));
  return p;
}

beforeAll(() => vi.stubGlobal("fetch", fakeFetch));
afterEach(() => {
  calls = [];
  failPart = null;
  vi.restoreAllMocks();
});
afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("r2UploadFile", () => {
  it("крупный файл — частями не больше R2_FILE_PART_SIZE, без чтения целиком", async () => {
    const size = 2 * R2_FILE_PART_SIZE + 123;
    const file = makeFile("big.mp4", size);
    const readWhole = vi.spyOn(fs.promises, "readFile");

    await r2UploadFile("chat-media/c1/big.mp4", file, size, "video/mp4");

    expect(readWhole).not.toHaveBeenCalled();
    const parts = calls.filter((c) => c.method === "PUT" && c.url.includes("partNumber="));
    expect(parts.map((p) => p.bytes)).toEqual([R2_FILE_PART_SIZE, R2_FILE_PART_SIZE, 123]);
    expect(parts.every((p) => p.bytes <= R2_FILE_PART_SIZE)).toBe(true);
    const complete = calls.find((c) => c.method === "POST" && c.url.includes("uploadId="));
    expect(complete).toBeDefined();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("небольшой файл — одним запросом, как раньше", async () => {
    const file = makeFile("small.jpg", 1000);
    await r2UploadFile("chat-media/c1/small.jpg", file, 1000, "image/jpeg");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "PUT", bytes: 1000 });
  });

  it("сбой части — загрузка отменяется, ошибка уходит вызывающему", async () => {
    const size = 2 * R2_FILE_PART_SIZE;
    const file = makeFile("fail.mp4", size);
    failPart = 2;
    await expect(r2UploadFile("chat-media/c1/fail.mp4", file, size, "video/mp4")).rejects.toThrow();
    expect(calls.some((c) => c.method === "DELETE" && c.url.includes("uploadId=up-1"))).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.url.includes("uploadId=") && !c.url.includes("uploads"))).toBe(false);
  });
});
