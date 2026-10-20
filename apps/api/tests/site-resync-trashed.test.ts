import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ДОСЫЛКА НА САЙТ ПОСЛЕ УДАЛЕНИЯ ОБЪЕКТА (22.09.2026).
 *
 * `runSiteResyncAttempt` — тело фонового задания site-resync: до пяти попыток
 * с откатом до 16 минут. За это время объект может уйти в Корзину, и тогда
 * досылка с действием "publish" ВЕРНУЛА БЫ его на публичную витрину
 * royalhome.tj — удаление снимает объект с сайта, но отметку publishedOnSite
 * намеренно не трогает (lib/trashProperty.ts), а проверка в задании была
 * только по ней. Докстринг функции при этом уже обещал «тихо завершается,
 * когда досылать нечего (объект удалён или снят с сайта)» — обещал, но не
 * делал.
 */

const { propertyFindUnique } = vi.hoisted(() => ({
  propertyFindUnique: vi.fn(async () => null as Record<string, unknown> | null),
}));

vi.mock("../src/db.js", () => ({
  prisma: { property: { findUnique: propertyFindUnique }, $disconnect: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn(async () => {}) }));

const siteSync = await import("../src/lib/siteSync.js");

/**
 * «Дошло до отправки» проверяем по самой отправке, а не подменой соседней
 * функции того же модуля (внутренний вызов подмену не заметил бы). В тестах
 * SITE_SYNC_URL не задан, поэтому дошедшая до отправки досылка честно падает
 * словами «Синхронизация с сайтом не настроена» — это и есть наблюдаемый
 * признак того, что проверки выше её не отсекли.
 */
const attemptedSend = (context: string) =>
  siteSync.runSiteResyncAttempt("prop-1", context).then(
    () => false,
    (err: unknown) => String(err).includes("не дошёл до сайта")
  );

const property = (overrides: Record<string, unknown> = {}) => ({
  id: "prop-1",
  publishedOnSite: true,
  deletedAt: null,
  // Досылка смотрит статус (D3, 02.10.2026): «живой опубликованный» — в продаже.
  status: "AVAILABLE",
  district: { name: "Сино", city: "Душанбе" },
  photos: [],
  ...overrides,
});

beforeEach(() => {
  propertyFindUnique.mockReset();
});

describe("runSiteResyncAttempt", () => {
  it("объект ушёл в Корзину, пока задание ждало очереди — на сайт ничего не уходит", async () => {
    propertyFindUnique.mockResolvedValue(property({ deletedAt: new Date() }));

    expect(await attemptedSend("фото изменены")).toBe(false);
  });

  it("живой опубликованный объект досылается как прежде", async () => {
    propertyFindUnique.mockResolvedValue(property());

    expect(await attemptedSend("фото изменены")).toBe(true);
  });

  it("объект снят с сайта — по-прежнему тихо ничего не делаем", async () => {
    propertyFindUnique.mockResolvedValue(property({ publishedOnSite: false }));

    expect(await attemptedSend("фото изменены")).toBe(false);
  });
});
