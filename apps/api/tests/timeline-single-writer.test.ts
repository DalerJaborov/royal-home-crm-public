import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * СТОРОЖ ЕДИНОГО ВХОДА `lib/timeline.ts` (задание Б1, 17.09.2026, П-10,
 * `docs/audit/lead-ownership-17-09.md` §2, `docs/audit/recon-17-09/04-timeline-authorship.md`).
 *
 * Тот же приём, что и `assigned-agent-single-writer.test.ts`: прямая запись
 * `interaction.create(`/`interaction.createMany(` в обход `lib/timeline.ts` —
 * это ровно тот путь, которым раньше автоматика подписывалась живым человеком
 * (директорский фолбэк, «лид снят и переназначен» от лица нового агента,
 * ИИ-правки, унаследовавшие автора звонка). Правило простое: единственный файл,
 * которому можно писать `Interaction`, — `lib/timeline.ts` сама (и то, что не
 * относится к продовому коду — тесты и одноразовые скрипты).
 *
 * БЕЛЫЙ СПИСОК ЗАКРЫТ (Б2, 18.09.2026): все 19 файлов, что оставались с задания
 * Б1 (17.09.2026), переведены на `logTimeline`/`logTimelineMany` — см. отчёт
 * задания Б2. В множестве остался только сам `lib/timeline.ts`.
 */

const SRC_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../src");

const WHITELIST_FILES = new Set([path.join("lib", "timeline.ts")]);

const WHITELIST_DIR_SEGMENTS = ["tests", "seed", "__mocks__", "scripts"];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (WHITELIST_DIR_SEGMENTS.includes(entry.name) || entry.name === "generated") continue;
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const CALL_RE = /\.interaction\.(create|createMany)\s*\(/g;

interface Violation {
  file: string;
  line: number;
}

function findViolations(file: string): Violation[] {
  const src = fs.readFileSync(file, "utf-8");
  const violations: Violation[] = [];
  for (const m of src.matchAll(CALL_RE)) {
    const upToHit = src.slice(0, m.index!);
    const line = upToHit.split("\n").length;
    violations.push({ file, line });
  }
  return violations;
}

describe("Interaction — единственная точка записи lib/timeline.ts", () => {
  it("нигде вне lib/timeline.ts (и временного белого списка Б2) не пишет interaction.create(/createMany( напрямую", () => {
    const files = listTsFiles(SRC_ROOT).filter((f) => {
      const rel = path.relative(SRC_ROOT, f);
      return !WHITELIST_FILES.has(rel);
    });

    const allViolations = files.flatMap((f) => findViolations(f));

    if (allViolations.length > 0) {
      const report = allViolations
        .map((v) => `  ${path.relative(SRC_ROOT, v.file)}:${v.line}`)
        .join("\n");
      throw new Error(
        `Найдена прямая запись Interaction в обход lib/timeline.ts:\n${report}\n\n` +
          `Каждая запись хронологии обязана идти через logTimeline()/logTimelineMany() ` +
          `(П-10, docs/audit/lead-ownership-17-09.md) — иначе запись рискует подписаться ` +
          `не тем, кто действовал. Новый файл в этом списке — либо переведите его на ` +
          `logTimeline, либо добавьте в WHITELIST_FILES выше с пометкой TODO Б2 и строкой в отчёте.`
      );
    }

    expect(allViolations).toHaveLength(0);
  });
});
