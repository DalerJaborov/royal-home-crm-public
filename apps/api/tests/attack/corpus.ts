import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { scenarioSchema, type AttackScenario } from "./types.js";

// Corpus reader. Synthetic scenarios live in tests/attack/corpus/*.json (in git). The real, anonymised corpus lives OUTSIDE git
// and is passed as a directory (--dataset); it has the same format, files are read here and never copied anywhere.

export const SYNTHETIC_CORPUS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "corpus");

export class CorpusError extends Error {}

/** Reads every *.json array in a directory (files named *-rules.json / *-reference.json are not scenario files). */
export function loadCorpusDir(directory: string): AttackScenario[] {
  if (!statSync(directory).isDirectory()) throw new CorpusError(`not a directory: ${directory}`);
  const scenarios: AttackScenario[] = [], seen = new Set<string>();
  for (const name of readdirSync(directory).filter(file => file.endsWith(".json") && !/(?:-rules|-reference|\.report)\.json$/.test(file)).sort()) {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, name), "utf8"));
    const list = z.array(z.unknown()).parse(parsed);
    list.forEach((raw, index) => {
      const result = scenarioSchema.safeParse(raw);
      if (!result.success) throw new CorpusError(`${name}[${index}]: ${result.error.issues.slice(0, 3).map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
      if (seen.has(result.data.id)) throw new CorpusError(`${name}[${index}]: duplicate scenario id ${result.data.id}`);
      seen.add(result.data.id); scenarios.push(result.data);
    });
  }
  return scenarios;
}

export function selectScenarios(all: readonly AttackScenario[], options: { category?: string; limit?: number; ids?: readonly string[] }): AttackScenario[] {
  let chosen = options.category ? all.filter(scenario => scenario.category === options.category) : [...all];
  if (options.ids?.length) chosen = chosen.filter(scenario => options.ids!.includes(scenario.id));
  return options.limit && options.limit > 0 ? chosen.slice(0, options.limit) : chosen;
}
