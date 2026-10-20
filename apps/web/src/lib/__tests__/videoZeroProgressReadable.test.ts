import { describe, expect, it, vi } from "vitest";

/**
 * Два обрыва подряд без байта не делают исправный файл «нечитаемым» (аудит Codex
 * 04.10.2026, WEB-10). Так же выглядит отсутствие связи; нечитаемым файл
 * объявляется, только если кусок реально не читается.
 */
vi.mock("../../store/auth", () => ({
  useAuthStore: { getState: () => ({ hasSession: false, accessToken: null }), subscribe: () => () => {} },
}));
vi.mock("../api", () => ({ api: vi.fn(), refreshAccessToken: vi.fn() }));
vi.mock("../queryClient", () => ({ queryClient: { invalidateQueries: vi.fn() } }));
vi.mock("../deviceId", () => ({ getOrCreateDeviceId: () => "test-device" }));

import { isBlobReadable } from "../uploadFormat";
import { sendVideoTask, type SendResult, type StoredTask } from "../uploadQueue";

const task = { id: "t1", kind: "video", propertyId: "p1", filenames: ["a.mov"], uploadKeys: ["k1"], files: [{}] } as unknown as StoredTask;

const goodBlob = new Blob([new Uint8Array(200_000)]);
const brokenBlob = {
  size: 200_000,
  slice: () => ({ arrayBuffer: () => Promise.reject(new DOMException("not readable", "NotReadableError")) }),
} as unknown as Blob;

const dropped = (blob: Blob): SendResult => ({
  status: 0,
  error: "Связь пропала",
  zeroProgress: true,
  failedPartNumber: 3,
  failedPartBlob: blob,
});

describe("isBlobReadable", () => {
  it("исправный Blob читается, сломанный нет", async () => {
    await expect(isBlobReadable(goodBlob)).resolves.toBe(true);
    await expect(isBlobReadable(brokenBlob)).resolves.toBe(false);
  });
});

describe("sendVideoTask: два обрыва подряд на одной части", () => {
  it("читаемый кусок: остаётся статус 0 (ждём связь), а не синтетический 422", async () => {
    const upload = vi.fn().mockResolvedValue(dropped(goodBlob));
    expect((await sendVideoTask(task, () => {}, upload)).status).toBe(0);
    expect((await sendVideoTask(task, () => {}, upload)).status).toBe(0);
  });

  it("нечитаемый кусок: на втором обрыве 422", async () => {
    const t2 = { ...task, id: "t2" } as StoredTask;
    const upload = vi.fn().mockResolvedValue(dropped(brokenBlob));
    expect((await sendVideoTask(t2, () => {}, upload)).status).toBe(0);
    expect((await sendVideoTask(t2, () => {}, upload)).status).toBe(422);
  });
});
