import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TELEPHONY_OPTIONS, telephonyOptionTitle, type TelephonyOptionField } from "@royal-home/shared";

/**
 * Подписи вариантов телефонии (ревью #341): экран «Каналы → Телефония» и сообщение сервера берут названия из ОДНОГО словаря по
 * полю настроек. Раньше сервер придумывал свои и ошибался («mobile» — это звонок на сотовый сотрудника, а не приложение).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const CHANNELS_TAB = readFileSync(path.resolve(here, "../../pages/settings/ChannelsTab.tsx"), "utf8");

/** Значения, которые принимает сервер (схема настроек): новое значение без подписи здесь краснит. */
const ACCEPTED: Record<TelephonyOptionField, string[]> = {
  asteriskAgentDialMode: ["auto", "mobile", "extension"],
  incomingPrimaryTarget: ["queue", "extension"],
  incomingNoAnswerAction: ["none", "forward", "voicemail", "both"],
  incomingRoutingMode: ["assigned_then_forward", "kpi_queue", "dedicated_operator", "ivr_menu"],
};

describe("подписи вариантов телефонии", () => {
  it("у каждого значения каждого поля есть название и пояснение на русском", () => {
    for (const [field, values] of Object.entries(ACCEPTED)) {
      const options = TELEPHONY_OPTIONS[field as TelephonyOptionField] as readonly { value: string; title: string; hint: string }[];
      expect(options.map((o) => o.value), field).toEqual(values);
      for (const o of options) {
        expect(o.title, `${field}/${o.value}`).toMatch(/[А-Яа-яЁё]{3}/);
        expect(o.hint, `${field}/${o.value}`).toMatch(/[А-Яа-яЁё]{3}/);
        expect(o.title, `${field}/${o.value}`).not.toMatch(/\b(mobile|extension|queue|none|auto|ivr_menu|kpi_queue|dedicated_operator|SIP|IVR|KPI)\b/);
      }
    }
  });

  it("одно значение в разных полях подписано по-разному, а не одной подписью на все", () => {
    expect(telephonyOptionTitle("asteriskAgentDialMode", "extension")).toBe("На внутренний номер (софтфон)");
    expect(telephonyOptionTitle("incomingPrimaryTarget", "extension")).toBe("Прямо на один аппарат");
    expect(telephonyOptionTitle("asteriskAgentDialMode", "mobile")).toBe("На мобильный сотрудника");
    expect(telephonyOptionTitle("incomingRoutingMode", "dedicated_operator")).toBe("Дежурный по календарю");
  });

  it("экран берёт варианты из общего словаря и не держит своих списков значений", () => {
    expect(CHANNELS_TAB).toContain("TELEPHONY_OPTIONS.asteriskAgentDialMode");
    expect(CHANNELS_TAB).toContain("TELEPHONY_OPTIONS.incomingPrimaryTarget");
    expect(CHANNELS_TAB).toContain("TELEPHONY_OPTIONS.incomingNoAnswerAction");
    expect(CHANNELS_TAB).toContain("TELEPHONY_OPTIONS.incomingRoutingMode");
    expect(CHANNELS_TAB).not.toMatch(/value:\s*"(assigned_then_forward|kpi_queue|dedicated_operator)"/);
  });
});
