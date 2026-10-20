import { describe, expect, it } from "vitest";
import { extensionFromMemberLocation } from "../src/lib/telephony/operatorQueue.js";
import { blacklistKeys } from "../src/lib/telephony/stationBlacklist.js";

/**
 * Два действия оператора над станцией — «отошёл» и «больше не звонить с этого
 * номера». Проверяется то, где ошибка тихая: как оператор записан в очереди и в
 * каком виде номер попадает в чёрный список.
 */
describe("оператор в очереди станции", () => {
  /**
   * Очередь FreePBX дозванивается до операторов НЕ их SIP-каналом, а Local-каналом
   * (`Local/1001@from-queue/n`) — на этом уже спотыкались, когда искали, кто снял
   * трубку (extensionFromChannelName в incomingCalls.ts). Пауза ставится на то, чем
   * оператор записан в очереди, поэтому номер должен узнаваться в обеих формах.
   */
  it("узнаёт внутренний номер в обеих формах записи", () => {
    expect(extensionFromMemberLocation("Local/1001@from-queue/n")).toBe("1001");
    expect(extensionFromMemberLocation("SIP/1002")).toBe("1002");
    expect(extensionFromMemberLocation("PJSIP/1003-00000012")).toBe("1003");
  });

  it("на чужой записи молчит, а не выдумывает номер", () => {
    expect(extensionFromMemberLocation("Local/агент@from-queue/n")).toBeNull();
    expect(extensionFromMemberLocation("")).toBeNull();
  });
});

describe("чёрный список станции", () => {
  /**
   * В определителе входящего станция присылает то девять местных цифр, то двенадцать
   * с кодом страны (оба вида встречались в журнале). Пропущенный вариант означает,
   * что спамер дозвонится, — то есть настройку, которая выглядит включённой и не
   * работает. Поэтому пишем оба.
   */
  it("кладёт номер в обоих видах — местном и с кодом страны", () => {
    expect(blacklistKeys("+992930001001").sort()).toEqual(["930001001", "992930001001"]);
    expect(blacklistKeys("930001001").sort()).toEqual(["930001001", "992930001001"]);
    expect(blacklistKeys("0930001001").sort()).toEqual(["930001001", "992930001001"]);
  });

  it("иностранный номер остаётся как есть — код страны у него свой", () => {
    expect(blacklistKeys("+79161234567")).toEqual(["79161234567"]);
  });

  it("не номер — пустой список, блокировать нечего", () => {
    expect(blacklistKeys("")).toEqual([]);
    expect(blacklistKeys("аноним")).toEqual([]);
  });
});
