import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROXY_SINGLE_REQUEST_MAX_BYTES } from "@royal-home/shared";

vi.mock("../../store/auth", () => ({
  useAuthStore: { getState: () => ({ accessToken: "t", hasSession: false }) },
}));
vi.mock("../deviceId", () => ({ getOrCreateDeviceId: () => "device-1" }));
vi.mock("../api", () => ({ refreshAccessToken: async () => null }));
/** Сжатие на экране (canvas в jsdom нет): снимок «после сжатия» весит 2 МБ, если не помечен «несжимаемым». */
vi.mock("../compressImage", () => ({
  compressImage: async (f: File) => {
    if (f.name.startsWith("raw")) return f;
    const out = new File([new Uint8Array(1)], f.name, { type: "image/jpeg" });
    Object.defineProperty(out, "size", { value: 2 * 1024 * 1024 });
    return out;
  },
}));

import { uploadConversationMedia, validateOutgoingMediaPick } from "../mediaUpload";
import { uploadClipVideo } from "../clipVideoUpload";
import { uploadSocialVideo } from "../socialVideoUpload";
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

describe("отмена и повтор без повторной загрузки (ревью #254)", () => {
  beforeEach(() => {
    FakeXhr.all = [];
    vi.useFakeTimers();
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("«Отменить» посреди частей: оставшиеся части не уходят, сборка не зовётся", async () => {
    const { cancelConversationMediaUpload } = await import("../mediaUpload");
    const { UploadCancelledError } = await import("../chunkedUpload");
    const file = new File([new Uint8Array(4)], "a.mp4", { type: "video/mp4" });
    const promise = uploadConversationMedia("c1", file, undefined, () => {}, "media:x", "x");
    const assertion = expect(promise).rejects.toBeInstanceOf(UploadCancelledError);
    await flush();
    last().respond(201, { sessionId: "s1", partSize: 2, totalParts: 2 });
    await flush();
    expect(last().method).toBe("PUT");
    cancelConversationMediaUpload("x");
    await assertion;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeXhr.all.filter((x) => x.method === "PUT")).toHaveLength(1);
    expect(FakeXhr.all.some((x) => x.url.endsWith("/complete"))).toBe(false);
  });

  it("повтор после сбоя сборки — сразу сборка со старой сессией, файл заново не грузится", async () => {
    const file = new File([new Uint8Array(4)], "a.jpg", { type: "image/jpeg" });
    const first = uploadConversationMedia("c1", file, undefined, () => {}, "media:y", "y");
    const failed = expect(first).rejects.toThrow();
    await answerStartAndParts({ purpose: "conversation-media", filename: "a.jpg", sizeBytes: 4, contentType: "image/jpeg" });
    last().respond(502, {});
    await failed;

    FakeXhr.all = [];
    const second = uploadConversationMedia("c1", file, undefined, () => {}, "media:y", "y");
    await flush();
    expect(FakeXhr.all).toHaveLength(1);
    expect(last().url).toBe("/api/v1/conversations/c1/reply-media/upload-sessions/complete");
    expect(JSON.parse(last().body as string)).toEqual({ sessionId: "s1" });
    expect(last().headers["Idempotency-Key"]).toBe("media:y");
    last().respond(200, { ok: true, pausedUntil: "x" });
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it("повтор после обрыва части — докачиваются только недостающие части той же сессии", async () => {
    const file = new File([new Uint8Array(4)], "a.mp4", { type: "video/mp4" });
    const session = {};
    const first = uploadClipVideo("p1", file, undefined, session);
    const failed = expect(first).rejects.toThrow();
    await flush();
    last().respond(201, { sessionId: "s9", partSize: 2, totalParts: 2 });
    await flush();
    last().respond(200, { ok: true }); // часть 1 дошла
    await flush();
    last().respond(400, { error: "отказ" }); // часть 2 — отказ без повтора
    await failed;

    FakeXhr.all = [];
    const second = uploadClipVideo("p1", file, undefined, session);
    await flush();
    expect(last().url).toBe("/api/v1/properties/p1/clip-video/upload-sessions/s9/complete");
    last().respond(409, { code: "PARTS_MISSING", uploadedPartNumbers: [1] });
    await flush();
    expect(last().method).toBe("GET");
    expect(last().url).toBe("/api/v1/upload-sessions/s9");
    last().respond(200, { sessionId: "s9", partSize: 2, totalParts: 2, uploadedPartNumbers: [1] });
    await flush();
    expect(last().method).toBe("PUT");
    expect(last().url).toBe("/api/v1/upload-sessions/s9/parts/2");
    last().respond(200, { ok: true });
    await flush();
    expect(last().url).toBe("/api/v1/properties/p1/clip-video/upload-sessions/s9/complete");
    last().respond(202, { clipVideoStatus: "PROCESSING" });
    await expect(second).resolves.toEqual({ clipVideoStatus: "PROCESSING" });
    expect(FakeXhr.all.filter((x) => x.method === "PUT")).toHaveLength(1);
  });

  it("сессии больше нет (404) — начинаем заново", async () => {
    const file = new File([new Uint8Array(2)], "a.mp4", { type: "video/mp4" });
    const session = { sessionId: "gone" };
    const promise = uploadClipVideo("p1", file, undefined, session);
    await flush();
    last().respond(404, { error: "Загрузка не найдена" });
    await flush();
    expect(last().url).toBe("/api/v1/upload-sessions");
    last().respond(201, { sessionId: "s2", partSize: 2, totalParts: 1 });
    await flush();
    last().respond(200, { ok: true });
    await flush();
    last().respond(202, { clipVideoStatus: "PROCESSING" });
    await expect(promise).resolves.toEqual({ clipVideoStatus: "PROCESSING" });
    expect(session).toEqual({ sessionId: "s2" });
  });
});

describe("пачка и запас на разметку формы", () => {
  it("форма с файлом на килобайт меньше потолка не проходит: учтена разметка multipart", () => {
    const file = new File([new Uint8Array(1)], "a.jpg", { type: "image/jpeg" });
    Object.defineProperty(file, "size", { value: PROXY_SINGLE_REQUEST_MAX_BYTES - 1024 });
    const form = new FormData();
    form.append("photos", file);
    expect(formDataFileBytes(form)).toBe(PROXY_SINGLE_REQUEST_MAX_BYTES - 1024);
    expect(() => assertFitsSingleRequest(form)).toThrow(ApiError);
    // Тот же вес без формы (часть, а не multipart) — проходит.
    expect(() => assertFitsSingleRequest(PROXY_SINGLE_REQUEST_MAX_BYTES - 1024)).not.toThrow();
  });

  it("несколько файлов — текст про общий вес", () => {
    const parts = [{ size: 60 * 1024 * 1024 } as Blob, { size: 40 * 1024 * 1024 } as Blob];
    try {
      assertFitsSingleRequest(parts);
      throw new Error("не бросило");
    } catch (err) {
      expect((err as Error).message).toMatch(/Файлы весят вместе 100 МБ/);
    }
  });

  it("запас: 90 МБ файлов в форме — уже больше потолка", () => {
    const parts = [{ size: PROXY_SINGLE_REQUEST_MAX_BYTES - 1000 } as Blob];
    expect(() => assertFitsSingleRequest(parts)).toThrow(ApiError);
  });
});

describe("фото-пост соцсетей: 10 снимков по 20 МБ укладываются в один запрос", () => {
  beforeEach(() => {
    FakeXhr.all = [];
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
  });
  afterEach(() => vi.unstubAllGlobals());

  const photos = (prefix: string) =>
    Array.from({ length: 10 }, (_, i) => {
      const f = new File([new Uint8Array(1)], `${prefix}-${i}.jpg`, { type: "image/jpeg" });
      Object.defineProperty(f, "size", { value: 20 * 1024 * 1024 });
      return f;
    });
  const input = (list: File[]) => ({ photos: list, title: "Пост", caption: "", brief: "", channels: ["INSTAGRAM" as const], onProgress: () => {} });

  it("снимки сжимаются на экране — запрос уходит (2 МБ × 10)", async () => {
    const promise = uploadSocialVideo(input(photos("cam")));
    await vi.waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    expect(last().url).toBe("/api/v1/social-videos/photos");
    last().respond(201, { id: "post1" });
    await expect(promise).resolves.toMatchObject({ id: "post1" });
  });

  it("не сжались (200 МБ) — отказ сразу, текст про общий вес, запрос не уходит", async () => {
    await expect(uploadSocialVideo(input(photos("raw")))).rejects.toThrow(/Файлы весят вместе 200 МБ/);
    expect(FakeXhr.all).toHaveLength(0);
  });
});

