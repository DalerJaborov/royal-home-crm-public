import { describe, expect, it } from "vitest";
import {
  SHOWING_CONFIRM_ON_TEXT,
  followUpBlockedBy,
  maxOwnPropertyScore,
  ownPropertyThresholdNote,
  releaseEffectiveOn,
  releaseToggleBody,
  showingConfirmBlockedBy,
} from "../settingsDependencies";

/**
 * Два тумблера на одно поведение (аудит настроек 28.09.2026): каждый показывает
 * состояние второго. Условия повторяют сервер — cron.ts::sendFollowUps,
 * meetingReminders.ts::sendShowingConfirmationRequests, leadAccept.ts::acceptLead.
 */
describe("Напоминания молчащим: два тумблера и число", () => {
  const allOn = { botEnabled: true, botCanFollowUp: true, followUpEnabled: true, followUpMaxAttempts: 1 };

  it("всё включено — никаких оговорок ни с одной стороны", () => {
    expect(followUpBlockedBy(allOn, "ability")).toBeNull();
    expect(followUpBlockedBy(allOn, "schedule")).toBeNull();
  });

  it("каждый тумблер называет выключенного напарника", () => {
    expect(followUpBlockedBy({ ...allOn, followUpEnabled: false }, "ability")).toContain(
      "Напоминать клиенту, который замолчал"
    );
    expect(followUpBlockedBy({ ...allOn, botCanFollowUp: false }, "schedule")).toContain(
      "Напоминать молчащим клиентам"
    );
  });

  it("ноль напоминаний — тоже выключено, и об этом сказано с обеих сторон", () => {
    const zero = { ...allOn, followUpMaxAttempts: 0 };
    expect(followUpBlockedBy(zero, "ability")).toContain("ноль");
    expect(followUpBlockedBy(zero, "schedule")).toContain("ноль");
  });

  it("незаполненное число — одно напоминание, как followUpLimit на сервере", () => {
    expect(followUpBlockedBy({ ...allOn, followUpMaxAttempts: null }, "ability")).toBeNull();
  });

  it("выключенный бот целиком тоже гасит напоминания", () => {
    expect(followUpBlockedBy({ ...allOn, botEnabled: false }, "ability")).toContain("бот выключен");
  });
});

describe("Просьба подтвердить показ: «Лиды» и «Бот»", () => {
  it("каждая вкладка называет выключенный тумблер другой", () => {
    expect(showingConfirmBlockedBy({ askClientsToConfirmShowings: false, botCanConfirmShowings: true }, "bot")).toContain(
      "«Лиды»"
    );
    expect(showingConfirmBlockedBy({ askClientsToConfirmShowings: true, botCanConfirmShowings: false }, "leads")).toContain(
      "«Бот»"
    );
    expect(showingConfirmBlockedBy({ askClientsToConfirmShowings: true, botCanConfirmShowings: true }, "bot")).toBeNull();
    expect(showingConfirmBlockedBy({ askClientsToConfirmShowings: true, botCanConfirmShowings: true }, "leads")).toBeNull();
  });

  it("текст говорит то, что делает код: за 4 часа, только клиенту", () => {
    expect(SHOWING_CONFIRM_ON_TEXT).toContain("За 4 часа");
    expect(SHOWING_CONFIRM_ON_TEXT).toContain("накануне в 19:00");
    expect(SHOWING_CONFIRM_ON_TEXT).toContain("Собственнику ничего не пишется");
  });
});

describe("«Предлагать освободить место» и скрытое поле", () => {
  it("тумблер показывает итог обоих полей, как проверяет acceptLead", () => {
    expect(releaseEffectiveOn({ ownPropertyReleaseEnabled: true, ownPropertyOverLimitEnabled: true })).toBe(true);
    expect(releaseEffectiveOn({ ownPropertyReleaseEnabled: true, ownPropertyOverLimitEnabled: false })).toBe(false);
    expect(releaseEffectiveOn({ ownPropertyReleaseEnabled: false, ownPropertyOverLimitEnabled: true })).toBe(false);
  });

  it("включение поднимает оба поля, выключение трогает только своё", () => {
    expect(releaseToggleBody(false)).toEqual({ ownPropertyReleaseEnabled: true, ownPropertyOverLimitEnabled: true });
    expect(releaseToggleBody(true)).toEqual({ ownPropertyReleaseEnabled: false });
  });
});

describe("Порог «свой объект» и веса «Подбора»", () => {
  const defaults = { base: 40, district: 25, rooms: 20, budget: 15, distance: 25 };

  it("максимум без бонуса горячему и с потолком 100", () => {
    expect(maxOwnPropertyScore(defaults)).toBe(100);
    expect(maxOwnPropertyScore({ ...defaults, district: 0, distance: 0 })).toBe(75);
  });

  it("говорит, сколько нужно сверх базы", () => {
    expect(ownPropertyThresholdNote(90, defaults)).toContain("ещё 50");
  });

  it("недостижимый порог называется прямо", () => {
    expect(ownPropertyThresholdNote(90, { ...defaults, district: 0, distance: 0 })).toContain("недостижим");
  });
});
