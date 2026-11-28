import { describe, expect, it } from "vitest";
import { isStationTimeoutText, stationTimeoutContext, STATION_TIMEOUT_DEDUP_KEY } from "../src/lib/telephony/stationTimeoutLog.js";

/** Журнал 28.11.2026: пять текстов одного факта «станция не ответила» → один ключ, окно в час. */
describe("таймаут станции в журнале ошибок", () => {
  it.each([
    "АТС (ARI): ответ на канал — не удалось соединиться с Asterisk: The operation was aborted due to timeout",
    "АТС (ARI): сброс вызова — не удалось соединиться с Asterisk: The operation was aborted due to timeout",
    "Станция не приняла вердикт «звонок не наш» (канал SIP/out-000009cf): станция не ответила за 3 с",
    "Синхронизация очереди со статусом агента: станция не ответила за 5 с",
    "Живой голос: сверка сирот в Stasis не получила список каналов станции: The operation was aborted due to timeout",
  ])("склеивает: %s", (text) => {
    const ctx = stationTimeoutContext(text);
    expect(ctx?.dedupKey).toBe(STATION_TIMEOUT_DEDUP_KEY);
    expect(ctx?.dedupWindowMs).toBe(3_600_000);
    expect(ctx?.silent).toBe(true);
  });

  it("ответ станции с ошибкой (не таймаут) пишется как раньше", () => {
    expect(isStationTimeoutText("АТС (ARI): мост — станция вернула 500: Internal Server Error")).toBe(false);
    expect(stationTimeoutContext("Станция не приняла вердикт «свой клиент»: Permission denied")).toBeUndefined();
  });
});
