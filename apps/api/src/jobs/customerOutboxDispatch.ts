import { z } from "zod";
import { dispatchCustomerOutboxPart, holdExpiredCustomerDeliveryClaims } from "../lib/customerDeliveryDispatcher.js";
import { logSystemError } from "../lib/systemError.js";
import { withCustomerOutboxDeliveryTrace } from "../lib/customerAgentDeliveryTrace.js";
import type { JobHandler } from "./registry.js";

const schema = z.object({ version: z.literal(1), partId: z.string().uuid() }).strict();

export const customerOutboxDispatchJob: JobHandler<z.infer<typeof schema>> = {
  type: "customer-outbox-dispatch", schema,
  backoff: attempt => Math.min(2 ** attempt, 32) * 5_000,
  async run(payload) {
    // Expired claims are UNKNOWN, never reset to READY. A process restart
    // cannot justify repeating a POST that may already have reached Meta.
    await holdExpiredCustomerDeliveryClaims();
    const result = await withCustomerOutboxDeliveryTrace(payload.partId, () => dispatchCustomerOutboxPart(payload.partId));
    if (result.status === "waiting" || result.projectionPending) {
      // An accepted part repairs its local projection only; the dispatcher
      // must never re-send it. UNKNOWN/NOT_SENT stay terminal for automation.
      throw new Error(result.projectionPending ? "Customer delivery projection pending" : "Customer delivery claim busy");
    }
    if (result.status === "unknown" || result.status === "not_sent") {
      // Best-effort staff diagnostic, deduplicated by the existing facility.
      // It is not a delivery receipt or a crash-proof exactly-once notification.
      await logSystemError("background-jobs", "Площадка не подтвердила сохранённую отправку; автоматический повтор не выполнен, нужна проверка квитанции", {
        dedupKey: `customer-outbox-dispatch:${payload.partId}`,
      });
    }
  },
  async onGiveUp(payload) {
    await logSystemError("background-jobs", "Сохранённая отправка требует проверки квитанции или локальной истории; повтор не выполнен", {
      dedupKey: `customer-outbox-dispatch:${payload.partId}`,
    });
  },
};
