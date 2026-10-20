import { describe, expect, it } from "vitest";
import { propertyLink } from "../src/ai/leadQualifier.js";

/**
 * Посетителю чата НА САЙТЕ — ссылка на сайт, никогда на Instagram (найдено
 * 23.08.2026 живым диалогом: бот прислал ссылку на Reel вместо карточки).
 *
 * У Instagram/WhatsApp/Telegram правило прежнее: пост сильнее карточки, если он
 * есть и это правда Instagram-ссылка (см. isInstagramLink). Меняется только
 * канал WEBSITE — посетитель и так стоит на royalhome.tj, уводить его в другое
 * приложение на мёртвую (или живую, не важно) ссылку смысла нет.
 */
describe("propertyLink — канал определяет, куда ведёт ссылка", () => {
  const withInstagram = { id: "prop-1", publishedOnSite: true, instagramUrl: "https://www.instagram.com/reel/abc123/" };
  const withoutInstagram = { id: "prop-2", publishedOnSite: true, instagramUrl: null };
  const withTelegramLink = { id: "prop-3", publishedOnSite: true, instagramUrl: "https://t.me/c/12345/6" };

  it("канал сайта — всегда ссылка на карточку, даже если Instagram-пост есть", () => {
    expect(propertyLink(withInstagram, "WEBSITE")).toBe("https://royalhome.tj/listing/by-crm/prop-1");
  });

  it("Instagram/WhatsApp/без канала — прежнее поведение: пост сильнее карточки", () => {
    expect(propertyLink(withInstagram, "INSTAGRAM")).toBe(withInstagram.instagramUrl);
    expect(propertyLink(withInstagram, "WHATSAPP")).toBe(withInstagram.instagramUrl);
    expect(propertyLink(withInstagram)).toBe(withInstagram.instagramUrl);
  });

  it("нет Instagram-ссылки — карточка сайта независимо от канала", () => {
    expect(propertyLink(withoutInstagram, "INSTAGRAM")).toBe("https://royalhome.tj/listing/by-crm/prop-2");
    expect(propertyLink(withoutInstagram, "WEBSITE")).toBe("https://royalhome.tj/listing/by-crm/prop-2");
  });

  it("ссылка на Telegram в поле instagramUrl — не считается постом ни для какого канала", () => {
    expect(propertyLink(withTelegramLink, "INSTAGRAM")).toBe("https://royalhome.tj/listing/by-crm/prop-3");
    expect(propertyLink(withTelegramLink, "WEBSITE")).toBe("https://royalhome.tj/listing/by-crm/prop-3");
  });
});

describe("propertyLink — объект из админки сайта (ревизия 02.10.2026)", () => {
  // У такого объекта на сайте нет externalId, by-crm его не находит — была пустая страница.
  it("есть siteListingId — ссылка прямо на объявление, в любом канале", () => {
    const fromSiteAdmin = { id: "prop-9", publishedOnSite: true, instagramUrl: null, siteListingId: 118 };
    expect(propertyLink(fromSiteAdmin, "WEBSITE")).toBe("https://royalhome.tj/listing/118");
    expect(propertyLink(fromSiteAdmin, "INSTAGRAM")).toBe("https://royalhome.tj/listing/118");
  });
});

/**
 * ОБЪЕКТ НЕ С САЙТА (10.10.2026, решение владельца P0-5: «показывай, если в продаже и
 * есть публикация»). Страницы на сайте у него нет — by-crm вёл бы на пустую страницу.
 * Ссылка — его публикация в Instagram в любом канале; нет и её — ссылки нет вовсе.
 */
describe("propertyLink — объект с публикацией, но не на сайте", () => {
  const reelOnly = { id: "prop-20", publishedOnSite: false, instagramUrl: "https://www.instagram.com/reel/xyz/" };
  const nothing = { id: "prop-21", publishedOnSite: false, instagramUrl: null };
  const telegramOnly = { id: "prop-22", publishedOnSite: false, instagramUrl: "https://t.me/c/1/2" };

  it("ссылка — пост Instagram, даже в чате сайта", () => {
    expect(propertyLink(reelOnly, "WEBSITE")).toBe(reelOnly.instagramUrl);
    expect(propertyLink(reelOnly, "WHATSAPP")).toBe(reelOnly.instagramUrl);
  });

  it("ни сайта, ни поста Instagram — ссылки нет, by-crm не подставляется", () => {
    expect(propertyLink(nothing, "WEBSITE")).toBeNull();
    expect(propertyLink(nothing, "INSTAGRAM")).toBeNull();
    expect(propertyLink(telegramOnly, "WHATSAPP")).toBeNull();
  });
});
