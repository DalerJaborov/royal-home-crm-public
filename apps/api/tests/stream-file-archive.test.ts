import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { PassThrough } from "node:stream";

const state = vi.hoisted(() => ({ failRead: false }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, createReadStream: (...args: Parameters<typeof fs.createReadStream>) => {
    if (!state.failRead) return fs.createReadStream(...args);
    const stream = new PassThrough();
    process.nextTick(() => stream.destroy(new Error("read failed after stat")));
    return stream;
  } };
});
import { streamFileArchive } from "../src/lib/streamFileArchive.js";

let directory = "";
const errors: Error[] = [];
const app = express();
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/:file", (req, res) => streamFileArchive(res, [{ path: path.join(directory, req.params.file), name: "photo.txt" }], "photos.zip", 6, e => errors.push(e)));
beforeAll(async () => { directory = await mkdtemp(path.join(tmpdir(), "crm-archive-")); await writeFile(path.join(directory, "present"), "synthetic archive content"); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe("archive failures do not stop the server", () => {
  it("returns a useful error before sending ZIP headers for a missing file", async () => {
    const response = await request(app).get("/missing");
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("недоступен");
    expect(response.headers["content-disposition"]).toBeUndefined();
    expect((await request(app).get("/health")).body.ok).toBe(true);
  });
  it("handles a source read error after the existence check without an unhandled event", async () => {
    state.failRead = true;
    try {
      await request(app).get("/present").timeout(3000).then(response => expect(response.status).toBe(500), error => expect(String(error)).toMatch(/aborted|reset|socket/i));
      expect(errors.some(e => e.message === "read failed after stat")).toBe(true);
      expect((await request(app).get("/health")).body.ok).toBe(true);
    } finally { state.failRead = false; }
  });
  it("still downloads a valid ZIP after the failed requests", async () => {
    const response = await request(app).get("/present").buffer(true).parse((res, done) => {
      const chunks: Buffer[] = []; res.on("data", data => chunks.push(data)); res.on("end", () => done(null, Buffer.concat(chunks)));
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/zip");
    expect(response.body.subarray(0, 2).toString()).toBe("PK");
    expect(response.body.includes(Buffer.from("photo.txt"))).toBe(true);
  });
});
