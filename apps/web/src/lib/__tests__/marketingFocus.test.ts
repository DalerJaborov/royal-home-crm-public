import { describe, expect, it } from "vitest";
import { pipelineEmptyText } from "../marketingFocus";

/** FORMS09: «пусто» только когда в подготовке и правда ничего нет (04.10.2026). */
describe("pipelineEmptyText", () => {
  it("в подготовке есть объекты, срочного нет: не «пусто»", () => {
    const t = pipelineEmptyText(1);
    expect(t).not.toContain("пусто");
    expect(t).toContain("1 объект");
  });

  it("форма числа согласуется", () => {
    expect(pipelineEmptyText(3)).toContain("3 объекта");
    expect(pipelineEmptyText(11)).toContain("11 объектов");
  });

  it("объектов нет вовсе: прежнее «пусто»", () => {
    expect(pipelineEmptyText(0)).toContain("В конвейере подготовки пусто");
    expect(pipelineEmptyText(undefined)).toContain("В конвейере подготовки пусто");
  });
});
