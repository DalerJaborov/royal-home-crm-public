import { z } from "zod";
import { botTurnTracePayloadSchema, type BotTurnTracePayload } from "@royal-home/shared";

const optionsSchema = z.strictObject({ from: z.date(), to: z.date(), limit: z.number().int().min(1).max(1000) }).refine(({ from, to }) => from < to && to.getTime() - from.getTime() <= 7 * 86400000);
const datesSchema = z.strictObject({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }), limit: z.string().regex(/^\d+$/) });
export interface TraceExportOptions { from: Date; to: Date; limit: number }
export interface TraceExportStore {
  findMany(input: { where: { createdAt: { gte: Date; lt: Date }; expiresAt: { gt: Date }; schemaVersion: number }; orderBy: { createdAt?: "asc"; id?: "asc" }[]; take: number; select: { payload: true } }): Promise<{ payload: unknown }[]>;
}
/** CLI boundary: no DB imports or raw argument values in validation errors. */
export function parseTraceExportArgs(argv: readonly string[]): TraceExportOptions {
  const raw: Record<string, string> = {};
  for (const arg of argv) {
    const match = /^--(from|to|limit)=(.+)$/.exec(arg);
    if (!match || raw[match[1]] !== undefined) throw Error("Require unique --from=ISO --to=ISO --limit=1..1000");
    raw[match[1]] = match[2];
  }
  const dates = datesSchema.safeParse(raw);
  if (!dates.success) throw Error("Require ISO timestamps with timezone and an explicit integer limit");
  const options = { from: new Date(dates.data.from), to: new Date(dates.data.to), limit: Number(dates.data.limit) };
  if (!optionsSchema.safeParse(options).success) throw Error("Require from < to, range <=7 days, limit 1..1000");
  return options;
}
/** Read-only, bounded, stable ordering; expired and malformed projections omitted. */
export async function readTraceExport(store: TraceExportStore, options: TraceExportOptions, now = new Date()): Promise<{ payloads: BotTurnTracePayload[]; omitted: number }> {
  optionsSchema.parse(options);
  const rows = await store.findMany({ where: { createdAt: { gte: options.from, lt: options.to }, expiresAt: { gt: now }, schemaVersion: 1 }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: options.limit, select: { payload: true } });
  const payloads: BotTurnTracePayload[] = []; let omitted = 0;
  for (const row of rows) {
    const parsed = botTurnTracePayloadSchema.safeParse(row.payload);
    if (parsed.success) payloads.push(parsed.data); else omitted++;
  }
  return { payloads, omitted };
}
