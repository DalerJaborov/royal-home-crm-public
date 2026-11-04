import { z } from "zod";
import { prisma } from "../db.js";
import { ASSISTANT_PRICE_UNDO_JOB } from "../lib/assistantPriceUndoJournal.js";
import { readPriceUndoGuard } from "../lib/propertyChangeRequests.js";
import { logSystemError } from "../lib/systemError.js";
import type { JobHandler } from "./registry.js";

const schema = z.object({ requestId: z.string().uuid() }).strict();

export const assistantPriceUndoJob: JobHandler<z.infer<typeof schema>> = {
  type: ASSISTANT_PRICE_UNDO_JOB,
  schema,
  backoff: (attempt) => Math.min(2 ** attempt, 16) * 30_000,
  async run({ requestId }) {
    const request = await prisma.propertyChangeRequest.findUnique({
      where: { id: requestId }, select: { kind: true, payload: true, status: true, authorId: true },
    });
    if (request?.kind !== "PRICE_CHANGE" || request.status !== "PENDING" ||
      readPriceUndoGuard(request.payload)?.assistant?.actionId !== requestId) return;
    const { approvePropertyChangeRequest } = await import("../routes/properties/changeRequestExecutor.js");
    const outcome = await approvePropertyChangeRequest({
      requestId, actorId: request.authorId, note: "Откат цены в ИИ-помощнике",
    });
    if (!outcome.ok && (outcome.status >= 500 || outcome.status === 403)) {
      throw new Error("Could not apply staged assistant price undo");
    }
  },
  async onGiveUp({ requestId }) {
    await logSystemError("background-jobs", "Откат цены Шабнам требует проверки в CRM", {
      dedupKey: `assistant-price-undo:${requestId}`,
    });
  },
};
