import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * КРОССПОСТИНГ НА ПАРТНЁРСКИЕ СТРАНИЦЫ FACEBOOK (28.09.2026,
 * docs/agent-briefs/facebook-crosspost-28-09.md, lib/facebookCrosspost.ts).
 *
 * Три вещи проверяются: правильное тело запроса к Graph API
 * (allowCrosspostForPages), что запись в карточку не трогает соседние ключи
 * publishedPostIds (тот же класс бага, которого уже избегает writePendingMarker
 * в socialPublish.ts), и что пустой список партнёров не делает ни одного
 * запроса — «не настроено» не должно шуметь в журнале.
 */

const { logSystemError } = vi.hoisted(() => ({ logSystemError: vi.fn(async () => {}) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

process.env.SETTINGS_ENCRYPTION_KEY =
  process.env.SETTINGS_ENCRYPTION_KEY ?? "7e58774a6ca3f8f094b302efc65290b09ba8d51dacebdb60e8e693452f1ab810";

const { prisma } = await import("../src/db.js");
const { allowCrosspostForPages, crosspostAfterFacebookPublish } = await import("../src/lib/facebookCrosspost.js");

const runId = Date.now();

let districtId: string;
let propertyId: string;
let savedSettings: Record<string, unknown>;

async function postIds(): Promise<Record<string, unknown>> {
  const p = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, select: { publishedPostIds: true } });
  return (p.publishedPostIds ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-fb-crosspost-${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект FB crosspost ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
      },
    })
  ).id;

  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedSettings = {
    metaPageToken: current.metaPageToken,
    metaPageId: current.metaPageId,
    facebookCrosspostPageIds: current.facebookCrosspostPageIds,
  };
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { metaPageToken: "page-token", metaPageId: "111", facebookCrosspostPageIds: ["222", "333"] },
  });
});

beforeEach(async () => {
  await prisma.property.update({
    where: { id: propertyId },
    // Соседний ключ (пример: уже записанный FACEBOOK_POST) — на месте до и
    // после вызова, если тест его не трогал: см. «не трогает другие ключи» ниже.
    data: { publishedPostIds: { FACEBOOK: "fb-video-1", FACEBOOK_POST: "fb-post-1" } },
  });
  logSystemError.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("allowCrosspostForPages — тело запроса к Graph API", () => {
  it("уходит form-полем allow_crossposting_for_pages с JSON-массивом {page_id, allow}", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedBody = String(init?.body ?? "");
        return { ok: true, status: 200, json: async () => ({ success: true }) } as unknown as Response;
      })
    );

    const result = await allowCrosspostForPages("video-1", "page-token", ["222", "333"]);

    expect(result.ok).toBe(true);
    expect(capturedUrl).toBe("https://graph.facebook.com/v23.0/video-1");
    const params = new URLSearchParams(capturedBody);
    expect(params.get("access_token")).toBe("page-token");
    expect(JSON.parse(params.get("allow_crossposting_for_pages") ?? "[]")).toEqual([
      { page_id: "222", allow: true },
      { page_id: "333", allow: true },
    ]);
  });

  it("пустой список id — ни одного запроса", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await allowCrosspostForPages("video-1", "page-token", []);

    expect(result.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("отказ Graph API — ok:false с текстом ошибки", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "Недействительный OAuth-токен" } }) }) as unknown as Response)
    );

    const result = await allowCrosspostForPages("video-1", "bad-token", ["222"]);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Недействительный OAuth-токен");
  });
});

describe("crosspostAfterFacebookPublish — запись в карточку", () => {
  it("пишет FACEBOOK_CROSSPOST и не трогает другие ключи publishedPostIds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }) as unknown as Response)
    );

    await crosspostAfterFacebookPublish(propertyId, "video-1");

    const ids = await postIds();
    // Ровно тот класс бага, которого уже избегает writePendingMarker
    // (socialPublish.ts) — read-modify-write, а не перезапись всего объекта.
    expect(ids.FACEBOOK).toBe("fb-video-1");
    expect(ids.FACEBOOK_POST).toBe("fb-post-1");
    expect(ids.FACEBOOK_CROSSPOST).toMatchObject({ allowed: ["222", "333"] });
    expect(typeof (ids.FACEBOOK_CROSSPOST as { at: string }).at).toBe("string");
  });

  it("список партнёров пуст в настройках — ни одного запроса, ключ не пишется", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { facebookCrosspostPageIds: [] } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await crosspostAfterFacebookPublish(propertyId, "video-1");

    expect(fetchMock).not.toHaveBeenCalled();
    const ids = await postIds();
    expect(ids.FACEBOOK_CROSSPOST).toBeUndefined();

    await prisma.settings.update({ where: { id: "singleton" }, data: { facebookCrosspostPageIds: ["222", "333"] } });
  });

  it("отказ Graph API — одна запись в журнал через logSystemError, ключ не пишется", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "Страница не найдена" } }) }) as unknown as Response)
    );

    await crosspostAfterFacebookPublish(propertyId, "video-1");

    expect(logSystemError).toHaveBeenCalledTimes(1);
    const [source, message] = logSystemError.mock.calls[0];
    expect(source).toBe("meta");
    expect(message).toContain("Кросспостинг Facebook");
    expect(message).toContain(propertyId);
    const ids = await postIds();
    expect(ids.FACEBOOK_CROSSPOST).toBeUndefined();
  });
});
