import { z } from "zod";
import type { JobHandler } from "./registry.js";
import { runRecruitmentRecovery, closeInterruptedRecruitmentRecovery } from "../lib/recruitmentRecovery.js";
const schema = z.object({ version: z.literal(1), id: z.string().uuid() }).strict();
export const recruitmentRecoveryJob: JobHandler<z.infer<typeof schema>> = {
  type: "recruitment-recovery", schema, timeoutMs: 90_000, backoff: () => 60_000,
  async run(payload) { await runRecruitmentRecovery(payload.id); },
  // The durable row remains visible. Never enqueue a second physical send.
  async onGiveUp(payload) { await closeInterruptedRecruitmentRecovery(payload.id); },
};
