import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ZipArchive } from "archiver";

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "crm-archive-glob-"));
  await mkdir(path.join(directory, "nested"));
  await writeFile(path.join(directory, "one.txt"), "first synthetic file");
  await writeFile(path.join(directory, "nested", "two.txt"), "second synthetic file");
  await writeFile(path.join(directory, "skip.txt"), "excluded content");
  await writeFile(path.join(directory, ".private.txt"), "hidden content");
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe("archiver with patched minimatch", () => {
  it("preserves recursive matching, ignore patterns and file contents", async () => {
    const archive = new ZipArchive({ store: true });
    const chunks: Buffer[] = [];
    const complete = new Promise<Buffer>((resolve, reject) => {
      archive.on("data", chunk => chunks.push(chunk));
      archive.on("error", reject);
      archive.on("warning", reject);
      archive.on("end", () => resolve(Buffer.concat(chunks)));
    });
    archive.glob("**/*.txt", { cwd: directory, ignore: ["skip.*"] });
    await archive.finalize();
    const zip = await complete;
    expect(zip.subarray(0, 2).toString()).toBe("PK");
    for (const value of ["one.txt", "nested/two.txt", "first synthetic file", "second synthetic file"]) {
      expect(zip.includes(Buffer.from(value))).toBe(true);
    }
    for (const value of ["skip.txt", ".private.txt", "excluded content", "hidden content"]) {
      expect(zip.includes(Buffer.from(value))).toBe(false);
    }
  });
});
