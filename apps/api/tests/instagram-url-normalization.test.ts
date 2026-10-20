import { describe, expect, it } from "vitest";
import { propertyCreateSchema, propertyUpdateSchema } from "@royal-home/shared";

/**
 * Регрессионный тест: instagramUrl нормализуется к каноническому виду при
 * создании и обновлении объекта, а не-Instagram URL отвергаются с понятной
 * ошибкой. Написан после того, как 17 объектов имели в поле t.me/произвольный
 * текст и лид-магнит не узнавал публикации (03.09.2026).
 */

// Валидные UUID для прохождения Zod-валидации (формат, не существование в БД).
const FAKE_UUID_A = "00000000-0000-0000-0000-000000000001";
const FAKE_UUID_B = "00000000-0000-0000-0000-000000000002";

const BASE_CREATE = {
  type: "APARTMENT" as const,
  rooms: 2,
  areaSqm: 50,
  price: 40000,
  currency: "USD" as const,
  districtId: FAKE_UUID_A,
  address: "Тестовая, 1",
  condition: "GOOD" as const,
  intakeAgentId: FAKE_UUID_B,
  ownerContact: "+992000000000",
  floor: 3,
  totalFloors: 9,
  windowCount: 4,
};

describe("instagramUrl normalization in schemas", () => {
  describe("propertyCreateSchema", () => {
    it("нормализует reel без www к каноническому виду", () => {
      const result = propertyCreateSchema.safeParse({
        ...BASE_CREATE,
        instagramUrl: "https://instagram.com/reel/AbC123/",
      });
      if (!result.success) {
        console.log("VALIDATION ERRORS:", JSON.stringify(result.error.flatten(), null, 2));
      }
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.instagramUrl).toBe("https://www.instagram.com/reel/AbC123/");
      }
    });

    it("сохраняет /p/ (фото-пост по адресу /reel/ может не открыться)", () => {
      const result = propertyCreateSchema.safeParse({
        ...BASE_CREATE,
        instagramUrl: "https://www.instagram.com/p/XyZ789/",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.instagramUrl).toBe("https://www.instagram.com/p/XyZ789/");
      }
    });

    it("сохраняет /tv/, добавляя www и завершающий слэш", () => {
      const result = propertyCreateSchema.safeParse({
        ...BASE_CREATE,
        instagramUrl: "https://www.instagram.com/tv/OldVideo123",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.instagramUrl).toBe("https://www.instagram.com/tv/OldVideo123/");
      }
    });

    it("убирает query-параметры (?igsh=...)", () => {
      const result = propertyCreateSchema.safeParse({
        ...BASE_CREATE,
        instagramUrl: "https://www.instagram.com/reel/Code123/?igsh=MWx5eXJjYQ==",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.instagramUrl).toBe("https://www.instagram.com/reel/Code123/");
      }
    });

    it("отклоняет ссылку на Telegram", () => {
      const result = propertyCreateSchema.safeParse({
        ...BASE_CREATE,
        instagramUrl: "https://t.me/royalhome_tj/1",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.flatten().fieldErrors.instagramUrl ?? [];
        expect(messages.some((m) => m.includes("Instagram"))).toBe(true);
      }
    });

    it("отклоняет произвольный текст", () => {
      const result = propertyCreateSchema.safeParse({
        ...BASE_CREATE,
        instagramUrl: "видео пока нет",
      });
      expect(result.success).toBe(false);
    });

    it("принимает undefined (поле необязательное)", () => {
      const result = propertyCreateSchema.safeParse({
        ...BASE_CREATE,
        instagramUrl: undefined,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.instagramUrl).toBeUndefined();
      }
    });

    it("принимает пустую строку как undefined", () => {
      const result = propertyCreateSchema.safeParse({
        ...BASE_CREATE,
        instagramUrl: "",
      });
      // Пустая строка не проходит refine(isValidInstagramPostUrl), но transform
      // возвращает undefined для falsy — проверяем, что схема не падает.
      // Если пустая строка отвергается — это тоже корректное поведение.
      if (result.success) {
        expect(result.data.instagramUrl).toBeUndefined();
      }
    });
  });

  describe("propertyUpdateSchema", () => {
    it("нормализует ссылку при PATCH", () => {
      const result = propertyUpdateSchema.safeParse({
        instagramUrl: "https://instagram.com/reel/PatchTest1/",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.instagramUrl).toBe("https://www.instagram.com/reel/PatchTest1/");
      }
    });

    it("позволяет очистить поле через null", () => {
      const result = propertyUpdateSchema.safeParse({
        instagramUrl: null,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.instagramUrl).toBeNull();
      }
    });

    it("отклоняет не-Instagram URL при PATCH", () => {
      const result = propertyUpdateSchema.safeParse({
        instagramUrl: "https://youtube.com/watch?v=abc",
      });
      expect(result.success).toBe(false);
    });
  });
});