import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { recruitmentDocxText } from "../src/lib/recruitmentDocumentText.js";
import { collectRecruitmentResume } from "../src/lib/recruitmentResume.js";

describe("uploaded Word résumé", () => {
  it("keeps original bytes and extracts literal candidate fields with document provenance", async () => {
    const original = await readFile(new URL("./fixtures/recruitment-resume.docx", import.meta.url));
    const before = Buffer.from(original);
    const text = await recruitmentDocxText(original);
    expect(original).toEqual(before);
    const resume = collectRecruitmentResume({ text, sourceEventKey: "a".repeat(64), sourceKind: "document" });
    expect(resume.facts.name).toMatchObject({ value: "Тестовый Кандидат", sourceKind: "document" });
    expect(resume.facts.experience?.value).toBe("Монтаж видео 2 года");
    expect(resume.facts.tools?.value).toBe("Premiere Pro, CapCut");
    expect(resume.facts.age).toBeUndefined();
  });
  it("rejects malformed and oversized archives without blocking the API", async () => {
    await expect(recruitmentDocxText(Buffer.from("not an archive"))).rejects.toThrow();
    await expect(recruitmentDocxText(Buffer.alloc(12 * 1024 * 1024 + 1))).rejects.toThrow("size");
  });
  it("rejects a small ZIP advertising an oversized expanded entry before parsing XML", async () => {
    const bytes = await readFile(new URL("./fixtures/recruitment-resume.docx", import.meta.url));
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(central).toBeGreaterThan(0);
    bytes.writeUInt32LE(17 * 1024 * 1024, central + 24);
    await expect(recruitmentDocxText(bytes)).rejects.toThrow();
  });
  it("does not replace a current candidate answer with an older uploaded résumé", () => {
    const previous = collectRecruitmentResume({ text: "Мне 29 лет", sourceEventKey: "a".repeat(64), sourceKind: "message" });
    const result = collectRecruitmentResume({ previous, text: "Возраст: 25", sourceEventKey: "b".repeat(64), sourceKind: "document" });
    expect(result.facts.age).toEqual(previous.facts.age);
  });
});
