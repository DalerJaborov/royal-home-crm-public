import { describe, expect, it } from "vitest";
import {
  DEFAULT_REELS_CAPTION_TEMPLATES,
  fillReelsCaptionTemplate,
  parseReelsCaptionTemplates,
  rewriteCaptionFacts,
  type ReelsCaptionValues,
} from "../src/lib/reelsCaptionTemplate.js";

/**
 * ШАБЛОН ПОДПИСИ №5 НАЗЫВАЕТ ТИП ОБЪЕКТА (находка О8 проверки 02.10.2026).
 *
 * Заголовок был зашит словом: «🏛 Продаётся квартира:» — у дома, участка и
 * коммерции пост выходил с неверным первым словом, а строкой ниже стояло
 * «Тип недвижимости: дом». Подписи, вышедшие со старым заголовком, по-прежнему
 * узнаются при «Обновить подписи».
 */

const house: ReelsCaptionValues = {
  type: "дом",
  district: "Сино",
  rooms: "5",
  areaSqm: "180",
  floor: null,
  totalFloors: "2",
  condition: "хорошее состояние",
  price: "1 200 000 с.",
  phone: null,
  agentName: null,
  address: "Казокон",
  documents: "Сертификат",
  windowCount: null,
  bathroom: null,
  landAreaSotka: "4",
  marketType: null,
  amenities: null,
  hashtags: null,
};

const templateFive = () => parseReelsCaptionTemplates(DEFAULT_REELS_CAPTION_TEMPLATES).find((t) => t.startsWith("🏛"))!;

describe("Шаблон №5", () => {
  it("у дома заголовок «Продаётся дом», а не «квартира»", () => {
    const caption = fillReelsCaptionTemplate(templateFive(), house);
    expect(caption.split("\n")[0]).toBe("🏛 Продаётся дом:");
  });

  it("подпись, вышедшая со старым заголовком «Продаётся квартира», всё ещё переписывается целиком", () => {
    const oldTemplate = templateFive().replace("🏛 Продаётся {{type}}:", "🏛 Продаётся квартира:");
    const published = fillReelsCaptionTemplate(oldTemplate, house);
    const next = rewriteCaptionFacts(published, house, { ...house, rooms: "6" }, null);
    expect(next).not.toBeNull();
    expect(next).toContain("✅Количество комнат: 6");
    expect(next!.split("\n")[0]).toBe("🏛 Продаётся квартира:");
  });
});
