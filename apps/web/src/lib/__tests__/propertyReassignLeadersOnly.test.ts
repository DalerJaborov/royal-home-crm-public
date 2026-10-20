import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * «Кто принял» и «кто ведёт» объект меняет только руководство (решение
 * владельца 02.10.2026, «да, по советам»): сервер требует и правку чужих
 * объектов, и распределение работы (routes/properties/shared.ts::
 * canReassignPropertyAgents). Экран не должен показывать маркетингу и
 * монтажёру поля, которые сервер им молча отбрасывает.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8").replace(/\r\n/g, "\n");

describe("Смена агента объекта — только руководству", () => {
  it("форма правки: «Кто принял объект» в правке требует clients.assign", () => {
    const text = read("components/PropertyFormModal.tsx");
    expect(text).toMatch(/const picksIntakeAgent = isSupervisor && \(!isEdit \|\| can\("clients\.assign"\)\);/);
    expect(text).toMatch(/\{picksIntakeAgent && \(\s*<div className="fld wide">\s*<span className="lab">\s*Кто принял объект/);
    expect(text).toMatch(/\.\.\.\(picksIntakeAgent \? \{ intakeAgentId: form\.intakeAgentId \} : \{\}\)/);
    expect(text).not.toMatch(/\.\.\.\(isSupervisor \? \{ intakeAgentId/);
  });

  it("карточка: селект «Ответственный агент» — editForeign и clients.assign", () => {
    expect(read("pages/PropertyDetail.tsx")).toMatch(
      /const canAssignAgent = canListAgents && can\("properties\.editForeign"\) && can\("clients\.assign"\);/
    );
  });

  it("кнопка «Передать другому агенту» — по тем же двум правам", () => {
    expect(read("components/PropertyOwnerCard.tsx")).toMatch(/const canTransfer = canManage && can\("clients\.assign"\);/);
  });
});
