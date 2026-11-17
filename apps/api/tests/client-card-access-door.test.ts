import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decideClientCardAccess } from "../src/lib/clientCardAccess.js";

/**
 * ОДНА ДВЕРЬ «ЧТО ВИДИТ СОТРУДНИК В КАРТОЧКЕ» (аудит 17.11.2026, S1).
 *
 * Правило раньше жило копиями в четырёх маршрутах, и копии разошлись: бывший
 * агент (`lastAgentId`) получал всю карточку. Здесь — решение по уровням и
 * сторож: в маршрутах и инструментах помощника сравнивать `lastAgentId` для
 * решения о доступе нельзя — только через lib/clientCardAccess.ts.
 */

const A = "agent-a";
const B = "agent-b";
const accepted = new Date();

describe("decideClientCardAccess", () => {
  it("руководство с правом видеть всех — полный доступ, как и было", () => {
    expect(decideClientCardAccess(undefined, { assignedAgentId: B, lastAgentId: A, acceptedAt: null }, false)).toBe("full");
  });
  it("свой принятый — полный, свой непринятый — только имя", () => {
    expect(decideClientCardAccess(A, { assignedAgentId: A, acceptedAt: accepted }, false)).toBe("full");
    expect(decideClientCardAccess(A, { assignedAgentId: A, acceptedAt: null }, false)).toBe("nameOnly");
  });
  it("своя сделка по чужому клиенту — полный", () => {
    expect(decideClientCardAccess(A, { assignedAgentId: B, lastAgentId: A, acceptedAt: accepted }, true)).toBe("full");
  });
  it("бывший агент — только «передана», в том числе когда лид ушёл в очередь", () => {
    expect(decideClientCardAccess(A, { assignedAgentId: B, lastAgentId: A, acceptedAt: accepted }, false)).toBe("transferred");
    expect(decideClientCardAccess(A, { assignedAgentId: null, lastAgentId: A, acceptedAt: null }, false)).toBe("transferred");
  });
  it("посторонний — отказ", () => {
    expect(decideClientCardAccess(A, { assignedAgentId: B, lastAgentId: B, acceptedAt: accepted }, false)).toBe("denied");
    expect(decideClientCardAccess(A, { assignedAgentId: null, lastAgentId: null, acceptedAt: null }, false)).toBe("denied");
  });
});

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const GUARDED_DIRS = ["routes", "ai/assistant/tools"];

function listTs(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return listTs(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/** Сравнение с `lastAgentId` — признак своего, второго решения о доступе к карточке. */
const LAST_AGENT_ACCESS_RE = /lastAgentId\s*[!=]==|[!=]==\s*[\w.?]*lastAgentId\b/;

describe("сторож: доступ к карточке решает только lib/clientCardAccess.ts", () => {
  it("регулярка ловит то, что обязана ловить", () => {
    expect(LAST_AGENT_ACCESS_RE.test("const wasMine = client.lastAgentId === ownAgentId;")).toBe(true);
    expect(LAST_AGENT_ACCESS_RE.test("if (ownAgentId !== client.lastAgentId) return")).toBe(true);
    expect(LAST_AGENT_ACCESS_RE.test("select: { lastAgentId: true }")).toBe(false);
  });

  it("ни один маршрут и инструмент помощника не сравнивает lastAgentId сам", () => {
    const offenders = GUARDED_DIRS.flatMap((d) => listTs(path.join(SRC, d)))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split(/\r?\n/)
          .map((line, i) => ({ file: path.relative(SRC, file).replace(/\\/g, "/"), line: i + 1, text: line.trim() }))
          .filter((l) => !l.text.startsWith("//") && !l.text.startsWith("*") && LAST_AGENT_ACCESS_RE.test(l.text)),
      );
    expect(offenders).toEqual([]);
  });
});
