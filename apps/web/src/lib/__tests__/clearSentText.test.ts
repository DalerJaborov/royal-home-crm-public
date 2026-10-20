import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clearIfUnchanged } from "../clearSentText";

/**
 * Аудит 04.10.2026, WEB-PAGES02: после успеха отправки поле очищалось
 * безусловно, и текст, набранный пока сервер отвечал, пропадал без отправки.
 */
describe("clearIfUnchanged", () => {
  it("поле не менялось с момента отправки: очищается", () => {
    expect(clearIfUnchanged("привет", "привет")).toBe("");
    expect(clearIfUnchanged("  привет \n", "привет")).toBe("");
  });

  it("пока шёл запрос, набран новый ответ: он остаётся", () => {
    expect(clearIfUnchanged("второй ответ", "привет")).toBe("второй ответ");
  });

  it("поле уже очистили руками: остаётся пустым", () => {
    expect(clearIfUnchanged("", "привет")).toBe("");
  });
});

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("три композера чата очищают поле через clearIfUnchanged", () => {
  it.each([
    ["../../pages/Messages.tsx"],
    ["../../components/mobile/MobileChatView.tsx"],
    ["../../components/ClientChatPanel.tsx"],
  ])("%s", (rel) => {
    const src = read(rel);
    expect(src).toContain("clearIfUnchanged(");
    expect(src).not.toMatch(/onSuccess: \(\) => setText\(""\)/);
  });
});
