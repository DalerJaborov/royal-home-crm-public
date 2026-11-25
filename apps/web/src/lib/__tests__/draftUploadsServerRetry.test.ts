import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Разбор 502 мастера 25.11.2026. Прокси перед API (Caddy, read_body 10s) обрывал часть
 * ролика на десятой секунде, телефон получал 502, а между отказами части всё же уходили:
 * IMG_0461.mov 23.11 — части 2 → 3 → 4 при «попытке 2/6 … 5/6». Очередь мастера считала
 * каждый отказ и на 6/6 сдавалась («Повторить» руками), хотя загрузка шла вперёд.
 * Здесь: ролик из 12 частей, каждый заход сервер принимает одну часть и отвечает 502
 * на следующую. Ролик обязан доехать сам, без кнопки.
 */
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../api", async (original) => ({ ...await original<typeof import("../api")>(), api: mocks.api }));
vi.mock("../mediaGps", async (original) => ({ ...await original<typeof import("../mediaGps")>(), readGpsFromFile: async () => null }));
vi.mock("../errorReporter", async (original) => ({ ...await original<typeof import("../errorReporter")>(), reportUploadIssue: vi.fn() }));
vi.mock("../draftUploadStore", async (original) => ({ ...await original<typeof import("../draftUploadStore")>(),
  putDraftFile: async () => {}, readAllDraftFiles: async () => [], deleteDraftFile: async () => {}, clearAllDraftFiles: async () => {},
}));

const PARTS = 12;
const PART_SIZE = 8;
const accepted = new Set<number>();
/** Какая по счёту часть ЗАХОДА рвётся (502): 2 — одна уходит, вторая рвётся; 1 — рвётся первая же. */
let cutOnSend = 2;
/** Частей, отправленных в текущем заходе (заход начинается с открытия сессии). */
let roundSends = 0;
/** Сколько частей ушло в сеть всего — по нему видно, что заход начался. */
let sends = 0;

class Upload {
  path = "";
  upload = {};
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  open(_method: string, path: string) { this.path = path; }
  setRequestHeader() {}
  abort() {}
  send() {
    sends++;
    roundSends++;
    const n = Number(/\/parts\/(\d+)$/.exec(this.path)?.[1]);
    queueMicrotask(() => {
      if (roundSends === cutOnSend) {
        this.status = 502; // так телефон видел обрыв прокси
      } else {
        accepted.add(n);
        this.status = 200;
        this.responseText = "{}";
      }
      this.onload?.();
    });
  }
}

const draftId = "00000000-0000-4000-8000-000000000001";
const view = () => ({ id: draftId, revision: 1, values: {}, step: 0, media: [], updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() });

beforeEach(() => {
  vi.resetModules();
  accepted.clear();
  cutOnSend = 2;
  roundSends = 0;
  sends = 0;
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) });
  vi.stubGlobal("XMLHttpRequest", Upload);
  mocks.api.mockReset();
  mocks.api.mockImplementation(async (path: string) => {
    if (path.endsWith("/videos/sessions")) {
      roundSends = 0;
      return { status: "in-progress", mediaId: "test-media", partSize: PART_SIZE, totalParts: PARTS, uploadedPartNumbers: [...accepted] };
    }
    if (path.endsWith("/complete")) return { id: "test-media" };
    return { draft: view(), revision: 1 };
  });
});
afterEach(async () => {
  (await import("../draftUploads")).clearDraftMedia();
  vi.unstubAllGlobals();
});

describe("очередь мастера: отказ сервера после принятой части не тратит попытки", () => {
  it("ролик, у которого части уходят через раз, доезжает сам — без кнопки «Повторить»", async () => {
    const { useAuthStore } = await import("../../store/auth");
    useAuthStore.setState({ agent: { id: "test-agent", fullName: "Тестовый агент", role: "AGENT", phone: "" }, accessToken: "test-local-token", hasSession: true });
    (await import("../propertyDraftSession")).adoptPropertyDraftSession({ draft: view(), revision: 1 });
    const queue = await import("../draftUploads");

    queue.addDraftVideos([new File([new Uint8Array(PARTS * PART_SIZE)], "test-video.mov", { type: "video/quicktime" })]);
    // Каждый заход: одна часть принята, следующая — 502. Двенадцать частей — больше
    // одиннадцати отказов подряд, прежняя очередь сдалась бы на шестом.
    let failures = 0;
    for (let round = 0; round < PARTS + 2; round++) {
      await roundSettled(queue);
      const item = queue.getDraftMediaSnapshot()[0];
      expect(item.status).not.toBe("failed");
      if (item.status === "ready") break;
      expect(item.errorKind).toBe("server");
      failures++;
      queue.resumeUploads(); // то же, что сердцебиение workGuard: не ждём паузу бэкоффа
    }
    expect(queue.getDraftMediaSnapshot()[0]?.status).toBe("ready");
    expect(accepted.size).toBe(PARTS);
    expect(failures).toBeGreaterThanOrEqual(PARTS - 1);
  });

  it("отказ без единой принятой части по-прежнему упирается в потолок и ждёт человека", async () => {
    cutOnSend = 1; // первая же часть захода рвётся каждый раз
    const { useAuthStore } = await import("../../store/auth");
    useAuthStore.setState({ agent: { id: "test-agent", fullName: "Тестовый агент", role: "AGENT", phone: "" }, accessToken: "test-local-token", hasSession: true });
    (await import("../propertyDraftSession")).adoptPropertyDraftSession({ draft: view(), revision: 1 });
    const queue = await import("../draftUploads");
    const { MAX_RETRY_ATTEMPTS } = await import("../uploadRetry");

    queue.addDraftVideos([new File([new Uint8Array(PARTS * PART_SIZE)], "test-video.mov", { type: "video/quicktime" })]);
    let rounds = 0;
    for (; rounds < MAX_RETRY_ATTEMPTS + 2; rounds++) {
      await roundSettled(queue);
      if (queue.getDraftMediaSnapshot()[0].status === "failed") break;
      queue.resumeUploads();
    }
    const item = queue.getDraftMediaSnapshot()[0];
    expect(item.status).toBe("failed");
    expect(item.errorKind).toBe("server");
    expect(rounds + 1).toBe(MAX_RETRY_ATTEMPTS);
    expect(accepted.size).toBe(0);
  });
});

