import { describe, expect, it } from "vitest";
import { PER_WORKER_BYTES, planWorkers } from "./dbPerWorker.js";

/**
 * Сколько процессов поднимает полный прогон (25.09.2026): на машине владельца
 * 4 процесса не влезли в свободную память, два воркера убили снаружи при
 * зелёных тестах. Число — меньшее из потолка 4, ядер и свободной памяти.
 */
const GB = 1024 ** 3;

describe("число процессов полного прогона", () => {
  it("облако: 4 ядра, 15 ГБ свободно — 4, упёрлось в потолок и ядра", () => {
    const plan = planWorkers({ cpus: 4, freeBytes: 15 * GB });
    expect(plan.count).toBe(4);
    expect(plan.reason).toContain("потолок 4");
    expect(plan.reason).toContain("ограничило: потолок 4, ядра");
  });

  it("ноутбук под нагрузкой: 12 потоков, 3,5 ГБ свободно — 2, и причина — память", () => {
    const plan = planWorkers({ cpus: 12, freeBytes: 3.5 * GB });
    expect(plan.count).toBe(2);
    expect(plan.reason).toContain("свободно 3,5 ГБ");
    expect(plan.reason).toContain("ограничило: память");
  });

  it("памяти меньше, чем на один процесс, — всё равно один, прогон не отказывается", () => {
    expect(planWorkers({ cpus: 8, freeBytes: 0.4 * GB }).count).toBe(1);
    expect(planWorkers({ cpus: 0, freeBytes: 0 }).count).toBe(1);
  });

  it("ровно на границе памяти процесс помещается", () => {
    expect(planWorkers({ cpus: 8, freeBytes: 3 * PER_WORKER_BYTES }).count).toBe(3);
    expect(planWorkers({ cpus: 8, freeBytes: 3 * PER_WORKER_BYTES - 1 }).count).toBe(2);
  });

  it("явный VITEST_DB_WORKERS главнее ядер и памяти", () => {
    const plan = planWorkers({ explicit: "6", cpus: 2, freeBytes: 1 * GB });
    expect(plan).toEqual({ count: 6, reason: "задано VITEST_DB_WORKERS=6" });
  });

  it("мусор в VITEST_DB_WORKERS не считается заданным", () => {
    for (const explicit of ["", "0", "-1", "2.5", "два"]) {
      expect(planWorkers({ explicit, cpus: 4, freeBytes: 15 * GB }).count).toBe(4);
    }
  });
});
