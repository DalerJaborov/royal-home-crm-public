import { describe, expect, it } from "vitest";
import { maskOwnerContact, stripOwnerContact } from "../src/lib/ownerContact.js";

/**
 * Контакт собственника — самая ценная часть базы.
 *
 * Правило жило внутри routes/properties.ts, и любой другой маршрут, отдающий
 * объекты, обходил его молча. Один такой нашёлся: подбор объектов под клиента
 * (`GET /clients/:id/match`) возвращал карточки целиком — рядовому агенту хватало
 * собственного клиента с широким бюджетом, чтобы пачками вытаскивать телефоны
 * владельцев чужих объектов. Теперь правило одно на всю CRM и лежит отдельно.
 *
 * С 18.11.2026 (владелец: «кроме директора, ни у кого вообще не будет доступа к
 * номерам телефона вообще») решает ТОЛЬКО право properties.viewOwners: свой объект —
 * риелтор, интейкер, создатель карточки — номер больше не открывает.
 */

const contact = "+992 900 00 00 57";

describe("Кому виден телефон собственника", () => {
  it("с правом properties.viewOwners (директор) — виден", () => {
    expect(stripOwnerContact({ ownerContact: contact }, true).ownerContact).toBe(contact);
  });

  it("без права — закрыт, даже на своём объекте (риелтор, интейкер, создатель)", () => {
    for (const own of [{ assignedAgentId: "a1" }, { intakeAgentId: "a1" }, { createdById: "a1" }]) {
      const stripped = stripOwnerContact({ ownerContact: contact, ...own }, false);
      expect(stripped.ownerContact).toBeNull();
      expect(stripped.ownerContactHidden).toBe(true);
    }
  });

  it("исходная запись не портится — режется копия", () => {
    const p = { ownerContact: contact };
    stripOwnerContact(p, false);
    expect(p.ownerContact).toBe(contact);
  });
});

describe("ownerContactHidden — честный признак «скрыто», а не просто null", () => {
  it("с правом — false", () => {
    expect(stripOwnerContact({ ownerContact: contact }, true).ownerContactHidden).toBe(false);
  });

  it("без права — true, и когда номер пуст: менять его без права тоже нельзя", () => {
    expect(stripOwnerContact({ ownerContact: null }, false).ownerContactHidden).toBe(true);
  });
});

describe("maskOwnerContact — маска для того, кто ведёт объект", () => {
  it("каждый номер — +992 и две последние цифры, без начала номера", () => {
    expect(maskOwnerContact("900000057")).toBe("+992•••••57");
    expect(maskOwnerContact("+992 900 00 00 57, +992 911 11 11 23")).toBe("+992•••••57, +992•••••23");
  });

  it("ни одной цифры номера, кроме двух последних, в маске нет", () => {
    const masked = maskOwnerContact("+992 935 12 34 57") ?? "";
    expect(masked.replace(/\D/g, "")).toBe("99257");
  });

  it("пусто — null; обрывок без номера — подпись, а не цифры", () => {
    expect(maskOwnerContact(null)).toBeNull();
    expect(maskOwnerContact("   ")).toBeNull();
    expect(maskOwnerContact("звонить соседу 1234")).toBe("номер записан");
  });
});
