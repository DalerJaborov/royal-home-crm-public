import { describe, expect, it } from "vitest";
import { parseShardOf } from "./dbPerWorker.js";

describe("VITEST_SHARD_OF — машина из облачного прогона", () => {
  it("пусто — машина одна, доли как раньше", () => {
    expect(parseShardOf(undefined)).toEqual({ machine: 1, machines: 1 });
    expect(parseShardOf("  ")).toEqual({ machine: 1, machines: 1 });
  });

  it("m/M разбирается", () => {
    expect(parseShardOf("3/18")).toEqual({ machine: 3, machines: 18 });
    expect(parseShardOf("18/18")).toEqual({ machine: 18, machines: 18 });
  });

  it("кривое значение — ошибка, а не тихий прогон всех файлов на каждой машине", () => {
    for (const bad of ["0/18", "19/18", "3", "a/b", "3/0", "-1/4"]) {
      expect(() => parseShardOf(bad), bad).toThrow(/VITEST_SHARD_OF/);
    }
  });
});
