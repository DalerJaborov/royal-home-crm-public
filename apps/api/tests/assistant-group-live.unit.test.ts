import { describe, expect, it, vi } from "vitest";
import {
  liveQuietHours, liveTopicBlocked, parseGroupModeWord, parseLiveDecision, resolveGroupMode, sanitizeLiveReply,
} from "../src/telegram/assistantGroupLive.js";

vi.mock("../src/db.js", () => ({ prisma: { $disconnect: async () => {} } }));

const noon = new Date("2026-11-25T10:00:00Z");

describe("рамки живой беседы", () => {
  it("тихие часы по Душанбе: с 22:00 до 08:00", () => {
    expect(liveQuietHours(new Date("2026-11-25T17:30:00Z"))).toBe(true); // 22:30
    expect(liveQuietHours(new Date("2026-11-25T02:59:00Z"))).toBe(true); // 07:59
    expect(liveQuietHours(new Date("2026-11-25T03:00:00Z"))).toBe(false); // 08:00
    expect(liveQuietHours(noon)).toBe(false);
  });

  it.each([
    "Мне опять оштрафовали на 200 сомони", "Комиссия за этот месяц маленькая", "Хочу уволиться, надоело",
    "Қарз гирифтам", "Ҷарима кардан мумкин аст?", "Завтра в больницу, плохо себя чувствую", "Что скажете про президента?",
    "По ОБ-123 есть вопросы", "Это не жалоба, но достал",
  ])("запретная тема молчит: %s", (text) => expect(liveTopicBlocked(text)).toBe(true));

  it.each(["Всем доброе утро!", "Салом ҳамкасбон, хайрӯз!", "Ура, сегодня показ удался", "Ха-ха, отличная шутка"])(
    "обычная беседа не блокируется: %s", (text) => expect(liveTopicBlocked(text)).toBe(false));

  it("реплика: без тире, ссылок, контактов, длинного текста", () => {
    expect(sanitizeLiveReply("Доброе утро — хорошего дня!")).toBe("Доброе утро, хорошего дня!");
    expect(sanitizeLiveReply("Смотрите https://example.com")).toBeNull();
    expect(sanitizeLiveReply("Напишите мне @name")).toBeNull();
    expect(sanitizeLiveReply("а".repeat(300))).toBeNull();
    expect(sanitizeLiveReply("Лутфан, не переживайте")).toBeNull();
    expect(sanitizeLiveReply("Не шутите про штраф")).toBeNull();
  });

  it("решение модели: join только при чистой реплике", () => {
    expect(parseLiveDecision({ join: true, reply: "Доброе утро!" })).toEqual({ join: true, reply: "Доброе утро!" });
    expect(parseLiveDecision({ join: false, reply: "Доброе утро!" })).toEqual({ join: false, reply: "" });
    expect(parseLiveDecision({ join: true, reply: "Смотрите https://x.tj" })).toEqual({ join: false, reply: "" });
    expect(parseLiveDecision(null)).toBeNull();
  });

  it("режим группы: по умолчанию живая, слова слушает/помогает/живая", () => {
    expect(resolveGroupMode(null)).toBe("LIVE");
    expect(resolveGroupMode("HELP")).toBe("HELP");
    expect(resolveGroupMode("мусор")).toBe("LIVE");
    expect(parseGroupModeWord("слушает")).toBe("LISTEN");
    expect(parseGroupModeWord("помогает")).toBe("HELP");
    expect(parseGroupModeWord("живая")).toBe("LIVE");
    expect(parseGroupModeWord("зинда")).toBe("LIVE");
    expect(parseGroupModeWord("???")).toBeNull();
  });
});

