import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROXY_SINGLE_REQUEST_MAX_BYTES } from "@royal-home/shared";

vi.mock("../../store/auth", () => ({
  useAuthStore: { getState: () => ({ accessToken: "t", hasSession: false }) },
}));
vi.mock("../deviceId", () => ({ getOrCreateDeviceId: () => "device-1" }));
vi.mock("../api", () => ({ refreshAccessToken: async () => null }));

import { uploadConversationMedia, validateOutgoingMediaPick } from "../mediaUpload";
import { uploadClipVideo } from "../clipVideoUpload";
import { assertFitsSingleRequest, formDataFileBytes } from "../singleRequestLimit";
import { httpStatusMessage } from "../httpStatusMessage";
import { ApiError } from "../apiError";

/**
 * Класс «большой файл одним запросом → 413 от прокси» (17.11.2026): ролик карточки объекта и
 * файл в переписку едут частями через общие сессии; одиночные отправки проверяют вес до
 * отправки; 413 говорит человеку, что делать.
 */

class FakeXhr {
  static all: FakeXhr[] = [];
  method = "";
  url = "";
  body: unknown;
  headers: Record<string, string> = {};
  status = 0;
  responseText = "";
  withCredentials = false;
  upload: { onprogress?: (e: { loaded: number }) => void; onload?: () => void } = {};
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
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
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

/** Ответ на старт (план — две части по 2 байта) и на обе части. */
async function answerStartAndParts(expectStart: Record<string, unknown>) {
  await flush();
  expect(last().method).toBe("POST");
  expect(last().url).toBe("/api/v1/upload-sessions");
  expect(JSON.parse(last().body as string)).toEqual(expectStart);
  last().respond(201, { sessionId: "s1", partSize: 2, totalParts: 2 });
  await flush();
  for (const n of [1, 2]) {
    expect(last().method).toBe("PUT");
    expect(last().url).toBe(`/api/v1/upload-sessions/s1/parts/${n}`);
    last().respond(200, { ok: true });
    await flush();
  }
}

describe("загрузка частями: ролик карточки и файл в переписку", () => {
  beforeEach(() => {
    FakeXhr.all = [];
    vi.useFakeTimers();
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("ролик карточки: старт с назначением clip-video → части → сборка у объекта", async () => {
    const file = new File([new Uint8Array(4)], "tour.mp4", { type: "video/mp4" });
    const promise = uploadClipVideo("p1", file);
    await answerStartAndParts({ purpose: "clip-video", filename: "tour.mp4", sizeBytes: 4, contentType: "video/mp4" });
    expect(last().url).toBe("/api/v1/properties/p1/clip-video/upload-sessions/s1/complete");
    last().respond(202, { clipVideoStatus: "PROCESSING" });
    await expect(promise).resolves.toEqual({ clipVideoStatus: "PROCESSING" });
  });

  it("файл в переписку: id сессии и подпись в теле, ключ повтора — заголовком на сборке", async () => {
    const file = new File([new Uint8Array(4)], "a.jpg", { type: "image/jpeg" });
    const progress = vi.fn();
    const promise = uploadConversationMedia("c1", file, "Подпись", progress, "media:1");
    await answerStartAndParts({ purpose: "conversation-media", filename: "a.jpg", sizeBytes: 4, contentType: "image/jpeg" });
    const complete = last();
    expect(complete.url).toBe("/api/v1/conversations/c1/reply-media/upload-sessions/complete");
    expect(JSON.parse(complete.body as string)).toEqual({ sessionId: "s1", caption: "Подпись" });
    expect(complete.headers["Idempotency-Key"]).toBe("media:1");
    complete.respond(200, { ok: true, pausedUntil: "x" });
    await expect(promise).resolves.toMatchObject({ ok: true });
    expect(progress).toHaveBeenLastCalledWith(100);
  });

  it("часть упала 502 — повторяется сама", async () => {
    const file = new File([new Uint8Array(2)], "a.jpg", { type: "image/jpeg" });
    const promise = uploadConversationMedia("c1", file, undefined, () => {});
    await flush();
    last().respond(201, { sessionId: "s1", partSize: 2, totalParts: 1 });
    await flush();
    last().respond(502, {});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeXhr.all.filter((x) => x.method === "PUT")).toHaveLength(2);
    last().respond(200, { ok: true });
    await flush();
    last().respond(200, { ok: true, pausedUntil: "x" });
    await expect(promise).resolves.toMatchObject({ ok: true });
  });
});

describe("одиночная отправка: вес до отправки и понятный 413", () => {
  it("тяжелее потолка — отказ 413 сразу, текст с выходом; ровно потолок — можно", () => {
    const big = { size: PROXY_SINGLE_REQUEST_MAX_BYTES + 1 } as Blob;
    expect(() => assertFitsSingleRequest(big)).toThrow(ApiError);
    try {
      assertFitsSingleRequest([big]);
    } catch (err) {
      expect((err as ApiError).status).toBe(413);
      expect((err as Error).message).toMatch(/Сожмите файл или разделите/);
    }
    expect(() => assertFitsSingleRequest(PROXY_SINGLE_REQUEST_MAX_BYTES)).not.toThrow();
  });

  it("вес формы — только файлы", () => {
    const form = new FormData();
    form.append("title", "x".repeat(100));
    form.append("photos", new File([new Uint8Array(10)], "a.jpg"));
    form.append("photos", new File([new Uint8Array(5)], "b.jpg"));
    expect(formDataFileBytes(form)).toBe(15);
  });

  it("413 от прокси говорит, что делать, а не только «слишком большой»", () => {
    expect(httpStatusMessage(413)).toMatch(/Сожмите его или разделите/);
  });

  it("выбор файла в переписку: предел экрана совпадает с сервером (300 МБ, а не 1 ГБ)", () => {
    const mb = 1024 * 1024;
    const ok = { type: "video/mp4", size: 300 * mb } as File;
    const tooBig = { type: "video/mp4", size: 300 * mb + 1 } as File;
    expect(validateOutgoingMediaPick(ok, "INSTAGRAM")).toBeNull();
    expect(validateOutgoingMediaPick(tooBig, "INSTAGRAM")).toMatch(/300 МБ/);
  });
});
