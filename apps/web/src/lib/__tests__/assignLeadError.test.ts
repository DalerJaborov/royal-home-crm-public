import { describe, expect, it } from "vitest";
import { ApiError } from "../apiError";
import { assignLeadErrorText } from "../assignLeadError";

/** Назначение лида: причина отказа сервера вместо «Попробуйте ещё раз» (аудит 23.09.2026, №57). */
describe("assignLeadErrorText", () => {
  it("показывает текст сервера", () => {
    const err = new ApiError("Лид уже принят агентом", 409, { error: "Лид уже принят агентом" });
    expect(assignLeadErrorText(err, "Не удалось назначить.")).toBe("Не удалось назначить. Лид уже принят агентом");
  });
  it("без текста — прежняя подсказка", () => {
    expect(assignLeadErrorText(null, "Не удалось назначить.")).toBe("Не удалось назначить. Попробуйте ещё раз.");
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("отказ назначения перечитывает карточку", () => {
  it("useAssignLead при ошибке сбрасывает кэш карточки", () => {
    const src = readFileSync(fileURLToPath(new URL("../../hooks/useClients.ts", import.meta.url)), "utf8");
    const hook = src.slice(src.indexOf("export function useAssignLead("), src.indexOf("export function", src.indexOf("export function useAssignLead(") + 10));
    expect(hook).toMatch(/onError:[\s\S]*queryKey: \["client"\]/);
  });
});
