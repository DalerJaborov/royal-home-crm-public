import { describe, expect, it } from "vitest";
import { canMarkFacebookGroupShare } from "../groupShareAccess";

/**
 * «Выложено»/«Отменить» у раздачи по группам Facebook (глубокая проверка
 * 02.10.2026, F9). Сервер (routes/properties/groupShare.ts) пускает кабинет
 * маркетинга (MARKETING/DIRECTOR/ADMIN) или ХОЗЯИНА объекта —
 * intake ?? assigned ?? createdBy (lib/propertyOwner.ts). Экран показывал
 * кнопки по общему canEdit карточки: менеджеру и монтажёру с правом правки
 * чужих объектов и назначенному агенту при заполненном интейкере — сервер
 * отвечал им 403.
 */
const property = { intakeAgentId: "intake", assignedAgent: { id: "assigned" }, createdById: "creator" };

describe("canMarkFacebookGroupShare", () => {
  it("маркетинг, директор, админ — да", () => {
    for (const role of ["MARKETING", "DIRECTOR", "ADMIN"]) {
      expect(canMarkFacebookGroupShare(role, "кто-то", property)).toBe(true);
    }
  });
  it("хозяин объекта — интейкер, если он есть", () => {
    expect(canMarkFacebookGroupShare("AGENT", "intake", property)).toBe(true);
    expect(canMarkFacebookGroupShare("AGENT", "assigned", property)).toBe(false);
    expect(canMarkFacebookGroupShare("AGENT", "creator", property)).toBe(false);
  });
  it("без интейкера хозяин — назначенный агент, потом создатель", () => {
    expect(canMarkFacebookGroupShare("AGENT", "assigned", { ...property, intakeAgentId: null })).toBe(true);
    expect(
      canMarkFacebookGroupShare("AGENT", "creator", { intakeAgentId: null, assignedAgent: null, createdById: "creator" })
    ).toBe(true);
  });
  it("менеджер с правом правки чужих объектов, но не хозяин — нет", () => {
    expect(canMarkFacebookGroupShare("MANAGER", "кто-то", property)).toBe(false);
    expect(canMarkFacebookGroupShare("EDITOR", "кто-то", property)).toBe(false);
  });
});
