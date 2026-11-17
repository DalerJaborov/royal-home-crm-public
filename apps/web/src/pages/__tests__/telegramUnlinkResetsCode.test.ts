import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Аудит 04.10.2026, WEB-PAGES07: после «Отвязать» одноразовый код оставался в
 * локальном состоянии, ветка «Привязать» не возвращалась. Рендера без jsdom нет,
 * поэтому проверяем сам обработчик отвязки в исходнике.
 */
describe("профиль: отвязка Telegram", () => {
  it("успешная отвязка сбрасывает использованный код", () => {
    const src = readFileSync(fileURLToPath(new URL("../Profile.tsx", import.meta.url)), "utf8");
    const start = src.indexOf("function TelegramLinkSection");
    const body = src.slice(start, src.indexOf("TelegramModerationToggle({", start));
    expect(body).toMatch(/unlink\.mutate\(undefined,\s*\{\s*onSuccess:\s*\(\)\s*=>\s*setLink\(null\)/);
  });

  // Аудит безопасности 17.11.2026: сервер требует подтверждения личности (428) —
  // экран обязан провести через окно подтверждения и повторить запрос, а не
  // показать ошибку. Окно своё, поэтому общее (GlobalStepUpHost) не должно открыться вторым.
  it("«Привязать» на 428 открывает окно подтверждения и повторяет запрос", () => {
    const src = readFileSync(fileURLToPath(new URL("../Profile.tsx", import.meta.url)), "utf8");
    const start = src.indexOf("function TelegramLinkSection");
    const body = src.slice(start, src.indexOf("TelegramModerationToggle({", start));
    expect(body).toContain("claimStepUp()");
    expect(body).toMatch(/err\.status === 428\) setConfirmOpen\(true\)/);
    expect(body).toMatch(/<StepUpDialog[\s\S]*onConfirmed=\{\(\) => \{\s*setConfirmOpen\(false\);\s*startLink\(\);/);
  });
});
