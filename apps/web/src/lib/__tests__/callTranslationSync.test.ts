import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { translationResetFor } from "../callTranslationSync";

/** Аудит 04.10.2026, WEB-PAGES09: новый оригинал показывался со старым русским переводом. */
describe("синхронизация перевода звонка с пропсами", () => {
  const old = { transcript: "старый", transcriptRu: "старый перевод" };

  it("ничего не поменялось: локальное состояние не трогаем", () => {
    expect(translationResetFor(old, { ...old })).toBeNull();
  });

  it("повторная расшифровка очистила оригинал и перевод: перевод сброшен", () => {
    expect(translationResetFor(old, { transcript: null, transcriptRu: null })).toEqual({
      translatedRu: null,
      notNeeded: false,
    });
  });

  it("пришёл новый оригинал без перевода: старый перевод не остаётся, «не нужен» снят", () => {
    expect(translationResetFor({ transcript: null, transcriptRu: null }, { transcript: "новый", transcriptRu: null })).toEqual({
      translatedRu: null,
      notNeeded: false,
    });
  });

  it("сервер дописал перевод: он становится показанным", () => {
    expect(translationResetFor({ transcript: "т", transcriptRu: null }, { transcript: "т", transcriptRu: "п" })).toEqual({
      translatedRu: "п",
      notNeeded: false,
    });
  });

  it("CallDetails применяет сброс при смене пропсов", () => {
    const src = readFileSync(fileURLToPath(new URL("../../components/CallDetails.tsx", import.meta.url)), "utf8");
    expect(src).toContain("translationResetFor(");
  });
});
