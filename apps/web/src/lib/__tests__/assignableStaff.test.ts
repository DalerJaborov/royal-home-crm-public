import { describe, expect, it } from "vitest";
import { assignableStaff, notAgentConfirmText, notAgentWarningText, staffOptionLabel } from "../assignableStaff";

/**
 * B13, решение владельца 02.10.2026: в списке «кому назначить» на карточке
 * клиента нет отключённых и замороженных, а не агент (директор) есть — с
 * подписью «не агент» и вопросом перед назначением. Раньше список показывал
 * только агентов, и директор не мог назначить клиента себе или коллеге-
 * руководителю иначе как кнопкой «Взять себе».
 */
const staff = [
  { id: "1", fullName: "Фаррух", role: "AGENT" as const, isActive: true, frozenAt: null },
  { id: "2", fullName: "Ноза", role: "AGENT" as const, isActive: true, frozenAt: "2026-10-01T00:00:00.000Z" },
  { id: "3", fullName: "Уволенный", role: "AGENT" as const, isActive: false, frozenAt: null },
  { id: "4", fullName: "Дан", role: "DIRECTOR" as const, isActive: true, frozenAt: null },
];

describe("кому можно назначить клиента вручную", () => {
  it("замороженных и отключённых в списке нет, директор есть", () => {
    expect(assignableStaff(staff).map((a) => a.id)).toEqual(["1", "4"]);
  });

  it("директор подписан «не агент», агент — просто именем", () => {
    expect(staffOptionLabel(staff[0])).toBe("Фаррух");
    expect(staffOptionLabel(staff[3])).toBe("Дан — Директор, не агент");
  });

  it("перед назначением не агенту экран переспрашивает и предупреждает, агенту — нет", () => {
    expect(notAgentConfirmText(staff[0])).toBeNull();
    expect(notAgentWarningText(staff[0])).toBeNull();
    expect(notAgentConfirmText(staff[3])).toContain("Точно назначить клиента: Дан?");
    expect(notAgentWarningText(staff[3])).toContain("не агент");
  });
});
