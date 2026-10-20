import { z } from "zod";
import { processNewCustomerLeadPolicy } from "../services/leads/intake.js";
import { logSystemError } from "../lib/systemError.js";
import type { JobHandler } from "./registry.js";

const schema = z.object({ version: z.literal(1), actionId: z.string().uuid() }).strict();
export const customerIntakePolicyJob: JobHandler<z.infer<typeof schema>> = {
  type: "customer-intake-policy", schema,
  backoff: attempt => Math.min(2 ** attempt, 16) * 30_000,
  async run(payload) { await processNewCustomerLeadPolicy(payload.actionId); },
  async onGiveUp(payload) {
    await logSystemError("background-jobs", "Новая заявка сохранена, но её правило назначения не завершилось; проверьте карточку", {
      dedupKey: `customer-intake-policy:${payload.actionId}`,
    });
  },
};
