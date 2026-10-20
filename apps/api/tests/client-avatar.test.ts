import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Источники профиля — реальные Meta/Telegram-вызовы здесь не нужны, только их
// результат (адрес фото или null). Сеть на скачивание самого файла мокается через
// global.fetch ниже — так же, как и обработка sharp, чтобы тест не зависел от
// настоящего изображения.
const fetchInstagramProfile = vi.fn(async () => ({}) as { profilePic?: string });
vi.mock("../src/messengers/meta.js", () => ({ fetchInstagramProfile }));

const getUserProfilePhotoUrl = vi.fn(async () => null as string | null);
vi.mock("../src/telegram/api.js", () => ({ getUserProfilePhotoUrl }));

const toFile = vi.fn(async () => undefined);
// cache/concurrency — глобальная настройка sharp в src/upload.ts (21.09.2026),
// вызывается при импорте модуля; без них муляж падает ещё до первого теста.
vi.mock("sharp", () => ({
  default: Object.assign(() => ({ resize: () => ({ webp: () => ({ toFile }) }) }), {
    cache: () => undefined,
    concurrency: () => 1,
  }),
}));

/**
 * К8 (аудит безопасности 11.09.2026): скачивание аватара теперь идёт через
 * `safeOpen` (lib/safeFetch.ts) — тот же рубеж SSRF-защиты, что и у вложений
 * мессенджеров. Он резолвит имя хоста в настоящий IP ДО вызова fetch, поэтому
 * выдуманный домен теста ("cdn.meta.example") без подмены DNS отбрасывался бы
 * ещё до того, как дошло бы до замоканного fetch. Подменяется именно резолвер,
 * а не сама проверка — тот же приём, что в tests/media-attachments.test.ts.
 */
vi.mock("node:dns/promises", () => ({
  default: { lookup: async () => [{ address: "93.184.216.34" }] },
}));

const { prisma } = await import("../src/db.js");
const { fetchAndStoreClientAvatarIfMissing } = await import("../src/lib/clientAvatar.js");

const runId = Date.now();
let clientId: string;

