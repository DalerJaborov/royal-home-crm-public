import { describe, expect, it } from "vitest";
import { stripOwnerContact } from "../src/lib/ownerContact.js";

/**
 * Контакт собственника — самая ценная часть базы.
 *
 * Правило жило внутри routes/properties.ts, и любой другой маршрут, отдающий
 * объекты, обходил его молча. Один такой нашёлся: подбор объектов под клиента
 * (`GET /clients/:id/match`) возвращал карточки целиком — рядовому агенту хватало
 * собственного клиента с широким бюджетом, чтобы пачками вытаскивать телефоны
 * владельцев чужих объектов. Теперь правило одно на всю CRM и лежит отдельно.
 */

const AGENT = "agent-1";
const OTHER = "agent-2";
const contact = "+992 900 00 00";

describe("Кому виден телефон собственника", () => {
  it("руководителю — по праву properties.viewAll", () => {
    const p = { ownerContact: contact, assignedAgentId: OTHER, intakeAgentId: OTHER, createdById: OTHER };
    expect(stripOwnerContact(p, AGENT, true).ownerContact).toBe(contact);
  });

  it("тому, кто ведёт объект сам — риелтору, интейкеру, создателю карточки", () => {
    expect(stripOwnerContact({ ownerContact: contact, assignedAgentId: AGENT }, AGENT, false).ownerContact).toBe(contact);
    expect(stripOwnerContact({ ownerContact: contact, intakeAgentId: AGENT }, AGENT, false).ownerContact).toBe(contact);
    expect(stripOwnerContact({ ownerContact: contact, createdById: AGENT }, AGENT, false).ownerContact).toBe(contact);
  });

  it("постороннему агенту — нет, и это главное правило", () => {
    const p = { ownerContact: contact, assignedAgentId: OTHER, intakeAgentId: OTHER, createdById: OTHER };
    expect(stripOwnerContact(p, AGENT, false).ownerContact).toBeNull();
  });

  it("исходная запись не портится — режется копия", () => {
    const p = { ownerContact: contact, assignedAgentId: OTHER };
    stripOwnerContact(p, AGENT, false);
    expect(p.ownerContact).toBe(contact);
  });
});

/**
 * `ownerContactHidden` (docs/TASKS.md, «дашборд агента против ТЗ» 07.09.2026):
 * `ownerContact: null` одинаково значит и «телефон не заполнен», и «скрыт
 * правом» — карточка объекта не могла отличить одно от другого и показывала
 * агенту на его собственном объекте «скрыто от вас», хотя сервер как раз
 * отдавал бы ему настоящий контакт. Флаг делает решение сервера видимым, а не
 * пересчитываемым второй раз на клиенте.
 */
describe("ownerContactHidden — честный признак «скрыто», а не просто null", () => {
  it("руководителю — false, даже когда объект чужой", () => {
    const p = { ownerContact: contact, assignedAgentId: OTHER, intakeAgentId: OTHER, createdById: OTHER };
    expect(stripOwnerContact(p, AGENT, true).ownerContactHidden).toBe(false);
  });

  it("тому, кто ведёт объект сам — false: контакт виден по-настоящему, не спрятан", () => {
    expect(stripOwnerContact({ ownerContact: contact, assignedAgentId: AGENT }, AGENT, false).ownerContactHidden).toBe(
      false
    );
  });

  it("постороннему агенту без права — true, а не просто пустой ownerContact", () => {
    const p = { ownerContact: contact, assignedAgentId: OTHER, intakeAgentId: OTHER, createdById: OTHER };
    const stripped = stripOwnerContact(p, AGENT, false);
    expect(stripped.ownerContact).toBeNull();
    expect(stripped.ownerContactHidden).toBe(true);
  });

  it("телефон правда не заполнен у того, кто и так его видит — false: это не скрытие", () => {
    const p = { ownerContact: null, assignedAgentId: AGENT };
    const stripped = stripOwnerContact(p, AGENT, false);
    expect(stripped.ownerContact).toBeNull();
    expect(stripped.ownerContactHidden).toBe(false);
  });
});
