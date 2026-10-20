import { describe, expect, it, vi } from "vitest";
import { siteListingUrl } from "../src/lib/siteListingUrl.js";

/** Публичная ссылка на объект — то, что уходит клиенту в мессенджер. */

describe("Ссылка на объект для клиента", () => {
  it("опубликованный из CRM — универсальный редирект by-crm, id объявления знать не нужно", () => {
    expect(
      siteListingUrl({ id: "0c9c2a1e-1111-2222-3333-444455556666", publishedOnSite: true, siteListingId: null })
    ).toBe("https://royalhome.tj/listing/by-crm/0c9c2a1e-1111-2222-3333-444455556666");
  });

  it("родившийся на сайте — прямая ссылка по его id: by-crm его не найдёт", () => {
    expect(siteListingUrl({ id: "any", publishedOnSite: true, siteListingId: 42 })).toBe(
      "https://royalhome.tj/listing/42"
    );
  });

  /**
   * Пустая SITE_PUBLIC_URL — не выдуманный случай: именно так переменная объявлена
   * в apps/api/.env.example, и на любом стенде, где .env скопирован с примера и не
   * дополнен, она приходит пустой строкой. С `??` пустая строка считалась заданным
   * значением, и клиенту в WhatsApp уходила ссылка «/listing/42» без домена — то
   * есть просто нерабочая. Поймано 02.08.2026 на чистой установке.
   */
  it("пустая SITE_PUBLIC_URL — это НЕ адрес: домен берётся по умолчанию", async () => {
    vi.stubEnv("SITE_PUBLIC_URL", "");
    vi.resetModules();
    const { siteListingUrl: withEmptyEnv } = await import("../src/lib/siteListingUrl.js");
    expect(withEmptyEnv({ id: "any", publishedOnSite: true, siteListingId: 42 })).toBe(
      "https://royalhome.tj/listing/42"
    );
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("не опубликован — ссылки нет вовсе", () => {
    expect(siteListingUrl({ id: "any", publishedOnSite: false, siteListingId: null })).toBeNull();
    // Даже если id на сайте известен: снятый с публикации объект недоступен посетителю.
    expect(siteListingUrl({ id: "any", publishedOnSite: false, siteListingId: 42 })).toBeNull();
  });
});
