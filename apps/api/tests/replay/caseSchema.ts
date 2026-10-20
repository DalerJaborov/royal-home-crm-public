import { z } from "zod";

const sampling = z.object({ channel: z.string(), language: z.string(), media: z.string(), stratum: z.string(), population: z.number().int().positive(), sampleSize: z.number().int().positive(), weight: z.number().positive() }).strict();
export const goldenRecordSchema = z.object({
  id: z.string().regex(/^Д\d{3}$/), error: z.enum(["yes", "no", "uncertain"]), classes: z.array(z.string()), severity: z.string(),
  evidence: z.array(z.object({ timestamp: z.string(), clientQuote: z.string(), botQuote: z.string(), reason: z.string() }).strict()),
  expectedReply: z.string(), goldenTurns: z.array(z.object({ clientText: z.string().min(1), context: z.string(), expectedBehavior: z.string(), forbiddenBehavior: z.string() }).strict()).min(1),
  limitations: z.union([z.string(), z.array(z.string())]), reviewer: z.string(), sampling,
}).strict();
export const sampleRecordSchema = sampling.extend({ id: z.string(), text: z.string() }).strict();
export type GoldenRecord = z.infer<typeof goldenRecordSchema>;
export type SampleRecord = z.infer<typeof sampleRecordSchema>;
