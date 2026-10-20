import { describe, expect, it } from "vitest";
import { createLatestRequest } from "../latestRequest";

// Поиск на карте (24.09.2026): поздний ответ старого запроса не должен
// перезаписывать результат нового, а отправка поиска — гасить подсказки в пути.
describe("createLatestRequest", () => {
  it("действует только последний выданный номер", () => {
    const seq = createLatestRequest();
    const first = seq.next();
    const second = seq.next();
    expect(seq.isLatest(first)).toBe(false);
    expect(seq.isLatest(second)).toBe(true);
  });

  it("ответы в обратном порядке: поздний старый отбрасывается", async () => {
    const seq = createLatestRequest();
    const applied: string[] = [];
    const run = async (label: string, delayMs: number) => {
      const id = seq.next();
      await new Promise((r) => setTimeout(r, delayMs));
      if (seq.isLatest(id)) applied.push(label);
    };
    await Promise.all([run("старый", 20), run("новый", 1)]);
    expect(applied).toEqual(["новый"]);
  });

  it("invalidate обесценивает запрос в пути", () => {
    const seq = createLatestRequest();
    const inFlight = seq.next();
    seq.invalidate();
    expect(seq.isLatest(inFlight)).toBe(false);
  });
});
