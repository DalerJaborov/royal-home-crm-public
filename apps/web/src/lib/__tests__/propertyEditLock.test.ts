import { describe, expect, it } from "vitest";
import {
  PROPERTY_FIELDS_OPEN_AFTER_PUBLISH,
  PUBLISHED_PROPERTY_STATUSES,
  isPropertyPublished,
  propertyEditLocked,
} from "@royal-home/shared";

/**
 * Замок правки — одно правило на сервер и на кнопки сайта (владелец 07.10.2026):
 * до публикации агент правит, после — нет, кроме статуса; право
 * properties.editForeign и закрытый объект (offSite) не запираются.
 */
describe("propertyEditLocked", () => {
  it("до публикации (проверка, фото, видео, монтаж) агент не заперт", () => {
    for (const status of ["PENDING_REVIEW", "AWAITING_PHOTOS", "AWAITING_VIDEO", "EDITING"]) {
      expect(isPropertyPublished(status)).toBe(false);
      expect(propertyEditLocked({ status }, false)).toBe(false);
    }
  });

  it("после публикации агент заперт, руководство нет", () => {
    for (const status of PUBLISHED_PROPERTY_STATUSES) {
      expect(propertyEditLocked({ status }, false)).toBe(true);
      expect(propertyEditLocked({ status }, true)).toBe(false);
    }
  });

  it("закрытый объект публикации не имеет и не запирается", () => {
    expect(propertyEditLocked({ status: "AVAILABLE", offSite: true }, false)).toBe(false);
  });

  it("после публикации открыт только статус", () => {
    expect([...PROPERTY_FIELDS_OPEN_AFTER_PUBLISH]).toEqual(["status"]);
  });
});
