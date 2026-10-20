import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * «СНЯТЬ КАРУСЕЛИ И ИСТОРИИ» (02.10.2026). Сеть подменена (Graph API), база и
 * логика отбора — настоящие.
 */

const { loadCredentials } = vi.hoisted(() => ({
  loadCredentials: vi.fn(async () => ({ igToken: "ig", pageToken: "test-page-token", pageId: "page-1" })),
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  loadCredentials,
}));

const { instagramManageToken } = vi.hoisted(() => ({ instagramManageToken: vi.fn(async () => "manage-token" as string | null) }));
vi.mock("../src/lib/publishedVideoFix.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/publishedVideoFix.js")>()),
  instagramManageToken,
}));

const { prisma } = await import("../src/db.js");
const { removePropertyStories, countRemovableSocialExtras } = await import("../src/lib/socialExtrasRemoval.js");

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  const text = JSON.stringify(body);
  return { ok, status, json: async () => JSON.parse(text), text: async () => text } as unknown as Response;
}

const runId = Date.now().toString(36);
let districtId: string;
const propertyIds: string[] = [];
const realFetch = globalThis.fetch;

async function makeProperty() {
  const p = await prisma.property.create({
    data: { title: `Тест-снятие-${runId}-${propertyIds.length}`, type: "APARTMENT", rooms: 2, areaSqm: 60, price: 55000, currency: "USD", districtId, address: "Тестовая, 1", condition: "GOOD" },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Район-снятие-${runId}` } })).id;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  instagramManageToken.mockResolvedValue("manage-token");
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("removePropertyStories", () => {
  it("снимает живые истории Instagram и Facebook, строки удаляет; истёкшие (старше суток) не трогает", async () => {
    const p = await makeProperty();
    await prisma.propertyStoryPost.createMany({
      data: [
        { propertyId: p.id, channel: "INSTAGRAM", mediaId: "ig-1" },
        { propertyId: p.id, channel: "FACEBOOK", mediaId: "fb-1" },
        { propertyId: p.id, channel: "INSTAGRAM", mediaId: "ig-old", publishedAt: new Date(Date.now() - 40 * 3_600_000) },
      ],
    });
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url).split("?")[0].split("/").pop()}`);
      return jsonResponse({ success: true });
    }) as unknown as typeof fetch;

    expect(await countRemovableSocialExtras(p.id)).toEqual({ photoPosts: 0, reposts: 0, stories: 2 });
    const r = await removePropertyStories(p.id);
    expect(r.removed).toBe(2);
    expect(r.failed).toEqual([]);
    expect(calls.sort()).toEqual(["DELETE fb-1", "DELETE ig-1"]);
    const left = await prisma.propertyStoryPost.findMany({ where: { propertyId: p.id } });
    expect(left.map((x) => x.mediaId)).toEqual(["ig-old"]);
  });

  it("отказ Meta оставляет строку (повтор возможен) и попадает в failed", async () => {
    const p = await makeProperty();
    await prisma.propertyStoryPost.create({ data: { propertyId: p.id, channel: "FACEBOOK", mediaId: "fb-2" } });
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: { message: "boom", code: 190 } }, false, 400)) as unknown as typeof fetch;
    const r = await removePropertyStories(p.id);
    expect(r.removed).toBe(0);
    expect(r.failed).toHaveLength(1);
    expect(await prisma.propertyStoryPost.count({ where: { propertyId: p.id } })).toBe(1);
  });

  it("нет маркера удаления Instagram — история в списке «снять вручную», сеть не вызывается", async () => {
    const p = await makeProperty();
    await prisma.propertyStoryPost.create({ data: { propertyId: p.id, channel: "INSTAGRAM", mediaId: "ig-3" } });
    instagramManageToken.mockResolvedValue(null);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const r = await removePropertyStories(p.id);
    expect(r.manual).toHaveLength(1);
    expect(r.removed).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
