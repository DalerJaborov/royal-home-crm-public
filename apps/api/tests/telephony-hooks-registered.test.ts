import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  pickAgentForLead,
  setPickAgentForLeadHook,
} from "../src/lib/telephony/pickAgentForLeadHook.js";

/**
 * КРЮЧКИ ТЕЛЕФОНИИ ЗАРЕГИСТРИРОВАНЫ В ОБОИХ ПРОЦЕССАХ.
 *
 * Крючки (`set…Hook`) существуют, чтобы разорвать циклы импортов в кластере
 * телефонии (аудит 03.09.2026): модуль объявляет пустое место, а настоящую
 * функцию подставляет точка входа. Отсюда и опасность: **незарегистрированный
 * крючок не падает, а тихо возвращает `null`.** Уберут строку регистрации из
 * `worker.ts` — фоновые задания просто перестанут назначать агента, сборка и
 * типы будут чисты, тесты зелены, а лиды поедут в общую очередь без агента.
 *
 * Ни `index.ts`, ни `worker.ts` до 25.09.2026 не покрывал ни один тест (список
 * в CLAUDE.md), а проверить регистрацию иначе как по их исходнику нельзя: сами
 * файлы при импорте поднимают процесс целиком. Поэтому читаем текст — тот же
 * приём, что в `settings-snapshot-secrets.test.ts` (читает `schema.prisma`).
 */

const INDEX = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const WORKER = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
/**
 * ТРЕТЬЕ МЕСТО, ГДЕ ЖИВЁТ ТОТ ЖЕ СПИСОК, — подготовка тестов. `tests/setup.ts`
 * повторяет регистрацию точек входа, иначе прогон шёл бы с пустыми крючками.
 * Значит и разъехаться он может так же: крючок добавили в `index.ts` и
 * `worker.ts`, в подготовку забыли — и тесты честно зелены на поведении,
 * которого в проде нет (или наоборот).
 */
const SETUP = readFileSync(new URL("./setup.ts", import.meta.url), "utf8");

/** Крючки, нужные ОБОИМ процессам: назначение агента идёт и по HTTP, и фоном. */
const BOTH = [
  "setPickAgentForLeadHook",
  "setAssignAgentForLeadHook",
  "setRecordAssignReasonHook",
  "setRewardFirstCallHook",
  "setLiveIncomingLookup",
];

/**
 * Крючки только для `index.ts` — с причиной, иначе список превращается в
 * отписку. `setConsultantCallEndedHook` зовёт `onConsultantCallEnded` на конце
 * входящего звонка, а подписки ARI (`startAriEvents`) живут только в `index.ts`:
 * в `worker.ts` этот крючок сработать не от чего.
 */
const INDEX_ONLY: Record<string, string> = {
  setConsultantCallEndedHook: "подписки ARI живут только в index.ts",
};

/**
 * Комментарии выбрасываются ПЕРЕД подсчётом — иначе закомментированная строка
 * читается как живая регистрация. Поймано подменой: `// setPickAgentForLeadHook(…)`
 * в `worker.ts` оставлял проверку зелёной, хотя фон уже никого не назначал.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function registrations(source: string, name: string): number {
  // Вызов, а не импорт: `setX(` в начале выражения. Импорт идёт как `, setX }`
  // или `{ setX }` — скобки после имени там нет.
  return stripComments(source).split(`${name}(`).length - 1;
}

describe("Крючки телефонии зарегистрированы", () => {
  for (const name of BOTH) {
    it(`${name} ставится и в index.ts, и в worker.ts, и в подготовке тестов`, () => {
      expect(registrations(INDEX, name), `${name} не зарегистрирован в index.ts`).toBeGreaterThanOrEqual(1);
      expect(registrations(WORKER, name), `${name} не зарегистрирован в worker.ts`).toBeGreaterThanOrEqual(1);
      expect(
        stripComments(SETUP).includes(`${name}`),
        `${name} не ставится в tests/setup.ts — прогон пойдёт с пустым крючком и будет зелёным`
      ).toBe(true);
    });
  }

  for (const [name, why] of Object.entries(INDEX_ONLY)) {
    it(`${name} ставится только в index.ts (${why})`, () => {
      expect(registrations(INDEX, name)).toBeGreaterThanOrEqual(1);
      expect(registrations(WORKER, name)).toBe(0);
    });
  }

  it("новых крючков в кластере телефонии не появилось мимо списка", () => {
    // Список выше — не документация, а договор: новый set…Hook обязан быть
    // либо в BOTH, либо в INDEX_ONLY с причиной. Иначе его забудут поставить в
    // worker.ts, и узнается это по тому, что фоном ничего не назначается.
    const known = new Set([...BOTH, ...Object.keys(INDEX_ONLY)]);
    const declared = new Set<string>();
    for (const source of [INDEX, WORKER]) {
      for (const m of source.matchAll(/\bset([A-Z][A-Za-z]*)(?:Hook|Lookup)\s*\(/g)) {
        declared.add(`set${m[1]}${m[0].includes("Lookup") ? "Lookup" : "Hook"}`);
      }
    }
    const unknown = [...declared].filter((n) => !known.has(n));
    expect(unknown).toEqual([]);
  });
});

describe("Крючок подбора агента", () => {
  it("до регистрации не назначает никого, а не падает", async () => {
    // Свежая копия модуля: в этом процессе крючок УЖЕ поставлен подготовкой
    // тестов (tests/setup.ts), поэтому «до регистрации» иначе не увидеть.
    vi.resetModules();
    const fresh = await import("../src/lib/telephony/pickAgentForLeadHook.js");
    expect(await fresh.pickAgentForLead()).toBeNull();
  });

  it("после регистрации зовёт настоящую функцию и передаёт ей оба довода", async () => {
    const calls: Array<[unknown, unknown]> = [];
    setPickAgentForLeadHook(async (exclude, kind) => {
      calls.push([exclude, kind]);
      return "агент-1";
    });

    expect(await pickAgentForLead(["a", "b"], "SELLER")).toBe("агент-1");
    expect(calls).toEqual([[["a", "b"], "SELLER"]]);

    // Возврат к исходному состоянию не нужен: модуль в этом процессе больше
    // никем не используется, а изоляция vitest даёт следующему файлу свою копию.
  });
});
