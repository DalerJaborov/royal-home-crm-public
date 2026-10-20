import { describe, expect, it } from "vitest";
import { UPLOAD_VIDEO_MAX_BYTES, formatUploadLimit, partitionVideosByLimit } from "@royal-home/shared";
import { screenPickedVideos } from "../media";

const file = (name: string, size: number) => ({ name, size });

describe("screenPickedVideos — отсев выбранных роликов до очереди", () => {
  it("из трёх (малый, ровно предел, предел + 1) в очередь идут два, третий назван по имени", () => {
    const small = file("small.mov", 5 * 1024 * 1024);
    const atLimit = file("at-limit.mov", UPLOAD_VIDEO_MAX_BYTES);
    const over = file("IMG_9854.MOV", UPLOAD_VIDEO_MAX_BYTES + 1);
    const { accepted, note } = screenPickedVideos([small, atLimit, over]);
    expect(accepted).toEqual([small, atLimit]);
    expect(note).toContain("«IMG_9854.MOV»");
    expect(note).toContain(`предела ${formatUploadLimit()}`);
    expect(note).not.toContain("small.mov");
    expect(note).not.toContain("at-limit.mov");
  });

  it("проверяются ВСЕ выбранные, не только первый: каждый тяжёлый назван", () => {
    const { accepted, note } = screenPickedVideos([
      file("ok.mp4", 1024),
      file("big-1.mov", UPLOAD_VIDEO_MAX_BYTES + 10),
      file("big-2.mov", UPLOAD_VIDEO_MAX_BYTES * 2),
    ]);
    expect(accepted.map((f) => f.name)).toEqual(["ok.mp4"]);
    expect(note).toContain("«big-1.mov»");
    expect(note).toContain("«big-2.mov»");
  });

  it("всё годное — заметки нет", () => {
    const { accepted, note } = screenPickedVideos([file("a.mov", 746 * 1024 * 1024)]);
    expect(accepted).toHaveLength(1);
    expect(note).toBeNull();
  });
});

describe("общие помощники предела (packages/shared)", () => {
  it("подпись предела — «2 ГБ»", () => {
    expect(formatUploadLimit(UPLOAD_VIDEO_MAX_BYTES)).toBe("2 ГБ");
    expect(formatUploadLimit(700 * 1024 * 1024)).toBe("700 МБ");
  });

  it("partitionVideosByLimit: граница включительно", () => {
    const { accepted, rejected } = partitionVideosByLimit([file("a", 10), file("b", 11)], 10);
    expect(accepted.map((f) => f.name)).toEqual(["a"]);
    expect(rejected.map((f) => f.name)).toEqual(["b"]);
  });
});
