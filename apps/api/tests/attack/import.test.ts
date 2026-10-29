import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { conversationsToScenarios, findingsToRules, lessonsToReference, maskPhones, languageHint, WINDOW } from "./importReal.js";
import { scenarioSchema } from "./types.js";

// Three SYNTHETIC records stand in for the real export (which never enters git).
const conversations = [
  { channel: "INSTAGRAM", peer: "p1", at: "2026-10-01T10:00:00Z", messages: [
    { at: 1, mid: "m1", role: "user", content: "Салом, ин хона чанд пул? Рақамам +992900112233" },
    { at: 2, mid: "m2", role: "assistant", content: "Шумо кадом объектро дар назар доред?" },
    { at: 3, mid: "m3", role: "user", content: "{{synthetic}} 1042" },
  ] },
  { channel: "WHATSAPP", peer: "p2", at: "2026-10-02T10:00:00Z", messages: Array.from({ length: 14 }, (_, index) => ({ at: index, mid: `w${index}`, role: index % 2 ? "assistant" : "user", content: index % 2 ? "Что вас интересует?" : `Здравствуйте, сколько стоит квартира номер ${index}?` })) },
  { channel: "TELEGRAM", peer: "p3", at: "2026-10-03T10:00:00Z", messages: [{ at: 1, mid: "t1", role: "user", content: "привет" }] },
  { channel: "FACEBOOK", peer: "p4", at: "2026-10-04T10:00:00Z", messages: [{ at: 1, mid: "f1", role: "assistant", content: "Здравствуйте" }] },
];
const findings = [
  { channel: "INSTAGRAM", type: "repetition", quote: "Какой район? Какой район?", why: "same question twice", severity: "high" },
  { channel: "INSTAGRAM", type: "invented_fact", quote: "цена 100", why: "no fact", severity: "high" },
  { channel: "FACEBOOK", type: "links_phone", quote: "звоните 900112233", why: "phone in comment", severity: "medium" },
  { channel: "INSTAGRAM", type: "something_new", quote: "x", why: "y", severity: "low" },
];
const lessons = [
  { kind: "tone", channel: "INSTAGRAM", bot: "Нет.", human: "К сожалению, сейчас такого нет, подберу похожий.", lesson: "Не отвечайте односложно", active: true },
  { kind: "tone", channel: "INSTAGRAM", bot: "Нет.", human: "К сожалению, сейчас такого нет, подберу похожий.", lesson: "дубль", active: true },
  { kind: "facts", channel: "WHATSAPP", bot: "Стоит 100", human: "Цену уточню", lesson: "old", active: false },
  { kind: "facts", channel: "WHATSAPP", bot: "", human: "Цену уточню", lesson: "no bad", active: true },
];

describe("real corpus importer (synthetic records)", () => {
  it("turns conversations into valid scenarios: user turns only, windows of six, unsupported channels skipped", () => {
    const { scenarios, stats } = conversationsToScenarios(conversations);
    expect(stats).toMatchObject({ conversations: 4, scenarios: 3, skippedChannel: 1, skippedNoUserText: 1, windowsSplit: 1 });
    const first = scenarios[0];
    expect(first.turns.map(turn => turn.in)).toEqual(["Салом, ин хона чанд пул? Рақамам +992•••", "{{synthetic}} 1042"]);
    expect(first.turns[0].expect).toEqual({ language: "tg" });
    expect(first.turns[1].expect).toEqual({ noRepeatOfPreviousQuestion: true });
    const whatsapp = scenarios.filter(item => item.channel === "WHATSAPP");
    expect(whatsapp.map(item => item.turns.length)).toEqual([WINDOW, 1]);
    expect(whatsapp[0].turns.every(turn => turn.in.startsWith("Здравствуйте"))).toBe(true);
    for (const scenario of scenarios) expect(scenarioSchema.safeParse(scenario).success, scenario.id).toBe(true);
    expect(new Set(scenarios.map(item => item.id)).size).toBe(scenarios.length);
  });
  it("masks phone numbers again and gives language only when decisive", () => {
    expect(maskPhones("мой 901234567 и +992 90 123 45 67 ok")).not.toMatch(/\d{6}/);
    expect(languageHint("мехоҳам хона")).toBe("tg");
    expect(languageHint("Здравствуйте, сколько стоит квартира")).toBe("ru");
    expect(languageHint("👍")).toBeNull();
  });
  it("maps findings to judge rules and counts unknown types", () => {
    const rules = findingsToRules(findings);
    expect(rules.total).toBe(4);
    expect(rules.byType.repetition).toMatchObject({ count: 1, judgeRules: ["no-repeat-question", "no-identical-reply"] });
    expect(rules.byType.links_phone.count).toBe(1);
    expect(rules.enableRules).toEqual(["public-no-links-phone"]);
    expect(rules.unknownTypes).toEqual({ something_new: 1 });
    expect(rules.byType.links_phone.samples[0].quote).not.toMatch(/\d{7}/);
  });
  it("copies only active, complete, unique lesson pairs", () => {
    const reference = lessonsToReference(lessons);
    expect(reference.pairs).toHaveLength(1);
    expect(reference.pairs[0]).toMatchObject({ bad: "Нет.", good: expect.stringContaining("подберу"), lesson: "Не отвечайте односложно" });
    expect(reference.stats).toMatchObject({ total: 4, inactive: 1, incomplete: 1, duplicates: 1, written: 1 });
  });
});

describe("attack-import-real.mjs CLI", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const base = mkdtempSync(join(tmpdir(), "attack-import-"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const run = (src: string, out: string) => spawnSync(process.execPath, [join(root, "scripts/attack-import-real.mjs"), "--src", src, "--out", out], { encoding: "utf8", cwd: root });
  it("writes the three files outside the repo and refuses an output inside it", () => {
    const src = join(base, "src"), out = join(base, "out");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "real-conversations.json"), JSON.stringify(conversations)); writeFileSync(join(src, "real-findings.json"), JSON.stringify(findings));
    writeFileSync(join(src, "real-lessons.json"), JSON.stringify(lessons));
    const ok = run(src, out);
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout).scenarios.scenarios).toBe(3);
    for (const name of ["real-scenarios.json", "real-findings-rules.json", "real-lessons-reference.json"]) expect(JSON.parse(readFileSync(join(out, name), "utf8"))).toBeTruthy();
    const inside = run(src, join(root, "attack-import-should-not-exist"));
    expect(inside.status).toBe(2); expect(inside.stderr).toContain("outside the git repository");
  });
});
