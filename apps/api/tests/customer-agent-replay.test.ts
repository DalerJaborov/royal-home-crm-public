import { describe, expect, it } from "vitest";
import net from "node:net";
import dns from "node:dns";
import dgram from "node:dgram";
import http2 from "node:http2";
import tls from "node:tls";
import http from "node:http";
import childProcess from "node:child_process";
import { ReplayLedger } from "./replay/ledger.js";
import { ScriptedModel, STAND_QUALIFY_CAPABILITIES } from "./replay/scriptedModel.js";
import { parseExport, locateQuote } from "./replay/dataset.js";
import { replayReport } from "./replay/report.js";
import { assertion, unavailable } from "./replay/assertions.js";
import { installOfflineSandbox } from "./replay/sandbox.js";
import { offlineDatabase } from "./replay/fakeDatabase.js";
import { ReplayTasks } from "./replay/taskTracker.js";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalNewArtifact, within } from "../../../scripts/replayArtifactPaths.mjs";
import { standOwnership } from "./replay/standOwnership.js";
import { assertReplaySourceFingerprint, readReplaySourceFingerprint } from "../../../scripts/replaySourceIntegrity.mjs";

function sourceFixture(run: (directory: string, git: (...args: string[]) => void) => void) {
  const directory = mkdtempSync(join(tmpdir(), "p04-source-fixture-"));
  try {
    const hooks = join(directory, "empty-hooks"); mkdirSync(hooks);
    const git = (...args: string[]) => { childProcess.execFileSync("git", ["-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgSign=false", "-c", "user.name=ReplayFixture", "-c", "user.email=replay-fixture@example.invalid", ...args], { cwd: directory, stdio: "ignore" }); };
    for (const path of ["apps/api/src", "apps/api/tests/replay", "packages/shared/src", "scripts", "docs"]) mkdirSync(join(directory, path), { recursive: true });
    writeFileSync(join(directory, ".gitignore"), "apps/api/src/generated/\n");
    writeFileSync(join(directory, "apps/api/src/runtime.ts"), "export const marker = 1;\n");
    writeFileSync(join(directory, "apps/api/tests/replay/grader.ts"), "export const grader = 1;\n");
    for (const file of ["runParallelVerdict.ts", "testEnvPin.ts"]) writeFileSync(join(directory, "apps/api/tests", file), "// synthetic loaded test helper\n");
    writeFileSync(join(directory, "package.json"), "{}\n");
    for (const file of ["replay-customer-agent.mjs", "replayArtifactPaths.mjs", "replaySourceIntegrity.mjs"]) writeFileSync(join(directory, "scripts", file), "// synthetic grader source\n");
    git("init", "--quiet", "--object-format=sha1"); git("config", "core.fsmonitor", "false"); git("config", "core.untrackedCache", "false");
    git("add", "."); git("commit", "--quiet", "-m", "Synthetic source fixture");
    run(directory, git);
  } finally {
    if (!within(resolve(tmpdir()), resolve(directory))) throw new Error("Unsafe source fixture cleanup");
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("P04 structural graders and offline boundary", () => {
  it("source gate allows harness/docs WIP and ignored private generation, preserving the declared grader fingerprint", () => sourceFixture((directory) => {
    writeFileSync(join(directory, "docs", "wip.md"), "Documentation WIP\n");
    writeFileSync(join(directory, "apps/api/tests/replay", "wip.ts"), "export const companion = 1;\n");
    mkdirSync(join(directory, "apps/api/src/generated")); writeFileSync(join(directory, "apps/api/src/generated/private.ts"), "// ignored generation prerequisite\n");
    expect(() => assertReplaySourceFingerprint(directory, readReplaySourceFingerprint(directory))).not.toThrow();
  }));
  it.each(["apps/api/src/newEngine.ts", "packages/shared/src/newSchema.ts", "package-lock.json"])("untracked runtime input %s refuses before a child or publication", (path) => sourceFixture((directory) => {
    const before = readReplaySourceFingerprint(directory); writeFileSync(join(directory, path), "synthetic unexpected runtime input\n");
    let childStarted = false;
    expect(() => { assertReplaySourceFingerprint(directory, before); childStarted = true; }).toThrow(/runtime source/);
    expect(childStarted).toBe(false);
  }));
  it("tracked runtime changes after execution forbid final publication", () => sourceFixture((directory) => {
    const before = readReplaySourceFingerprint(directory); writeFileSync(join(directory, "apps/api/src/runtime.ts"), "export const marker = 2;\n");
    const target = join(directory, "final.json");
    expect(() => { assertReplaySourceFingerprint(directory, before); writeFileSync(target, "{}\n"); }).toThrow(/runtime source/);
    expect(existsSync(target)).toBe(false);
  }));
  it("changed HEAD and changed grader each refuse the recorded fingerprint", () => sourceFixture((directory, git) => {
    const before = readReplaySourceFingerprint(directory);
    writeFileSync(join(directory, "docs", "new-head.md"), "Synthetic new revision\n"); git("add", "."); git("commit", "--quiet", "-m", "Synthetic new HEAD");
    expect(() => assertReplaySourceFingerprint(directory, before)).toThrow(/HEAD changed/);
    const next = readReplaySourceFingerprint(directory); writeFileSync(join(directory, "apps/api/tests/replay/grader.ts"), "export const grader = 2;\n");
    expect(() => assertReplaySourceFingerprint(directory, next)).toThrow(/grader changed/);
  }));
  it.each(["runParallelVerdict.ts", "testEnvPin.ts"])("loaded gate/env helper %s belongs to the grader identity", (file) => sourceFixture((directory) => {
    const before = readReplaySourceFingerprint(directory);
    writeFileSync(join(directory, "apps/api/tests", file), "// mutated synthetic loaded helper\n");
    expect(() => assertReplaySourceFingerprint(directory, before)).toThrow(/grader changed/);
  }));
  it("canonical artifact containment follows directory junctions and handles ..foo literally", () => {
    const directory = mkdtempSync(join(tmpdir(), "p04-path-fixture-"));
    try {
      const corpus = join(directory, "corpus"); const source = join(directory, "source"); mkdirSync(corpus); mkdirSync(source);
      const link = join(directory, "external-link"); symlinkSync(source, link, process.platform === "win32" ? "junction" : "dir");
      expect(canonicalNewArtifact(join(link, "new.json")).target).toBe(join(source, "new.json"));
      expect(within(source, canonicalNewArtifact(join(link, "new.json")).target)).toBe(true);
      expect(within(directory, join(directory, "..foo", "new.json"))).toBe(true);
      expect(within(corpus, join(directory, "corpus-sibling", "new.json"))).toBe(false);
    } finally { if (!resolve(directory).startsWith(resolve(tmpdir()))) throw new Error("Unsafe fixture cleanup"); rmSync(directory, { recursive: true, force: true }); }
  });
  it("an apparently safe DB name cannot cross the marker worktree/identity boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "p04-owner-fixture-"));
    try {
      const marker = join(directory, "marker.json"); writeFileSync(marker, JSON.stringify({ version: 1, database: "agent_4748", host: "127.0.0.1", port: 15500, worktree: directory, nonce: "00000000-0000-4000-8000-000000000001" }));
      expect(standOwnership("postgresql://postgres:postgres@localhost:15500/agent_4748", marker, directory).url).toContain("127.0.0.1");
      expect(() => standOwnership("postgresql://postgres:postgres@localhost:15500/agent_4746", marker, directory)).toThrow();
      expect(() => standOwnership("postgresql://postgres:postgres@example.invalid:15500/agent_4748", marker, directory)).toThrow();
      expect(() => standOwnership("postgresql://postgres:postgres@localhost:5432/agent_4748", marker, directory)).toThrow();
    } finally { if (!resolve(directory).startsWith(resolve(tmpdir()))) throw new Error("Unsafe owner fixture cleanup"); rmSync(directory, { recursive: true, force: true }); }
  });
  it("an unfinished drain and a settled caught background violation remain red", async () => {
    const ledger = new ReplayLedger(); const tasks = new ReplayTasks();
    let finish!: () => void; tasks.track(new Promise<void>((resolve) => { finish = resolve; }));
    expect(() => tasks.assertSettled(ledger)).toThrow(/incomplete-background/);
    finish(); await Promise.resolve(); expect(tasks.pending.size).toBe(0); expect(() => ledger.assertClean()).toThrow(/sticky/);
  });
  it("preserves final draft/multiline unknown evidence and distinguishes quote occurrences/roles", () => {
    const parsed = parseExport('Черновик: {"phone":"hindsight"}\n[opaque] БОТ: Цена?\n[opaque] КЛИЕНТ: Цена?\nunknown continuation\n[opaque] КЛИЕНТ: Цена?');
    expect(parsed.nonTurnLines).toEqual(['Черновик: {"phone":"hindsight"}', 'unknown continuation']);
    expect(locateQuote(parsed.turns, "Цена?", 1)).toBe(1); expect(locateQuote(parsed.turns, "Цена?", 2)).toBe(2);
    expect(() => locateQuote(parsed.turns, "hindsight", 1)).toThrow();
  });
  it("an extra model call stays red after its exception is swallowed", async () => {
    const ledger = new ReplayLedger(); const model = new ScriptedModel([{ endpoint: "lead-qualify", result: null, qualification: "intentional-invalid" }], ledger);
    expect(await model.call("lead-qualify")).toBeNull();
    try { await model.call("lead-qualify"); } catch { /* actual business catches cannot clear ledger */ }
    expect(() => ledger.assertClean()).toThrow(/sticky/);
  });
  it("an invalid topic cannot masquerade as positive model coverage even if the setup error is caught", () => {
    const ledger = new ReplayLedger();
    try {
      new ScriptedModel([{ endpoint: "lead-qualify", result: { reply: ["Уточните район."], ready: false, confident: true, topic: "property", openQuestion: "", clientAnsweredOpenQuestion: false }, qualification: STAND_QUALIFY_CAPABILITIES }], ledger);
    } catch { /* A swallowed fixture rejection must still make the run red. */ }
    expect(ledger.attempts).toEqual([{ kind: "diagnostic", operation: "invalid-positive-submit-reply-fixture", allowed: false }]);
    expect(() => ledger.assertClean()).toThrow(/sticky/);
  });
  it.each(["$executeRaw", "$queryRaw", "$transaction", "$connect", "$disconnect"])("top-level DB %s denial survives a swallowed runtime exception", async (method) => {
    const ledger = new ReplayLedger(); const db = offlineDatabase(ledger) as Record<string, (...args: unknown[]) => Promise<unknown>>;
    try { await db[method](); } catch { /* cannot erase attempted forbidden I/O */ }
    expect(ledger.attempts).toEqual([{ kind: "db", operation: method, allowed: false }]);
    expect(() => ledger.assertClean()).toThrow(/sticky/);
  });
  it.each(["fetch", "socket", "dns", "dns-instance", "dns-promise-instance", "udp", "http", "http2", "tls", "subprocess"])("actual forbidden %s consumer never reaches original I/O", async (kind) => {
    const ledger = new ReplayLedger(); const restore = installOfflineSandbox(ledger);
    try {
      try {
        if (kind === "fetch") await fetch("https://example.invalid/");
        if (kind === "socket") net.createConnection({ host: "127.0.0.1", port: 1 });
        if (kind === "dns") dns.lookup("example.invalid", () => {});
        if (kind === "dns-instance") new dns.Resolver().resolve4("example.invalid", () => {});
        if (kind === "dns-promise-instance") await new dns.promises.Resolver().resolve4("example.invalid");
        if (kind === "udp") dgram.createSocket("udp4");
        if (kind === "http") http.get("http://127.0.0.1:1/");
        if (kind === "http2") http2.connect("https://example.invalid");
        if (kind === "tls") tls.connect({ host: "example.invalid", port: 443 });
        if (kind === "subprocess") childProcess.spawn("node", ["--version"]);
      } catch { /* fallback may succeed */ }
      expect(() => ledger.assertClean()).toThrow(/sticky/);
      expect(ledger.attempts.filter((item) => !item.allowed)).toHaveLength(1);
    } finally { restore(); }
  });
  it("wrong independent oracle and denied effects make report exit red; unavailable is never passed", () => {
    const report = replayReport({ sha: "a".repeat(40), hashes: {}, integrity: { records: 1, selectedTurns: 1 }, layer: "mutation-control", flags: {}, cases: [{ key: "synthetic", channel: "WEBSITE", language: "tg", media: "text", historicalLabel: "uncertain", transcript: [], draft: null, receipts: [], unavailable: [],
      attempts: [{ kind: "effect", operation: "callback", allowed: false }], assertions: [assertion("price", "Independent USD card oracle", "100000000 TJS", "100000000 USD"), unavailable("booking", "Historical booking", "unknown")] }] });
    expect(report.accounting.assertionsFailed).toBe(1); expect(report.accounting.assertionsUnavailable).toBe(1); expect(report.exitCode).toBe(1);
    report.cases[0].assertions[0].status = "passed";
    expect(replayReport({ ...report, integrity: report.integrity }).exitCode).toBe(1);
  });
});
