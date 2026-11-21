import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * СТОРОЖ ОДНОЙ ДВЕРИ ПУБЛИКАЦИИ INSTAGRAM (22.11.2026, lib/instagramPublisher.ts).
 *
 * Класс поломки: путь публикации сам берёт личный ключ и сам спрашивает
 * `instagramTokenIdentity` — тогда смена пароля Instagram (11–12.11) снова глушит
 * публикацию, хотя ключ компании готов. Правило: файл, который зовёт публикацию или
 * лимит публикаций Instagram, выбирает ключ ТОЛЬКО через `resolveInstagramPublisher`
 * и `instagramTokenIdentity` не зовёт. Проверяется по исходникам apps/api/src целиком,
 * поэтому новый путь публикации без двери тоже покраснеет.
 *
 * Проверка самого сторожа: верните в lib/photoPosts.ts вызов
 * `instagramTokenIdentity(creds.igToken)` — тест обязан покраснеть.
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** Вызовы, которым нужен выбранный ключ и id аккаунта Instagram. */
const PUBLISH_CALLS = [
  "publishInstagramReel",
  "publishInstagramStory",
  "publishInstagramStoryImage",
  "publishInstagramCarousel",
  "checkInstagramPublishingQuota",
  "checkInstagramPublishingLimit",
];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Код без комментариев: имена в комментариях («см. publishInstagramStory») — не вызовы. */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Есть ли в коде ВЫЗОВ имени (а не объявление `function имя(`). */
function calls(code: string, name: string): boolean {
  const all = code.match(new RegExp(`\\b${name}\\s*\\(`, "g"))?.length ?? 0;
  const declared = code.match(new RegExp(`function\\s+${name}\\s*\\(`, "g"))?.length ?? 0;
  return all > declared;
}

describe("публикация в Instagram выбирает ключ одной дверью", () => {
  const files = tsFiles(SRC).filter((f) => !f.endsWith(`${path.sep}instagramPublisher.ts`));
  const publishing = files.filter((f) => {
    const code = codeOf(f);
    return PUBLISH_CALLS.some((name) => calls(code, name));
  });

  it("пути публикации найдены (иначе сторож сторожит пустоту)", () => {
    const names = publishing.map((f) => path.basename(f));
    for (const expected of ["socialPublish.ts", "instagramStories.ts", "photoPosts.ts", "socialReposts.ts", "socialDigests.ts", "socialVideoPosts.ts", "socialVideoChannels.ts"]) {
      expect(names, expected).toContain(expected);
    }
  });

  it("ни один путь публикации не зовёт instagramTokenIdentity сам и каждый идёт через resolveInstagramPublisher", () => {
    const offenders = publishing.filter((f) => {
      const code = codeOf(f);
      return calls(code, "instagramTokenIdentity") || !calls(code, "resolveInstagramPublisher");
    });
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it("фоновое дозавершение контейнеров — тем же ключом, что публикация", () => {
    const code = codeOf(path.join(SRC, "lib", "instagramPendingContainers.ts"));
    expect(calls(code, "instagramTokenIdentity")).toBe(false);
    expect(calls(code, "resolveInstagramPublisher")).toBe(true);
  });
});