/**
 * Находка 3 (25.11.2026): сердцебиение workGuard раз в 30 с звало resumeUploads(), а тот
 * стирал паузу у ВСЕХ ждущих — в том числе паузу после отказа сервера. 10 попыток
 * сгорали за ~5 минут вместо ~25. Теперь тик паузу не трогает, `online` снимает её только
 * у обрыва связи, а явное действие человека — у всех.
 */
describe("очередь мастера: пауза после отказа сервера не стирается сердцебиением", () => {
  it("heartbeat и online не будят файл раньше паузы сервера; явный повтор — будит", async () => {
    cutOnSend = 1; // каждый заход — 502 на первой же части
    const { useAuthStore } = await import("../../store/auth");
    useAuthStore.setState({ agent: { id: "test-agent", fullName: "Тестовый агент", role: "AGENT", phone: "" }, accessToken: "test-local-token", hasSession: true });
    (await import("../propertyDraftSession")).adoptPropertyDraftSession({ draft: view(), revision: 1 });
    const queue = await import("../draftUploads");

    queue.addDraftVideos([new File([new Uint8Array(PARTS * PART_SIZE)], "test-video.mov", { type: "video/quicktime" })]);
    await roundSettled(queue);
    expect(queue.getDraftMediaSnapshot()[0].errorKind).toBe("server");
    const after = sends;

    queue.resumeUploads("heartbeat");
    queue.resumeUploads("online");
    queue.resumeUploads("visible");
    await new Promise((r) => setTimeout(r, 50));
    expect(sends).toBe(after); // пауза сервера цела

    queue.resumeUploads(); // явное «продолжить» — пауза снимается
    await roundSettled(queue);
    expect(sends).toBeGreaterThan(after);
  });

  it("обрыв связи (статус 0): появление сети снимает паузу сразу", async () => {
    const { useAuthStore } = await import("../../store/auth");
    useAuthStore.setState({ agent: { id: "test-agent", fullName: "Тестовый агент", role: "AGENT", phone: "" }, accessToken: "test-local-token", hasSession: true });
    (await import("../propertyDraftSession")).adoptPropertyDraftSession({ draft: view(), revision: 1 });
    const queue = await import("../draftUploads");
    vi.stubGlobal("XMLHttpRequest", class extends Upload {
      send() {
        sends++;
        queueMicrotask(() => this.onerror?.()); // нет связи
      }
      onerror: (() => void) | null = null;
    });
    queue.addDraftVideos([new File([new Uint8Array(PARTS * PART_SIZE)], "test-video.mov", { type: "video/quicktime" })]);
    await roundSettled(queue);
    expect(queue.getDraftMediaSnapshot()[0].errorKind).toBe("net");
    const after = sends;
    queue.resumeUploads("heartbeat");
    await new Promise((r) => setTimeout(r, 50));
    expect(sends).toBe(after);
    queue.resumeUploads("online");
    await roundSettled(queue);
    expect(sends).toBeGreaterThan(after);
  });
});

/** Находка 4: сборка ролика мастера — со своим потолком у самого api(), а не общими 30 с. */
describe("очередь мастера: сборка ролика ждёт дольше общего предела api()", () => {
  it("POST …/complete уходит с timeoutMs = 120 с", async () => {
    cutOnSend = 99; // ни одного отказа
    const { useAuthStore } = await import("../../store/auth");
    useAuthStore.setState({ agent: { id: "test-agent", fullName: "Тестовый агент", role: "AGENT", phone: "" }, accessToken: "test-local-token", hasSession: true });
    (await import("../propertyDraftSession")).adoptPropertyDraftSession({ draft: view(), revision: 1 });
    const queue = await import("../draftUploads");
    queue.addDraftVideos([new File([new Uint8Array(PARTS * PART_SIZE)], "test-video.mov", { type: "video/quicktime" })]);
    await vi.waitFor(() => expect(queue.getDraftMediaSnapshot()[0]?.status).toBe("ready"));
    const complete = mocks.api.mock.calls.find(([path]) => String(path).endsWith("/complete"));
    expect(complete?.[1]).toMatchObject({ method: "POST", timeoutMs: 120_000 });
  });
});

/** Дождаться конца захода: в сеть ушла новая часть, и очередь уже не «грузит». */
async function roundSettled(queue: typeof import("../draftUploads")): Promise<void> {
  const before = sends;
  await vi.waitFor(() => {
    expect(sends).toBeGreaterThan(before);
    expect(queue.getDraftMediaSnapshot()[0]?.status).not.toBe("uploading");
  });
}
