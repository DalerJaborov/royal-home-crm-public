import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { goldenRecordSchema, sampleRecordSchema } from "./caseSchema.js";

export const DATASET_HASHES = {
  "golden-set.json": "69ce64082a5d725ef5f26a019f39cd5d9c0bb29bbee14a3a517aaa685b7fa125",
  "sample.json": "4adb97a82f60cfa437ba53a986c7df4f745438daa636994b9e535f5a116ab485",
  "sampling.json": "17aa5db33594ba7d8489ee7df90c4c8e14809b5a570146e0e34693ee75a43785",
  "statistics.json": "36067de7a3e4ab239a04e26d0dcbb248055e045357d9a04194a1c1c715b81d8b",
} as const;
export interface ExportTurn { role: "user" | "assistant"; timestamp: string; content: string }
/** Headers/final draft/unknown lines remain evidence, never initial state. */
export function parseExport(text: string): { turns: ExportTurn[]; nonTurnLines: string[] } {
  const turns: ExportTurn[] = []; const nonTurnLines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\[([^\]]+)\] (КЛИЕНТ|БОТ): ?(.*)$/.exec(line);
    if (match) turns.push({ role: match[2] === "КЛИЕНТ" ? "user" : "assistant", timestamp: match[1], content: match[3] });
    else nonTurnLines.push(line);
  }
  return { turns, nonTurnLines };
}
export function locateQuote(turns: ExportTurn[], quote: string, occurrence: number, substring = false): number {
  if (!Number.isInteger(occurrence) || occurrence < 1) throw new Error("Invalid quote occurrence");
  const candidates = turns.flatMap((turn, index) => turn.role === "user" && (substring ? turn.content.includes(quote) : turn.content === quote) ? [index] : []);
  const index = candidates[occurrence - 1];
  if (index === undefined) throw new Error("Golden quote occurrence absent from client evidence");
  return index;
}
export function loadReplayDataset(directory: string) {
  if (!directory) throw new Error("Explicit dataset directory required");
  const root = resolve(directory); const hashes: Record<string, string> = {};
  for (const [file, expected] of Object.entries(DATASET_HASHES)) {
    const bytes = readFileSync(join(root, file)); hashes[file] = createHash("sha256").update(bytes).digest("hex");
    if (hashes[file] !== expected) throw new Error(`Immutable dataset checksum mismatch: ${file}`);
  }
  const golden = z.array(goldenRecordSchema).length(200).parse(JSON.parse(readFileSync(join(root, "golden-set.json"), "utf8")));
  const sample = z.array(sampleRecordSchema).length(200).parse(JSON.parse(readFileSync(join(root, "sample.json"), "utf8")));
  const ids = golden.map((record) => record.id);
  if (new Set(ids).size !== 200 || new Set(sample.map((record) => record.id)).size !== 200 || golden.reduce((n, record) => n + record.goldenTurns.length, 0) !== 210) throw new Error("Dataset identity/turn accounting invalid");
  const cases = golden.map((record) => {
    const source = sample.find((item) => item.id === record.id);
    if (!source || source.channel !== record.sampling.channel || source.stratum !== record.sampling.stratum || source.weight !== record.sampling.weight) throw new Error("Golden/sample stratum identity mismatch");
    const parsed = parseExport(source.text);
    const quoteEvidence = record.goldenTurns.map((turn) => {
      const matches = parsed.turns.filter((message) => message.role === "user" && message.content.includes(turn.clientText)).length;
      return { matches, status: matches ? "role-line-match" as const : "unavailable" as const,
        reason: matches ? null : "Literal quote not located in a parsed client line; multiline/non-turn evidence not inferred" };
    });
    return { record, source, quoteEvidence, ...parsed };
  });
  const quotes = cases.flatMap((item) => item.quoteEvidence);
  return { root, hashes, cases, records: 200 as const, selectedTurns: 210 as const,
    quoteAccounting: { roleLineMatchedTurns: quotes.filter((quote) => quote.status !== "unavailable").length, unavailableTurns: quotes.filter((quote) => quote.status === "unavailable").length } };
}