beforeAll(async () => {
  const client = await prisma.client.create({
    data: { fullName: "Клиент для аватара", phone: `+992979${runId}`, source: "INSTAGRAM", kind: "OTHER" },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.$disconnect();
});

afterEach(() => {
  vi.restoreAllMocks();
  fetchInstagramProfile.mockReset().mockResolvedValue({});
  getUserProfilePhotoUrl.mockReset().mockResolvedValue(null);
  toFile.mockReset().mockResolvedValue(undefined);
  vi.unstubAllGlobals();
});

describe("Аватар клиента — lib/clientAvatar.ts", () => {
  it("Instagram: скачивает profile_pic и сохраняет локальный путь на клиенте", async () => {
    fetchInstagramProfile.mockResolvedValue({ profilePic: "https://cdn.meta.example/pic.jpg?sig=abc" });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: new Headers(),
      arrayBuffer: async () => new ArrayBuffer(8),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAndStoreClientAvatarIfMissing(clientId, "INSTAGRAM", "179841000000");

    expect(fetchInstagramProfile).toHaveBeenCalledWith("179841000000");
    // safeOpen проверяет и передаёт в fetch объект URL, а не голую строку
    // (см. lib/safeFetch.ts::assertPublicUrl) — раньше здесь звал сам голый
    // fetch(url: string), теперь между ними встал разобранный и провалидированный адрес.
    expect(fetchMock).toHaveBeenCalledWith(new URL("https://cdn.meta.example/pic.jpg?sig=abc"), expect.anything());
    expect(result).toMatch(/^\/uploads\/avatars\/.+\.webp$/);

    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { avatarUrl: true } });
    expect(client!.avatarUrl).toBe(result);
  });

  it("уже есть avatarUrl — второй раз в сеть не ходит", async () => {
    fetchInstagramProfile.mockClear();
    const before = await prisma.client.findUnique({ where: { id: clientId }, select: { avatarUrl: true } });
    expect(before!.avatarUrl).toBeTruthy(); // от предыдущего теста

    const result = await fetchAndStoreClientAvatarIfMissing(clientId, "INSTAGRAM", "179841000000");
    expect(fetchInstagramProfile).not.toHaveBeenCalled();
    expect(result).toBe(before!.avatarUrl);
  });

  it("WhatsApp: Cloud API аватар не отдаёт — даже не пытаемся, ничего не падает", async () => {
    const fresh = await prisma.client.create({
      data: { fullName: "Клиент WA", phone: `+992978${runId}`, source: "WHATSAPP", kind: "OTHER" },
    });
    try {
      const result = await fetchAndStoreClientAvatarIfMissing(fresh.id, "WHATSAPP", "992900000000");
      expect(result).toBeNull();
      expect(fetchInstagramProfile).not.toHaveBeenCalled();
      expect(getUserProfilePhotoUrl).not.toHaveBeenCalled();
    } finally {
      await prisma.client.delete({ where: { id: fresh.id } });
    }
  });

  it("Telegram: профиль без фото — null, клиент без аватара, ничего не падает", async () => {
    const fresh = await prisma.client.create({
      data: { fullName: "Клиент TG", phone: `+992977${runId}`, source: "TELEGRAM", kind: "OTHER" },
    });
    try {
      getUserProfilePhotoUrl.mockResolvedValue(null);
      const result = await fetchAndStoreClientAvatarIfMissing(fresh.id, "TELEGRAM", "555666777");
      expect(getUserProfilePhotoUrl).toHaveBeenCalledWith("555666777");
      expect(result).toBeNull();
      const client = await prisma.client.findUnique({ where: { id: fresh.id }, select: { avatarUrl: true } });
      expect(client!.avatarUrl).toBeNull();
    } finally {
      await prisma.client.delete({ where: { id: fresh.id } });
    }
  });

  it("сбой скачивания не бросает наружу", async () => {
    const fresh = await prisma.client.create({
      data: { fullName: "Клиент сбой", phone: `+992976${runId}`, source: "INSTAGRAM", kind: "OTHER" },
    });
    try {
      fetchInstagramProfile.mockResolvedValue({ profilePic: "https://cdn.meta.example/broken.jpg" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: false, status: 404, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) }))
      );
      await expect(fetchAndStoreClientAvatarIfMissing(fresh.id, "INSTAGRAM", "1")).resolves.toBeNull();
    } finally {
      await prisma.client.delete({ where: { id: fresh.id } });
    }
  });

  it("файл крупнее потолка отклоняется — в sharp и на диск не попадает", async () => {
    // URL полудоверенный (ответ Graph), а буфер целиком ложится в память перед
    // sharp — потолок 10 МБ добавлен 26.08.2026 (единственный путь загрузки без лимита).
    const fresh = await prisma.client.create({
      data: { fullName: "Клиент огромного фото", phone: `+992975${runId}`, source: "INSTAGRAM", kind: "OTHER" },
    });
    try {
      fetchInstagramProfile.mockResolvedValue({ profilePic: "https://cdn.meta.example/huge.jpg" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          headers: new Headers({ "content-length": String(20 * 1024 * 1024) }),
          arrayBuffer: async () => new ArrayBuffer(8),
        }))
      );
      await expect(fetchAndStoreClientAvatarIfMissing(fresh.id, "INSTAGRAM", "2")).resolves.toBeNull();
      expect(toFile).not.toHaveBeenCalled();
    } finally {
      await prisma.client.delete({ where: { id: fresh.id } });
    }
  });

  it("нет subscriberId — сразу null, в сеть не ходим", async () => {
    fetchInstagramProfile.mockClear();
    const result = await fetchAndStoreClientAvatarIfMissing(clientId, "INSTAGRAM", null);
    expect(result).toBeNull();
    expect(fetchInstagramProfile).not.toHaveBeenCalled();
  });
});
