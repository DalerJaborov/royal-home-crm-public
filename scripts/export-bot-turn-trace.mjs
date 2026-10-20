import { register } from "node:module";

/** Explicit bounded read-only local export. Contains pseudonyms; text opt-in retains residual PII risk. */
register("tsx/esm", import.meta.url);
const { parseTraceExportArgs, readTraceExport } = await import("../apps/api/src/lib/botTurnTraceExport.ts");
const options = parseTraceExportArgs(process.argv.slice(2));
const { prisma } = await import("../apps/api/src/db.ts");
try {
  const { payloads, omitted } = await readTraceExport(prisma.botTurnTrace, options);
  for (const payload of payloads) process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (omitted) process.stderr.write("[bot-trace] invalid stored projections omitted\n");
} finally { await prisma.$disconnect(); }
