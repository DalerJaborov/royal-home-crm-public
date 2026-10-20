import { describe, expect, it } from "vitest";
import { stageState, type PipelineDeadlines } from "../src/lib/propertyPipeline.js";

/**
 * Конвейер подготовки объекта: кто отвечает за этап и когда он просрочен.
 *
 * Просрочка не двигает объект сама — она красит этап. Поэтому единственное, что
 * здесь можно сломать незаметно, это сама граница «просрочен»: сдвинутая на день,
 * она либо красит всё подряд, либо не краснеет никогда.
 */

const DEADLINES: PipelineDeadlines = {
  PENDING_REVIEW: 1,
  AWAITING_PHOTOS: 2,
  AWAITING_VIDEO: 2,
  EDITING: 2,
};

const NOW = new Date("2026-08-10T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

describe("Ответственный за этап", () => {
  /**
   * Ожидание материалов — это АГЕНТ. Маркетинг уже посмотрел и вернул на доработку,
   * дальше мяч у того, кто снимает; двухдневный таймер заведён именно для него.
   * Пока эти этапы числились за маркетингом, просрочка копилась не на том человеке.
   */
  it("проверка — маркетинг, ожидание материалов — агент, монтаж — монтажёр", () => {
    expect(stageState("PENDING_REVIEW", NOW, DEADLINES, NOW).owner).toBe("MARKETING");
    expect(stageState("AWAITING_PHOTOS", NOW, DEADLINES, NOW).owner).toBe("AGENT");
    expect(stageState("AWAITING_VIDEO", NOW, DEADLINES, NOW).owner).toBe("AGENT");
    expect(stageState("EDITING", NOW, DEADLINES, NOW).owner).toBe("EDITOR");
  });

  it("готовый объект в конвейере не состоит и ответственного по этапу не имеет", () => {
    for (const status of ["AVAILABLE", "RESERVED", "SOLD", "WITHDRAWN"] as const) {
      const state = stageState(status, daysAgo(100), DEADLINES, NOW);
      expect(state.inPipeline).toBe(false);
      expect(state.owner).toBeNull();
      expect(state.overdue).toBe(false);
    }
  });
});

describe("Граница просрочки", () => {
  it("ровно отведённое время — ещё не просрочка", () => {
    expect(stageState("AWAITING_PHOTOS", daysAgo(2), DEADLINES, NOW).overdue).toBe(false);
  });

  it("день сверх срока — просрочка", () => {
    const state = stageState("AWAITING_PHOTOS", daysAgo(3), DEADLINES, NOW);
    expect(state.overdue).toBe(true);
    expect(state.daysInStage).toBe(3);
  });

  it("объект, вошедший в этап только что, не просрочен никогда", () => {
    expect(stageState("PENDING_REVIEW", NOW, DEADLINES, NOW).overdue).toBe(false);
  });

  /** Проверка карточки — самый короткий этап: сутки. Своя цифра у каждого этапа,
   *  и подставить чужую нельзя. */
  it("у каждого этапа свой срок из Настроек", () => {
    expect(stageState("PENDING_REVIEW", daysAgo(2), DEADLINES, NOW).overdue).toBe(true);
    expect(stageState("AWAITING_PHOTOS", daysAgo(2), DEADLINES, NOW).overdue).toBe(false);
  });
});
