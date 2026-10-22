import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { recruitmentContactPreviewSchema } from "@royal-home/shared";
import { assertSmsLength, bridgeRefusalStatus, hasCallWindowBefore, isUnresolvedDelivery, RecruitmentCommunicationError, smsSegments }
  from "../src/lib/recruitmentCommunicationRules.js";
import { buildRecruitmentCommunicationContent } from "../src/lib/recruitmentCommunicationContent.js";
import { vacancyOfficeMapUrl, VACANCY_FACTS, VACANCY_OFFICE_MAP_QUERY } from "../src/ai/vacancyFacts.js";

const facts = { name: "Тест", titleRu: "Агент", titleTg: "Агент", detailsRu: "ру", detailsTg: "тҷ", address: "Русский адрес", addressTg: "Суроғаи тоҷикӣ", missing: [] as never[] };
const base = { purpose: "INVITE" as const, channels: ["SMS" as const], interviewAt: "2026-10-22T09:30:00Z" };

describe("SMS length", () => {
  it("counts UCS-2 segments 70 / 67", () => {
    expect(smsSegments("")).toBe(0);
    expect(smsSegments("а".repeat(70))).toBe(1);
    expect(smsSegments("а".repeat(71))).toBe(2);
    expect(smsSegments("а".repeat(134))).toBe(2);
    expect(smsSegments("а".repeat(135))).toBe(3);
    expect(smsSegments("a".repeat(160))).toBe(1);
  });
  it("holds a text over 600 characters with a readable 409", () => {
    expect(() => assertSmsLength("а".repeat(600))).not.toThrow();
    try { assertSmsLength("а".repeat(601)); throw Error("no"); } catch (e) {
      expect(e).toBeInstanceOf(RecruitmentCommunicationError); expect((e as RecruitmentCommunicationError).status).toBe(409);
      expect((e as Error).message).toContain("слишком длинное");
    }
  });
});

describe("bridge refusal", () => {
  it("rejects only when the bridge proves nothing was dialled", () => {
    expect(bridgeRefusalStatus({ ok: false, notDialed: true, error: "Телефония не настроена" })).toBe("REJECTED");
    expect(bridgeRefusalStatus({ ok: false, error: "Asterisk не вернул id канала" })).toBe("UNKNOWN");
    expect(bridgeRefusalStatus({ ok: true })).toBe("UNKNOWN");
  });
});

describe("unresolved deliveries", () => {
  const now = new Date("2026-10-22T12:00:00Z"), ago = (min: number) => new Date(now.getTime() - min * 60_000);
  it("lets a stale UNKNOWN without dial evidence go, keeps fresh and evidenced ones", () => {
    expect(isUnresolvedDelivery({ status: "UNKNOWN", channel: "ASSISTANT_CALL", providerReceipt: null, updatedAt: ago(5) }, now)).toBe(true);
    expect(isUnresolvedDelivery({ status: "UNKNOWN", channel: "ASSISTANT_CALL", providerReceipt: null, updatedAt: ago(31) }, now)).toBe(false);
    expect(isUnresolvedDelivery({ status: "UNKNOWN", channel: "ASSISTANT_CALL", providerReceipt: "ch1", updatedAt: ago(31) }, now)).toBe(true);
    expect(isUnresolvedDelivery({ status: "UNKNOWN", channel: "SMS", providerReceipt: "m1", updatedAt: ago(60 * 25) }, now)).toBe(false);
    expect(isUnresolvedDelivery({ status: "QUEUED", channel: "SMS", providerReceipt: null }, now)).toBe(true);
    expect(isUnresolvedDelivery({ status: "ACCEPTED", channel: "ASSISTANT_CALL", providerReceipt: "c" }, now)).toBe(true);
    expect(isUnresolvedDelivery({ status: "ACCEPTED", channel: "SMS", providerReceipt: "m" }, now)).toBe(false);
    expect(isUnresolvedDelivery({ status: "REJECTED", channel: "SMS", providerReceipt: null }, now)).toBe(false);
  });
});

describe("call window before the interview", () => {
  const day = (h: number) => new Date(Date.UTC(2026, 9, 21, h)); // Dushanbe = UTC+5
  const within = (at: Date) => { const h = (at.getUTCHours() + 5) % 24; return h >= 9 && h < 19; };
  it("finds a window or reports none", () => {
    expect(hasCallWindowBefore(day(10), day(12), within)).toBe(true);
    expect(hasCallWindowBefore(day(15), day(16), within)).toBe(false); // 20:00-21:00 Dushanbe
    expect(hasCallWindowBefore(day(15), new Date(Date.UTC(2026, 9, 22, 5)), within)).toBe(true); // next morning 09:00-10:00
    expect(hasCallWindowBefore(day(15), day(23), within)).toBe(false); // 20:00-04:00 only
  });
});

describe("invitation content", () => {
  it("holds a missing address with a readable error", () => {
    expect(() => buildRecruitmentCommunicationContent({ ...base, language: "ru" }, { ...facts, address: "  " })).toThrow(RecruitmentCommunicationError);
    expect(() => buildRecruitmentCommunicationContent({ ...base, language: "ru" }, { ...facts, address: "" })).toThrow("Укажите адрес");
  });
  it("uses the Tajik address for tg and the default map unless the address is manual", () => {
    const tg = buildRecruitmentCommunicationContent({ ...base, language: "tg" }, { ...facts, mapUrl: "https://www.google.com/maps/search/?api=1&query=x" });
    expect(tg.text).toContain("Суроғаи тоҷикӣ"); expect(tg.text).not.toContain("Русский адрес"); expect(tg.text).toContain("Харита:");
    const manual = buildRecruitmentCommunicationContent({ ...base, language: "ru", address: "Свой адрес" }, { ...facts, mapUrl: "https://www.google.com/maps/search/?api=1&query=x" });
    expect(manual.text).not.toContain("Карта:");
  });
  it("promises the SMS in the call script only when SMS is selected", () => {
    const withSms = buildRecruitmentCommunicationContent({ ...base, channels: ["SMS", "ASSISTANT_CALL"], language: "ru" }, facts);
    expect(withSms.callPrompt).toContain("пришлём СМС");
    const callOnly = buildRecruitmentCommunicationContent({ ...base, channels: ["ASSISTANT_CALL"], language: "ru" }, facts);
    expect(callOnly.callPrompt).not.toContain("пришлём СМС"); expect(callOnly.callPrompt).toContain("менеджер пришлёт геолокацию");
  });
});

describe("office map link", () => {
  it("is a Google Maps search of the real office address and passes the whitelist", () => {
    const url = vacancyOfficeMapUrl();
    expect(url.startsWith("https://www.google.com/maps/search/?api=1&query=")).toBe(true);
    expect(decodeURIComponent(url.split("query=")[1])).toBe(VACANCY_OFFICE_MAP_QUERY);
    expect(url.length).toBeLessThan(110);
    expect(VACANCY_FACTS.office.address).toContain("Бухоро 49");
    expect(recruitmentContactPreviewSchema.safeParse({ ...base, language: "ru", mapUrl: url }).success).toBe(true);
    // The api build resolves @royal-home/shared from another tree, so read the whitelist source directly.
    const source = readFileSync(new URL("../../../packages/shared/src/recruitmentCommunications.ts", import.meta.url), "utf8");
    for (const host of ["go.2gis.com", "2gis.com", "2gis.ru", "www.google.com"]) expect(source).toContain(`"${host}"`);
  });
});
