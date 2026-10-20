import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../store/auth", () => ({
  useAuthStore: { getState: () => ({ accessToken: "t", hasSession: false }) },
}));
vi.mock("../deviceId", () => ({ getOrCreateDeviceId: () => "device-1" }));
vi.mock("../api", () => ({ refreshAccessToken: async () => null }));

import { RESPONSE_WAIT_MS, STALL_MS, uploadSocialVideo } from "../socialVideoUpload";

/**
 * После того как все байты ушли, сервер перепаковывает файл до 5 минут и только потом отвечает.
 * Сторож «нет движения байт 60 с» в это время обрывал загрузку и порождал дубль-черновик
 * (владелец 12.10.2026). Теперь сторож действует только ДО 100 %, а ответ ждём до 10 минут.
 */

class FakeXhr {
  static last: FakeXhr;
  status = 0;
  responseText = "";
  aborted = false;
  withCredentials = false;
  upload: { onprogress?: (e: { loaded: number; total: number; lengthComputable: boolean }) => void; onload?: () => void } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  constructor() {
    FakeXhr.last = this;
  }
  open() {}
  setRequestHeader() {}
  send() {}
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

function start(onUploaded = vi.fn()) {
  const onProgress = vi.fn();
  const promise = uploadSocialVideo({
    file: new File([new Uint8Array(4)], "promo.mp4", { type: "video/mp4" }),
    title: "Промо",
    caption: "",
    brief: "",
    channels: ["INSTAGRAM"],
    destinations: [{ channel: "INSTAGRAM", accountId: "ig-second" }],
    onProgress,
    onUploaded,
  });
  return { promise, onProgress, onUploaded, xhr: FakeXhr.last };
}

describe("загрузка свободного ролика: ожидание ответа сервера", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("тишина до 100 % — обрыв как раньше", async () => {
    const { promise, xhr } = start();
    xhr.upload.onprogress?.({ loaded: 1, total: 4, lengthComputable: true });
    const assertion = expect(promise).rejects.toThrow("Связь пропала");
    await vi.advanceTimersByTimeAsync(STALL_MS + 1);
    await assertion;
    expect(xhr.aborted).toBe(true);
  });

  it("после 100 % тишина дольше минуты — не обрыв: ждём ответ и получаем его", async () => {
    const { promise, xhr, onUploaded, onProgress } = start();
    xhr.upload.onprogress?.({ loaded: 4, total: 4, lengthComputable: true });
    xhr.upload.onload?.();
    expect(onUploaded).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenLastCalledWith(100);

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 30_000); // перепаковка идёт дольше STALL_MS
    expect(xhr.aborted).toBe(false);

    xhr.respond(201, { id: "v1", title: "Промо" });
    await expect(promise).resolves.toMatchObject({ id: "v1" });
  });

  it("сервер молчит дольше десяти минут — понятная ошибка с подсказкой про черновик", async () => {
    const { promise, xhr } = start();
    xhr.upload.onload?.();
    const assertion = expect(promise).rejects.toThrow("черновик мог создаться");
    await vi.advanceTimersByTimeAsync(RESPONSE_WAIT_MS + 1);
    await assertion;
    expect(xhr.aborted).toBe(true);
  });
});
