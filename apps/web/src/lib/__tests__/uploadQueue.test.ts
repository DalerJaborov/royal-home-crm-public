import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * uploadQueue.ts тянет за собой zustand-стор сессии (persist → localStorage,
 * которого нет в этом окружении, environment: "node" — см. vitest.config.ts)
 * и общий api-клиент. Тест бьёт по чистой логике планировщика очереди —
 * `pickNextPendingTask`, `retryDelayMs`, `batchPhotos` — которая от них не
 * зависит, поэтому оба заглушены тем же приёмом, что и в aiSounds.test.ts.
 * vi.mock поднимается над импортами автоматически, поэтому обычный статический
 * импорт модуля ниже уже получает заглушки.
 */
vi.mock("../../store/auth", () => ({
  useAuthStore: {
    getState: () => ({ hasSession: false, accessToken: null }),
    subscribe: () => () => {},
  },
}));
vi.mock("../api", () => ({ api: vi.fn(), refreshAccessToken: vi.fn() }));
vi.mock("../queryClient", () => ({ queryClient: { invalidateQueries: vi.fn() } }));
vi.mock("../deviceId", () => ({ getOrCreateDeviceId: () => "test-device" }));

import {
  batchPhotos,
  enqueueVideos,
  getSnapshot,
  guardXhr,
  MAX_RETRY_ATTEMPTS,
  pickNextPendingTask,
  retryDelayMs,
  STALL_MS,
  STALLED_ERROR,
  type SendResult,
  type StoredTask,
} from "../uploadQueue";

function task(overrides: Partial<StoredTask> & Pick<StoredTask, "id" | "createdAt">): StoredTask {
  return {
    kind: "photo",
    propertyId: "prop-1",
    label: "фото",
    filenames: ["a.jpg"],
    uploadKeys: ["k1"],
    totalBytes: 1024,
    status: "pending",
    attempts: 0,
    error: null,
    ...overrides,
  } as StoredTask;
}

function fakeFile(name: string, size: number): File {
  return { name, size, type: "image/jpeg" } as unknown as File;
}

describe("uploadQueue: retryDelayMs — бэкофф с нарастанием, не дольше 5 минут", () => {
  it("растёт вдвое на каждой попытке: 5с, 10с, 20с…", () => {
    expect(retryDelayMs(1)).toBe(5_000);
    expect(retryDelayMs(2)).toBe(10_000);
    expect(retryDelayMs(3)).toBe(20_000);
    expect(retryDelayMs(4)).toBe(40_000);
  });

  it("не превышает потолок в 5 минут даже на поздних попытках", () => {
    expect(retryDelayMs(10)).toBe(5 * 60_000);
    expect(retryDelayMs(MAX_RETRY_ATTEMPTS)).toBe(5 * 60_000);
  });
});

describe("uploadQueue: pickNextPendingTask — бэкофф соблюдается, порядок «сначала без ошибок»", () => {
  const now = 1_000_000;

  it("не берёт задание, у которого nextAttemptAt ещё в будущем", () => {
    const backingOff = task({ id: "a", createdAt: 1, attempts: 2, nextAttemptAt: now + 60_000 });
    expect(pickNextPendingTask([backingOff], now)).toBeUndefined();
  });

  it("берёт задание, у которого nextAttemptAt уже наступил", () => {
    const dueNow = task({ id: "a", createdAt: 1, attempts: 2, nextAttemptAt: now - 1 });
    expect(pickNextPendingTask([dueNow], now)?.id).toBe("a");
  });

  it("задание без nextAttemptAt всегда доступно (ещё не пыталось уйти)", () => {
    const fresh = task({ id: "a", createdAt: 1, attempts: 0 });
    expect(pickNextPendingTask([fresh], now)?.id).toBe("a");
  });

  it("предпочитает задание без единой неудачной попытки задаче в бэкоффе — даже если она встала в очередь позже", () => {
    const retrying = task({ id: "old", createdAt: 1, attempts: 3, nextAttemptAt: now - 1 });
    const brandNew = task({ id: "new", createdAt: 2, attempts: 0 });
    expect(pickNextPendingTask([retrying, brandNew], now)?.id).toBe("new");
  });

  it("среди заданий одного приоритета выбирает более раннее по постановке в очередь", () => {
    const later = task({ id: "later", createdAt: 200, attempts: 0 });
    const earlier = task({ id: "earlier", createdAt: 100, attempts: 0 });
    expect(pickNextPendingTask([later, earlier], now)?.id).toBe("earlier");
  });

  it("игнорирует задания не в статусе pending", () => {
    const uploading = task({ id: "a", createdAt: 1, status: "uploading" });
    const failed = task({ id: "b", createdAt: 2, status: "failed" });
    expect(pickNextPendingTask([uploading, failed], now)).toBeUndefined();
  });
});

