import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clientRowFact, lastContactLabel } from "../clientRowFacts";

/**
 * Строка клиента говорит только факты (владелец 21.11.2026): «зачем там отметки, типа
 * позвонить, давно не связывались… Таких ошибок чтобы не было вообще».
 */
const base = { kind: "BUYER" as const, status: "CONTACTED" as const, pendingAcceptance: false, deletedAt: null, hiddenReason: null };

describe("clientRowFact: единственная метка — «ждёт принятия», и только когда это правда", () => {
  it("принятая карточка — без метки, сколько бы ни было просрочено и непрочитано", () => {
    expect(clientRowFact(base)).toBeNull();
  });
  it("непринятая — «ждёт принятия»", () => {
    expect(clientRowFact({ ...base, pendingAcceptance: true })).toEqual({ id: "waiting", label: "ждёт принятия" });
  });
  it("Прочее, корзина, скрытая и закрытая карточка — без метки (у них своя отметка состояния)", () => {
    expect(clientRowFact({ ...base, pendingAcceptance: true, kind: "OTHER" })).toBeNull();
    expect(clientRowFact({ ...base, pendingAcceptance: true, deletedAt: "2026-11-20T10:00:00Z" })).toBeNull();
    expect(clientRowFact({ ...base, pendingAcceptance: true, status: "ARCHIVED" })).toBeNull();
  });
});

describe("lastContactLabel: «последний контакт ДД.ММ» правдой", () => {
  const now = new Date("2026-11-21T14:00:00Z");
  it("дата по Душанбе (UTC+5): 21.11 23:30 UTC — это уже 22.11", () => {
    expect(lastContactLabel("2026-11-21T19:30:00Z", now)).toBe("последний контакт 22.11");
    expect(lastContactLabel("2026-11-21T08:00:00Z", now)).toBe("последний контакт 21.11");
  });
  it("прошлый год — с годом", () => {
    expect(lastContactLabel("2025-10-03T08:00:00Z", now)).toBe("последний контакт 03.10.2025");
  });
  it("null — «контакта ещё не было»; поля нет — подписи нет, а не выдумка", () => {
    expect(lastContactLabel(null, now)).toBe("контакта ещё не было");
    expect(lastContactLabel(undefined, now)).toBeNull();
    expect(lastContactLabel("не дата", now)).toBeNull();
  });
});

/**
 * СТОРОЖ: строка списка клиентов не рисует советов. Читает исходники строки (ПК, телефон,
 * старый вид) и падает на любом из удалённых слов в коде разметки. Проверен поломкой:
 * возврат `"Давно не связывались · "` в RoyalClients.tsx красит этот тест.
 */
describe("сторож: в строке клиента нет «позвонить», «давно не связывались», «следующий шаг»", () => {
  const files = [
    "../../components/look/clients/RoyalClients.tsx",
    "../../components/clean/CleanClientRow.tsx",
    "../clientRowFacts.ts",
  ];
  const clientRowSource = () => {
    const page = readFileSync(new URL("../../pages/Clients.tsx", import.meta.url), "utf8");
    const start = page.indexOf("function ClientRow(");
    expect(start, "ClientRow в pages/Clients.tsx").toBeGreaterThan(-1);
    return page.slice(start);
  };
  /** Только код: комментарии с историей решения («до этого дня строка рисовала…») не в счёт. */
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
  const BANNED = [/давно не связывались/i, /следующий шаг/i, /["'`>]\s*позвонить(?: сейчас)?\s*["'`<]/i, /первый звонок/i, /нужно принять/i, /связывались\s/i, /просрочено/i];
  it.each([...files.map((f) => [f, () => readFileSync(new URL(f, import.meta.url), "utf8")] as const), ["pages/Clients.tsx ClientRow", clientRowSource] as const])("%s", (_name, read) => {
    const text = code(read());
    for (const re of BANNED) expect(text, String(re)).not.toMatch(re);
  });
});
