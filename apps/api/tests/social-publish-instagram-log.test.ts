import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ОБ-000113 (21.09.2026): ролик ушёл в YouTube/Facebook/TikTok/Telegram, а в
 * Instagram — нет, и журнал ошибок остался ПУСТ — `instagramTokenIdentity`
 * отказал, но ветка publishApprovedPost клала результат в `results` и не звала
 * `logSystemError`, в отличие от соседней ветки (публикация упала уже ПОСЛЕ
 * того, как аккаунт опознан) и всех остальных четырёх каналов. Тест закрывает
 * именно эту тишину: отказ «не удалось определить аккаунт» обязан попасть в
 * журнал с номером объекта, чтобы карточка «На монтаже» не молчала всю ночь.
 */

const { logSystemError } = vi.hoisted(() => ({
  logSystemError: vi.fn(async () => {}),
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";

const { prisma } = await import("../src/db.js");
const { publishApprovedPost } = await import("../src/lib/socialPublish.js");
const { encryptSecret } = await import("../src/crypto.js");

const PROPERTY_ID = "prop-ob000113-test";

let savedSettings: Record<string, unknown>;

beforeEach(async () => {
  logSystemError.mockClear();
  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedSettings = {
    metaIgToken: current.metaIgToken,
    metaPageToken: current.metaPageToken,
    metaPageId: current.metaPageId,
    telegramChannelId: current.telegramChannelId,
    youtubeRefreshToken: current.youtubeRefreshToken,
    tiktokRefreshToken: current.tiktokRefreshToken,
  };
  // Только Instagram настроен — остальные четыре канала молча пропускаются
  // (не отказ, а «не подключён»), и в журнал попадёт ровно ОДНА запись, ту,
  // что и проверяем.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      metaIgToken: encryptSecret("fake-ig-token"),
      metaPageToken: null,
      metaPageId: null,
      telegramChannelId: null,
      youtubeRefreshToken: null,
      tiktokRefreshToken: null,
    },
  });
  // Сеть закрыта: Graph API отвечает отказом на любой запрос — так
  // instagramTokenIdentity получает identity.ok === false предсказуемо, без
  // похода в реальную Meta.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: { message: "Invalid OAuth access token" } }), { status: 400 }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.$disconnect();
});

describe("publishApprovedPost — отказ Instagram обязан попасть в журнал", () => {
  it("instagramTokenIdentity отказал — logSystemError вызван с номером объекта", async () => {
    const results = await publishApprovedPost({
      propertyId: PROPERTY_ID,
      localVideoPath: "/uploads/handoff/test-ob000113.mp4",
      caption: "Тестовый объект",
    });

    const igResult = results.find((r) => r.channel === "INSTAGRAM");
    expect(igResult?.ok).toBe(false);
    expect(igResult?.error).toContain("Не удалось определить аккаунт Instagram");

    expect(logSystemError).toHaveBeenCalledWith(
      "meta",
      expect.stringContaining(`Публикация в Instagram (объект ${PROPERTY_ID}) не удалась`)
    );
  });
});
