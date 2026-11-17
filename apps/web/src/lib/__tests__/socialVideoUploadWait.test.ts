import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../store/auth", () => ({
  useAuthStore: { getState: () => ({ accessToken: "t", hasSession: false }) },
}));
vi.mock("../deviceId", () => ({ getOrCreateDeviceId: () => "device-1" }));
vi.mock("../api", () => ({ refreshAccessToken: async () => null }));

import { PART_ATTEMPTS, RESPONSE_WAIT_MS, STALL_MS, uploadSocialVideo } from "../socialVideoUpload";

/**
 * Ролик едет ЧАСТЯМИ (17.11.2026): одним запросом файл 87 МБ получал 413 от прокси перед
 * сервером. Здесь: порядок шагов (старт → части → сборка), повтор упавшей части, и прежнее
 * правило ожидания — после того как все байты ушли, сервер перепаковывает файл до 5 минут,
 * обрывать по тишине в это время нельзя (дубль-черновик, владелец 12.10.2026).
 */

class FakeXhr {
  static all: FakeXhr[] = [];
  method = "";
  url = "";
  body: unknown;
  status = 0;
  responseText = "";
  aborted = false;
  withCredentials = false;
  upload: { onprogress?: (e: { loaded: number; total: number; lengthComputable: boolean }) => void; onload?: () => void } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  constructor() {
    FakeXhr.all.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader() {}
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  respond(status: number, body: unknown) {
    this.upload.onload?.();
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

const last = () => FakeXhr.all[FakeXhr.all.length - 1]!;
const flush = () => vi.advanceTimersByTimeAsync(0);

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
  return { promise, onProgress, onUploaded };
}

/** Старт сессии: план — две части по 2 байта. */
async function answerStart() {
  await flush();
  expect(last().method).toBe("POST");
  expect(last().url).toBe("/api/v1/social-videos/upload-sessions");
  expect(JSON.parse(last().body as string)).toEqual({ filename: "promo.mp4", sizeBytes: 4 });
  last().respond(201, { sessionId: "s1", partSize: 2, totalParts: 2 });
  await flush();
}

async function answerParts() {
  for (const n of [1, 2]) {
    expect(last().method).toBe("PUT");
    expect(last().url).toBe(`/api/v1/social-videos/upload-sessions/s1/parts/${n}`);
    expect((last().body as Blob).size).toBe(2);
    last().respond(200, { ok: true });
    await flush();
  }
}

describe("загрузка свободного ролика частями", () => {
  beforeEach(() => {
    FakeXhr.all = [];
    vi.useFakeTimers();
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("старт → части → сборка с полями формы", async () => {
    const { promise, onUploaded, onProgress } = start();
    await answerStart();
    await answerParts();
    expect(onUploaded).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenLastCalledWith(100);
    const complete = last();
    expect(complete.url).toBe("/api/v1/social-videos/upload-sessions/s1/complete");
    const fields = JSON.parse(complete.body as string);
    expect(fields).toMatchObject({ title: "Промо", channels: '["INSTAGRAM"]' });
    expect(JSON.parse(fields.destinations)).toEqual([{ channel: "INSTAGRAM", accountId: "ig-second" }]);
    complete.respond(201, { id: "v1" });
    await expect(promise).resolves.toMatchObject({ id: "v1" });
  });

  it("часть упала 502 — повторяется, ролик загружается", async () => {
    const { promise } = start();
    await answerStart();
    last().respond(502, {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(last().url).toBe("/api/v1/social-videos/upload-sessions/s1/parts/1");
    await answerParts();
    last().respond(201, { id: "v1" });
    await expect(promise).resolves.toMatchObject({ id: "v1" });
  });

  it("часть молчит каждый раз — после всех попыток понятная ошибка", async () => {
    const { promise } = start();
    await answerStart();
    const assertion = expect(promise).rejects.toThrow("Связь пропала");
    for (let i = 0; i < PART_ATTEMPTS; i++) await vi.advanceTimersByTimeAsync(STALL_MS + 10_000);
    await assertion;
  });

  it("отказ по смыслу (400) не повторяется", async () => {
    const { promise } = start();
    await answerStart();
    const assertion = expect(promise).rejects.toThrow("Размер части");
    last().respond(400, { error: "Размер части не совпадает с планом загрузки" });
    await assertion;
    expect(FakeXhr.all.filter((x) => x.method === "PUT")).toHaveLength(1);
  });

  it("после всех частей тишина дольше минуты — не обрыв: ждём сборку", async () => {
    const { promise } = start();
    await answerStart();
    await answerParts();
    const complete = last();
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 30_000);
    expect(complete.aborted).toBe(false);
    complete.respond(201, { id: "v1" });
    await expect(promise).resolves.toMatchObject({ id: "v1" });
  });

  it("сборка молчит дольше десяти минут — подсказка про черновик", async () => {
    const { promise } = start();
    await answerStart();
    await answerParts();
    const complete = last();
    complete.upload.onload?.();
    const assertion = expect(promise).rejects.toThrow("черновик мог создаться");
    await vi.advanceTimersByTimeAsync(RESPONSE_WAIT_MS + 1);
    await assertion;
    expect(complete.aborted).toBe(true);
  });
});
