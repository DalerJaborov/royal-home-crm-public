import { describe, expect, it, vi } from "vitest";
import { isShortMapLink, mapPointFromUrl, parseMapPoint } from "@royal-home/shared";

/**
 * Точка из ссылки карты (packages/shared/src/mapPoint.ts, lib/mapLinkResolve.ts)
 * и права подбора клиентов под объект (lib/propertyMatchingClients.ts) — общие
 * двери мастера объекта в CRM и в Telegram (10.11.2026).
 */
const { findMatching } = vi.hoisted(() => ({ findMatching: vi.fn() }));
vi.mock("../src/routes/matching.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/routes/matching.js")>()),
  findMatchingClients: findMatching,
}));
const { resolveShortMapLink } = await import("../src/lib/mapLinkResolve.js");
const { matchingClientsForViewer } = await import("../src/lib/propertyMatchingClients.js");

describe("точка из текста и ссылки карты", () => {
  it("разбирает Google, Yandex (долгота первой) и координаты текстом", () => {
    expect(mapPointFromUrl("https://www.google.com/maps/place/X/@38.5612,68.7712,17z")).toEqual({ lat: 38.5612, lng: 68.7712 });
    expect(mapPointFromUrl("https://www.google.com/maps/place/X/@38.1,68.1,17z/data=!3d38.5613!4d68.7714")).toEqual({ lat: 38.5613, lng: 68.7714 });
    expect(mapPointFromUrl("https://maps.google.com/?q=38.55,68.77")).toEqual({ lat: 38.55, lng: 68.77 });
    expect(mapPointFromUrl("https://yandex.tj/maps/?ll=68.78,38.55&z=16")).toEqual({ lat: 38.55, lng: 68.78 });
    expect(mapPointFromUrl("https://yandex.ru/maps/?whatshere%5Bpoint%5D=68.79%2C38.56&z=17")).toEqual({ lat: 38.56, lng: 68.79 });
    expect(parseMapPoint("38.5598, 68.7870")).toEqual({ lat: 38.5598, lng: 68.787 });
    expect(parseMapPoint("Этаж 5 9")).toBeNull();
    expect(parseMapPoint("https://example.com/?q=38.55,68.77")).toBeNull();
    expect(isShortMapLink("https://maps.app.goo.gl/AbCd")).toBe(true);
    expect(isShortMapLink("https://evil.example/maps/-/x")).toBe(false);
  });

  it("короткая ссылка раскрывается только на хосты карт", async () => {
    const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
    const good = vi.fn(async () => redirect("https://www.google.com/maps/place/@38.57,68.78,17z"));
    expect(await resolveShortMapLink("https://maps.app.goo.gl/AbCd", good as unknown as typeof fetch)).toEqual({ lat: 38.57, lng: 68.78 });
    const evil = vi.fn(async () => redirect("http://169.254.169.254/latest?q=38.57,68.78"));
    expect(await resolveShortMapLink("https://maps.app.goo.gl/AbCd", evil as unknown as typeof fetch)).toBeNull();
    const never = vi.fn();
    expect(await resolveShortMapLink("https://evil.example/x", never as unknown as typeof fetch)).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });
});

describe("кому подходит объект: права как у CRM", () => {
  const client = (id: string, assignedAgentId: string | null) => ({
    id, shortId: 1, fullName: "Клиент +992 93 555 12 34", status: "NEW", score: 80, reasons: ["район"], assignedAgentId, assignedAgentName: null,
  });
  const viewer = (permissions: string[]) => ({ agent: { id: "me", permissions: new Set(permissions) } }) as never;

  it("руководство видит всех, агент — только своих; имя без права на телефон закрыто", async () => {
    findMatching.mockResolvedValue({ items: [client("a", "me"), client("b", "other"), client("c", null)], total: 3 });
    const all = await matchingClientsForViewer(viewer(["clients.viewAll", "clients.viewPhone"]), "p");
    expect(all.items.map(c => c.id)).toEqual(["a", "b", "c"]);
    expect(all.items[0].fullName).toContain("555 12 34");
    const own = await matchingClientsForViewer(viewer([]), "p");
    expect(own).toMatchObject({ total: 1, items: [{ id: "a" }] });
    expect(own.items[0].fullName).not.toContain("555 12 34");
  });
});
