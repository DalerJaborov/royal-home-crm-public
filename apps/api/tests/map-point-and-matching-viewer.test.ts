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
const { matchingClientsForViewer, matchingClientsForAssistant } = await import("../src/lib/propertyMatchingClients.js");

describe("точка из текста и ссылки карты", () => {
  it("разбирает Google, Yandex (долгота первой) и координаты текстом", () => {
    expect(mapPointFromUrl("https://www.google.com/maps/place/X/@38.5612,68.7712,17z")).toEqual({ lat: 38.5612, lng: 68.7712, approximate: true });
    expect(mapPointFromUrl("https://www.google.com/maps/place/X/@38.1,68.1,17z/data=!3d38.5613!4d68.7714")).toEqual({ lat: 38.5613, lng: 68.7714 });
    expect(mapPointFromUrl("https://maps.google.com/?q=38.55,68.77")).toEqual({ lat: 38.55, lng: 68.77 });
    expect(mapPointFromUrl("https://yandex.tj/maps/?ll=68.78,38.55&z=16")).toEqual({ lat: 38.55, lng: 68.78, approximate: true });
    expect(mapPointFromUrl("https://yandex.ru/maps/?ll=1,1&pt=68.7801,38.5702")).toEqual({ lat: 38.5702, lng: 68.7801 });
    // Перепутанная пара, которая так попадает в Таджикистан, — меняется местами.
    expect(parseMapPoint("68.7870, 38.5598")).toEqual({ lat: 38.5598, lng: 68.787 });
    // Одиночный «%» не роняет разбор.
    expect(mapPointFromUrl("https://www.google.com/maps/search/100%25/@38.5,68.7,12z?q=38.55,68.77%")).toMatchObject({ lat: 38.55, lng: 68.77 });
    // Только точный список хостов, https, без порта и логина.
    for (const bad of ["https://yandex.evil.com/maps/?pt=68.78,38.55", "https://google.evil.com/maps?q=38.55,68.77", "https://www.google.com:8443/maps?q=38.55,68.77",
      "https://user:pass@www.google.com/maps?q=38.55,68.77", "http://www.google.com/maps?q=38.55,68.77", "https://127.0.0.1/maps?q=38.55,68.77"]) {
      expect(mapPointFromUrl(bad)).toBeNull();
    }
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
    expect(await resolveShortMapLink("https://maps.app.goo.gl/AbCd", good as unknown as typeof fetch)).toMatchObject({ lat: 38.57, lng: 68.78 });
    const lookalike = vi.fn(async () => redirect("https://google.com.evil.example/maps?q=38.57,68.78"));
    expect(await resolveShortMapLink("https://maps.app.goo.gl/AbCd", lookalike as unknown as typeof fetch)).toBeNull();
    const evil = vi.fn(async () => redirect("http://169.254.169.254/latest?q=38.57,68.78"));
    expect(await resolveShortMapLink("https://maps.app.goo.gl/AbCd", evil as unknown as typeof fetch)).toBeNull();
    const never = vi.fn();
    expect(await resolveShortMapLink("https://evil.example/x", never as unknown as typeof fetch)).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });
});

describe("кому подходит объект: кто что видит", () => {
  const client = (id: string, assignedAgentId: string | null, assignedAgentName: string | null = null) => ({
    id, shortId: 1, fullName: "Клиент +992 93 555 12 34", status: "NEW", score: 80, reasons: ["район совпал", "чуть выше бюджета"], assignedAgentId, assignedAgentName,
  });
  const viewer = (permissions: string[]) => ({ agent: { id: "me", permissions: new Set(permissions) } }) as never;

  it("REST: все клиенты, имя без права на телефон закрыто", async () => {
    findMatching.mockResolvedValue({ items: [client("a", "me"), client("b", "other")], total: 2 });
    expect((await matchingClientsForViewer(viewer(["clients.viewAll", "clients.viewPhone"]), "p")).items[0].fullName).toContain("555 12 34");
    expect((await matchingClientsForViewer(viewer(["clients.viewAll"]), "p")).items[0].fullName).not.toContain("555 12 34");
  });

  it("помощник: агенту чужие — без имени, свои — отдельным запросом; руководству — все с именами", async () => {
    findMatching.mockImplementation(async (_p: string, _l: number, scope: { assignedAgentId?: string } = {}) => scope.assignedAgentId
      ? { items: [client("mine", "me")], total: 1 }
      : { items: [client("b", "other", "Умед"), client("c", null)], total: 7 });
    const agent = await matchingClientsForAssistant(viewer(["clients.viewPhone"]), "p");
    expect(agent.total).toBe(7);
    expect(agent.own).toMatchObject([{ clientId: "mine", own: true }]);
    expect(agent.own[0].name).toContain("Клиент");
    expect(agent.colleagues.map(c => [c.clientId, c.name, c.agentName])).toEqual([["b", null, "Умед"], ["c", null, null]]);
    expect(agent.colleagues[0].reasons).toEqual([{ text: "район совпал", tradeoff: false }, { text: "чуть выше бюджета", tradeoff: true }]);
    expect(JSON.stringify(agent.colleagues)).not.toContain("555");
    const boss = await matchingClientsForAssistant(viewer(["clients.viewAll", "clients.viewPhone"]), "p");
    expect(boss.colleagues[0].name).toContain("555 12 34");
  });
});