describe("uploadQueue: batchPhotos — обе границы пачки (6 файлов, 8 МБ)", () => {
  it("не режет пачку, пока не превышены ни число файлов, ни вес", () => {
    const files = [fakeFile("1.jpg", 1_000_000), fakeFile("2.jpg", 1_000_000)];
    expect(batchPhotos(files)).toEqual([files]);
  });

  it("режет по числу файлов даже при небольшом весе", () => {
    const files = Array.from({ length: 7 }, (_, i) => fakeFile(`${i}.jpg`, 100));
    const batches = batchPhotos(files);
    expect(batches.map((b) => b.length)).toEqual([6, 1]);
  });

  it("режет по весу даже при числе файлов меньше предела", () => {
    const MB = 1024 * 1024;
    const files = [fakeFile("a.jpg", 5 * MB), fakeFile("b.jpg", 5 * MB), fakeFile("c.jpg", 1 * MB)];
    const batches = batchPhotos(files, 6, 8 * MB);
    // a (5МБ) один; b (5МБ) не помещается вместе с a (было бы 10МБ > 8МБ) — новая пачка;
    // c (1МБ) добавляется к пачке с b (5+1=6 ≤ 8).
    expect(batches.map((b) => b.map((f) => f.name))).toEqual([["a.jpg"], ["b.jpg", "c.jpg"]]);
  });

  it("одиночный файл тяжелее предела всё равно уходит — в пачке из одного", () => {
    const MB = 1024 * 1024;
    const files = [fakeFile("huge.jpg", 20 * MB)];
    expect(batchPhotos(files, 6, 8 * MB)).toEqual([files]);
  });
});

/**
 * ОБРЫВ И ТИШИНА — то, из-за чего очередь вставала навсегда (21.09.2026).
 *
 * Проверяем не сеть, а договор `guardXhr`: обещание обязано ЗАКОНЧИТЬСЯ хоть
 * чем-нибудь. Пока оно висит, `run()` держит флаг `running`, и ни это задание,
 * ни следующие уже не уходят — ровно та картина, с которой пришёл владелец:
 * одно видео ушло, остальные повисли до перезагрузки страницы.
 */
function fakeXhr() {
  const xhr = {
    aborted: 0,
    onabort: null as null | (() => void),
    abort() {
      this.aborted++;
      this.onabort?.();
    },
  };
  return xhr as unknown as XMLHttpRequest & { aborted: number };
}

describe("uploadQueue: guardXhr — обещание всегда заканчивается", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("оборванный браузером запрос отдаёт обрыв связи, а не висит", () => {
    const xhr = fakeXhr();
    let result: SendResult | null = null;
    guardXhr(xhr, (r) => (result = r));

    xhr.abort();

    expect(result).toEqual({ status: 0, error: STALLED_ERROR });
  });

  it("молчание дольше сторожа рвёт запрос само", () => {
    const xhr = fakeXhr();
    let result: SendResult | null = null;
    const { beat } = guardXhr(xhr, (r) => (result = r));

    beat();
    vi.advanceTimersByTime(STALL_MS - 1);
    expect(result).toBeNull();

    vi.advanceTimersByTime(1);
    expect(xhr.aborted).toBe(1);
    expect(result).toEqual({ status: 0, error: STALLED_ERROR });
  });

  it("пока байты идут, сторож отодвигается и живую отдачу не убивает", () => {
    const xhr = fakeXhr();
    let result: SendResult | null = null;
    const { beat } = guardXhr(xhr, (r) => (result = r));

    // Десять минут медленной, но ЖИВОЙ отдачи: прогресс раз в полминуты.
    beat();
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(STALL_MS / 2);
      beat();
    }

    expect(result).toBeNull();
    expect(xhr.aborted).toBe(0);
  });

  it("обещание исполняется ровно один раз: ответ сервера побеждает поздний обрыв", () => {
    const xhr = fakeXhr();
    const results: SendResult[] = [];
    const { settle } = guardXhr(xhr, (r) => results.push(r));

    settle({ status: 201, error: null });
    xhr.abort();
    vi.advanceTimersByTime(STALL_MS * 2);

    expect(results).toEqual([{ status: 201, error: null }]);
  });

  it("исполненное обещание снимает сторожа — он не рвёт следующий запрос", () => {
    const xhr = fakeXhr();
    const results: SendResult[] = [];
    const { settle, beat } = guardXhr(xhr, (r) => results.push(r));

    beat();
    settle({ status: 200, error: null });
    vi.advanceTimersByTime(STALL_MS * 2);

    expect(xhr.aborted).toBe(0);
    expect(results).toHaveLength(1);
  });
});

describe("uploadQueue: хранилище отказало записать файл — задание не теряется", () => {
  // В окружении node IndexedDB нет вовсе: каждая запись в хранилище отказывает —
  // ровно как «Error preparing Blob/File data to be stored in object store» у
  // тяжёлого видео. Постановка в очередь обязана пройти, а не бросить ошибку.
  it("видео встаёт в очередь из памяти, когда IndexedDB не приняла файл", async () => {
    const file = new File([new Uint8Array(16)], "tour.mp4", { type: "video/mp4" });
    await expect(enqueueVideos("prop-1", [file], 118)).resolves.toBeUndefined();
    const queued = getSnapshot().tasks.find((t) => t.label === "tour.mp4");
    expect(queued).toBeDefined();
    expect(queued?.status).toBe("pending");
    expect(queued?.kind).toBe("video");
  });
});
