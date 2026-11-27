import { z } from "zod";
import { consumeCustomerInboxTicket } from "../lib/customerIngressProducer.js";
import { logSystemError } from "../lib/systemError.js";
import type { JobHandler } from "./registry.js";

/** resume — задание сторожа «бот догоняет» (lib/customerTurnCatchUp.ts): часы хода ставятся, когда очередь дошла до него. */
const schema = z.object({ version: z.literal(1), eventKey: z.string().regex(/^[a-f0-9]{64}$/), resume: z.literal(true).optional() }).strict();

/** Queue completion means the durable ticket was examined. Its HELD state
 * remains visible; it is never a fabricated planned/customer response. */
export const customerInboxConsumeJob: JobHandler<z.infer<typeof schema>> = {
  type: "customer-inbox-consume", schema,
  backoff: attempt => Math.min(2 ** attempt, 16) * 5_000,
  async run(payload) {
    if (payload.resume) {
      const { runCustomerCatchUpTurn } = await import("../lib/customerTurnCatchUp.js");
      await runCustomerCatchUpTurn(payload.eventKey);
      return;
    }
    await consumeCustomerInboxTicket(payload.eventKey);
  },
  async onGiveUp(payload) {
    await logSystemError("background-jobs", "Сохранённое входящее сообщение требует проверки обработки", {
      dedupKey: `customer-inbox-consume:${payload.eventKey}`,
    });
    // A ticket left RECEIVED would count as core work in flight and block every
    // revision advance (prod 26.11.2026). HELD is still claimable by any other
    // live job for it, so this closes nothing that could still answer; the
    // orphan sweep (customerAgentOrphanClaims.ts) then does not report it twice.
    const { prisma } = await import("../db.js");
    await prisma.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "processingState"='HELD',"errorCode"='consume_job_gave_up'
      WHERE "eventKey"=${payload.eventKey} AND "processingState"='RECEIVED' AND "leaseOwner" IS NULL`.catch(error =>
      console.error("[customer-inbox] give-up hold failed:", error instanceof Error ? error.message : error));
    // The customer is still unanswered: say so to a person, not only to the journal.
    const { reportUnansweredCustomerTurn } = await import("../lib/customerTurnSilence.js");
    void reportUnansweredCustomerTurn(payload.eventKey, "consume_job_gave_up", { gaveUp: true });
  },
};
