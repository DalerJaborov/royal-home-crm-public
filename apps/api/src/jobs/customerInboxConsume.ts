import { z } from "zod";
import { consumeCustomerInboxTicket } from "../lib/customerIngressProducer.js";
import { logSystemError } from "../lib/systemError.js";
import type { JobHandler } from "./registry.js";

const schema = z.object({ version: z.literal(1), eventKey: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** Queue completion means the durable ticket was examined. Its HELD state
 * remains visible; it is never a fabricated planned/customer response. */
export const customerInboxConsumeJob: JobHandler<z.infer<typeof schema>> = {
  type: "customer-inbox-consume", schema,
  backoff: attempt => Math.min(2 ** attempt, 16) * 5_000,
  async run(payload) { await consumeCustomerInboxTicket(payload.eventKey); },
  async onGiveUp(payload) {
    await logSystemError("background-jobs", "Сохранённое входящее сообщение требует проверки обработки", {
      dedupKey: `customer-inbox-consume:${payload.eventKey}`,
    });
  },
};
