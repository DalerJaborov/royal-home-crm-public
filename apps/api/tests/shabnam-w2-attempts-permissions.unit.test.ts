import { describe, expect, it } from "vitest";
import { ROLE_PRESETS, resolvePermissions, type PermissionId } from "@royal-home/shared";
import { AssistantAttemptLimitError, assistantTurnAttemptCap, createAssistantAttemptLimit } from "../src/ai/assistant/attemptLimit.js";
import { honestStopAnswer } from "../src/ai/assistant/partialAnswer.js";
import { resolvePermissionRef } from "../src/ai/assistant/tools/permissionLookup.js";
import { permissionNoChangeMessage, resolvePermissionArgs } from "../src/ai/assistant/tools/staffWriteTools.js";

/**
 * СБОИ attempt_limit (журнал прода 17.11.2026, 2 случая): «закрой РОПу право видеть номера
 * клиентов» и длинная диктовка текста для озвучки. Причины и починка — в
 * docs/journal/2026-11-17-shabnam-w2-otkazy-i-golos.md.
 */
describe("предел попыток хода", () => {
  it("выводится из числа шагов Настроек с запасом на повторы, а не равен девяти", () => {
    expect(assistantTurnAttemptCap(30)).toBe(45);
    expect(assistantTurnAttemptCap(4)).toBe(10);
    expect(assistantTurnAttemptCap(Number.NaN)).toBe(7);
    expect(assistantTurnAttemptCap(30)).toBeGreaterThan(30);
  });

  it("исчерпание хода — scope «turn», отказ учёта — scope «budget»; remaining считает остаток", async () => {
    const gate = createAssistantAttemptLimit(async () => true, 2);
    expect(gate.remaining()).toBe(2);
    await gate();
    expect(gate.remaining()).toBe(1);
    await gate();
    expect(gate.remaining()).toBe(0);
    await expect(gate()).rejects.toMatchObject({ code: "assistant_attempt_limit", scope: "turn" });
    await expect(createAssistantAttemptLimit(async () => false)()).rejects.toMatchObject({ code: "assistant_attempt_limit", scope: "budget" });
    expect(new AssistantAttemptLimitError().scope).toBe("budget");
  });
});

describe("честная остановка: что успела / что не вышло", () => {
  it("отказ инструмента — его смысл и как продолжить, а не «запрос слишком широкий»", () => {
    const text = honestStopAnswer([{ name: "set_staff_permissions", result: { error: "Не нашла право «x».", code: "UNKNOWN_PERMISSION" } }], "ru");
    expect(text).toContain("Не получилось: Не нашла право «x».");
    expect(text).toContain("Напишите, что сделать дальше");
    expect(text).not.toMatch(/ориентир|слишком широк/u);
  });

  it("сделанное и ждущее подтверждения называются; по-таджикски — на «шумо», без «лутфан»", () => {
    const text = honestStopAnswer([], "tg", { done: [], pending: ["change_property_price"] });
    expect(text).toContain("Тасдиқи шуморо дар корт интизор аст: тағйири нарх.");
    expect(text).toContain("Нависед, ки баъд чӣ кор кунам");
    expect(text).not.toMatch(/лутфан/iu);
  });

  it("ничего не найдено и не сделано — просьба короче или по частям; нашлись карточки — прежний частичный ответ", () => {
    expect(honestStopAnswer([], "ru")).toMatch(/^Не успела закончить/u);
    const found = [{ name: "find_property", result: { items: [{ code: "ОБ-000130", title: "Ашан" }] } }];
    expect(honestStopAnswer(found, "ru")).toContain("Собрала пока вот что");
  });
});

describe("права по человеческим словам", () => {
  it.each([
    ["clients.viewPhone", "clients.viewPhone"],
    ["видеть номера клиентов", "clients.viewPhone"],
    ["Видеть телефоны клиентов", "clients.viewPhone"],
    ["закрой РОПу право видеть номера клиентов", "clients.viewPhone"],
    ["номера клиентов", "clients.viewPhone"],
    ["Удалять безвозвратно клиентов", "clients.purge"],
  ] as const)("«%s» → %s", (ref, id) => {
    expect(resolvePermissionRef(ref)).toEqual({ ok: true, id });
  });

  it("одна подпись в двух разделах — кандидаты с разделом, а не догадка", () => {
    const match = resolvePermissionRef("Удалять безвозвратно");
    expect(match.ok).toBe(false);
    if (match.ok) return;
    expect(match.candidates.length).toBe(2);
    expect(match.candidates.map((c) => c.label).join(" | ")).toMatch(/\(Объекты\).*\(Клиенты и сделки\)|\(Клиенты и сделки\).*\(Объекты\)/u);
  });

  it("чепуха — отказ с подсказкой и кандидатами в details, без исключения внутри модели", () => {
    expect(resolvePermissionRef("летать на луну")).toEqual({ ok: false, candidates: [] });
    // Одно слово «номера» — не точное название: отказ с кандидатом «Видеть телефоны клиентов».
    let error: unknown;
    try { resolvePermissionArgs({ grant: [], revoke: ["номера"] }); } catch (err) { error = err; }
    expect(error).toMatchObject({ code: "UNKNOWN_PERMISSION" });
    expect(String((error as Error).message)).toContain("«Видеть телефоны клиентов (Клиенты и сделки)»");
    expect(JSON.stringify((error as { extra: unknown }).extra)).toContain("clients.viewPhone");
    expect(() => resolvePermissionArgs({ grant: ["летать на луну"], revoke: [] })).toThrow(/Не нашла право «летать на луну»/u);
    expect(resolvePermissionArgs({ grant: [], revoke: ["видеть номера клиентов"] })).toMatchObject({ revoke: ["clients.viewPhone"] });
  });

  it("закрыть РОПу телефоны клиентов, которых у него и так нет: причина, а не «права уже такие»", () => {
    const before = resolvePermissions("HEAD_OF_SALES", { granted: [], revoked: [] });
    expect(before.has("clients.viewPhone")).toBe(false);
    expect(ROLE_PRESETS.HEAD_OF_SALES).not.toContain("clients.viewPhone");
    const text = permissionNoChangeMessage(before, { grant: [], revoke: ["clients.viewPhone" as PermissionId] }, "Сотрудник");
    expect(text).toBe("Менять нечего: у Сотрудник и так нет права «Видеть телефоны клиентов» — оно есть только у директора.");
    expect(permissionNoChangeMessage(before, { grant: ["clients.viewPhone" as PermissionId], revoke: [] }, "Сотрудник"))
      .toContain("выдаётся только директору");
  });
});
