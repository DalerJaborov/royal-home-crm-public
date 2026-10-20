import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ВЫХОД ТОЛЬКО ЧЕРЕЗ lib/signOut (аудит Codex 04.10.2026, WEB-PAGES08).
 *
 * Профиль (десктоп и телефон) слал POST /auth/logout сам, мимо signOut: push-подписка
 * браузера оставалась, и уведомления с именами клиентов шли на вышедшее устройство.
 * Сторож исходников, как noApiHrefs.test.ts: рендерить экран здесь нечем (нет jsdom).
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !full.includes("__tests__")) out.push(full);
  }
  return out;
}

const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;

describe("выход из аккаунта", () => {
  it("POST /auth/logout живёт только в lib/signOut.ts", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file.endsWith(`lib${path.sep}signOut.ts`)) continue;
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!COMMENT.test(line) && line.includes("/auth/logout")) offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("обе кнопки «Выйти» в Профиле зовут signOut", () => {
    const text = fs.readFileSync(path.join(SRC, "pages/Profile.tsx"), "utf8");
    expect(text).toMatch(/import \{ signOut \} from "\.\.\/lib\/signOut"/);
    expect(text.match(/void signOut\(\)/g)?.length).toBe(2);
  });
});
