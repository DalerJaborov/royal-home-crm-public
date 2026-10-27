import { describe, expect, it, vi } from "vitest";
import { fetchSomonPhone } from "../src/lib/somonLeads/phone.js";

describe("Somon phone response", () => {
  it("reads an advert phone without logging it", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ phone: "+992900000000" }), { status: 200 }));
    expect(await fetchSomonPhone("123", request)).toBe("+992900000000");
    expect(request.mock.calls[0][0]).toBe("/api/items/get_phone/123/");
  });
  it("rejects arbitrary paths before making a request", async () => {
    const request = vi.fn();
    await expect(fetchSomonPhone("../other", request)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("fails closed on malformed responses and throttling", async () => {
    await expect(fetchSomonPhone("123", vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))).rejects.toThrow();
    await expect(fetchSomonPhone("123", vi.fn().mockResolvedValue(new Response('', { status: 429 })))).rejects.toThrow("429");
  });
});
