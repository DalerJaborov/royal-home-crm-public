import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Пульт: «Отменить» после «Одобрить» ничего не отменял — закрытую сделку сервер
 * назад не пускает, — а строка показывала «отменено» (аудит 23.09.2026, №36).
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("пульт не обещает отмену, которой нет", () => {
  it("у одобрения сделки нет «Отменить»", () => {
    const src = read("../../components/pult/PultActions.tsx");
    const approve = src.slice(src.indexOf('inv("deal-approve")'), src.indexOf("// 2)"));
    expect(approve).not.toContain("onUndo");
    expect(read("../../hooks/useMissionControl.ts")).not.toMatch(/stage:\s*"PENDING_APPROVAL"/);
  });

  it("неудачная отмена не показывает строку отменённой", () => {
    const src = read("../../components/pult/ActionRow.tsx");
    const onUndoCatch = src.slice(src.indexOf("await action.onUndo?.()"), src.indexOf('setStatus("idle")', src.indexOf("await action.onUndo?.()")));
    expect(onUndoCatch).toContain("return;");
  });
});
