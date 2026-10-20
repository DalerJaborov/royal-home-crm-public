import { describe, expect, it } from "vitest";
import { describeDraftProgress } from "../draftProgressLabel";

const item = (kind: "photo" | "video", status: "queued" | "uploading" | "ready" | "failed" | "lost", loaded = 0, sizeBytes = 100) => ({
  kind,
  status,
  loaded,
  sizeBytes,
});

describe("describeDraftProgress: подпись единого индикатора", () => {
  it("«Видео 3 из 5 — 47%» считает по виду едущего файла", () => {
    const items = [
      item("photo", "ready"),
      item("video", "ready"),
      item("video", "ready"),
      item("video", "uploading", 47),
      item("video", "queued"),
      item("video", "queued"),
    ];
    expect(describeDraftProgress(items)).toBe("Видео 3 из 5 — 47%");
  });

  it("ничего не едет, но есть упавшие — говорит об этом, а не рисует проценты", () => {
    expect(describeDraftProgress([item("video", "failed"), item("photo", "lost")])).toBe("Не загрузилось 2 файла");
  });

  it("всё готово или пусто — подписи нет", () => {
    expect(describeDraftProgress([])).toBeNull();
    expect(describeDraftProgress([item("photo", "ready")])).toBeNull();
  });

  it("без едущего берёт первый ждущий", () => {
    expect(describeDraftProgress([item("photo", "ready"), item("photo", "queued")])).toBe("Фото 2 из 2 — 0%");
  });
});
