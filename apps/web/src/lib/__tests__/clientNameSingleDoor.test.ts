import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clientDisplayName, clientNameLines } from "../clientFormat";

/**
 * СТОРОЖ «ИМЯ КЛИЕНТА — ЧЕРЕЗ ОДНУ ФУНКЦИЮ» (владелец 22.11.2026: «Клиент ПК-0021»,
 * «Покупатель ПК-000925» вместо «Имя · объект/ориентир»). Экраны, где агент видит
 * клиента, берут имя из `clientDisplayName` (lib/clientFormat → правило из
 * @royal-home/shared), а не печатают `x.fullName` или строку «Клиент ПК-…».
 */
const SRC = join(__dirname, "..", "..");

/** Экраны «видит клиента»: главная, список, карточка, звонки. */
const SCREENS = [
  "components/home/AgentHome.tsx",
  "components/home/agent/AgentQueue.tsx",
  "components/home/agent/AgentFocusCard.tsx",
  "components/home/mh/MobileAgentHome.tsx",
  "components/look/home/blocks/agent.tsx",
  "pages/Calls.tsx",
  "components/mobile/MobileCalls.tsx",
  "pages/Clients.tsx",
  "components/mobile/MobileClientsList.tsx",
  "components/mobile/MobileClientCard.tsx",
];

/** Вывод сырого имени клиента: `{c.fullName}`, `title={row.fullName}`, `title: c.fullName`. */
const RAW_OUTPUT = /(?:\{\s*|title[=:]\s*\{?\s*)(?:call\.client|client|oldest|[cori]|row|showing\.client|s\.client)\??\.fullName\s*\}?\s*[}<,]/;

describe("имя клиента на экранах — только через clientDisplayName", () => {
  for (const file of SCREENS) {
    it(`${file}: нет сырого fullName клиента на выводе`, () => {
      const text = readFileSync(join(SRC, file), "utf8");
      const bad = text.split("\n").filter((l) => RAW_OUTPUT.test(l) && !/agent|assignedAgent|byName/i.test(l) && !/ClientAvatar|initials/.test(l));
      expect(bad).toEqual([]);
    });
  }

  it("нигде в вебе имя не собирается строкой «Клиент ПК-…» / «Покупатель ПК-…» (заглушки ставит только сервер)", () => {
    const bad: string[] = [];
    for (const file of SCREENS) {
      const text = readFileSync(join(SRC, file), "utf8");
      if (/["'`](?:Клиент|Покупатель|Продавец)\s+(?:ПК|ПР)-/.test(text)) bad.push(file);
    }
    expect(bad).toEqual([]);
  });
});

describe("clientDisplayName / clientNameLines", () => {
  it("готовое серверное имя берётся как есть", () => {
    expect(clientDisplayName({ fullName: "Покупатель ПК-000925", displayName: "Покупатель из WhatsApp · Сино, 2к" })).toBe("Покупатель из WhatsApp · Сино, 2к");
  });
  it("краткая ссылка без displayName: заглушка заменена, номер рядом", () => {
    expect(clientDisplayName({ fullName: "Клиент ПК-0021", shortId: 21 })).toBe("Клиент · ПК-000021");
  });
  it("старый вызов строкой не сломан", () => {
    expect(clientDisplayName("Далер")).toBe("Далер");
    expect(clientDisplayName(null)).toBe("Клиент");
    expect(clientDisplayName("@•••••")).toBe("Клиент");
  });
  it("части: номер карточки отдельной мелкой строкой", () => {
    const l = clientNameLines({ kind: "BUYER", fullName: "Покупатель ПК-000925", source: "WHATSAPP", shortId: 925 });
    expect(l).toEqual({ name: "Покупатель из WhatsApp", anchor: null, code: "ПК-000925" });
  });
});
