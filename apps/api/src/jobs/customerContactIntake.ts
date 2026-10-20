import { z } from "zod";
import { createCustomerLeadAfterContactAction } from "../lib/customerNewLeadBridge.js";
import { logSystemError } from "../lib/systemError.js";
import type { JobHandler } from "./registry.js";

const schema = z.object({ version: z.literal(1), actionId: z.string().uuid() }).strict();
export const customerContactIntakeJob: JobHandler<z.infer<typeof schema>> = {
  type: "customer-contact-intake", schema, backoff: attempt => Math.min(2 ** attempt, 3) * 5000,
  async run(payload) {
    const result = await createCustomerLeadAfterContactAction(payload.actionId);
    // This wait happens before any bridge effect, while the model/send still
    // owns the turn. It never retries an UNKNOWN send or uncertain commit.
    if (result.status === "unavailable" && ["turn_not_settled", "intake_read_unavailable"].includes(result.reason)) throw new Error(result.reason);
    // Lost commit acknowledgement is NOT permission to create/send again.
    // Existing action journal remains the authority, without fallback/handover.
    if (result.status === "unknown") {
      try { await logSystemError("background-jobs", "Не подтверждено сохранение новой заявки после хода; проверьте журнал действия", {
        dedupKey: `customer-contact-intake:${payload.actionId}`,
      }); } catch { console.warn("customer_intake_unknown_diagnostic_unavailable"); }
    }
  },
  async onGiveUp(payload) {
    await logSystemError("background-jobs", "Обработка контакта после ответа требует проверки; автоматической передачи клиенту нет", {
      dedupKey: `customer-contact-intake:${payload.actionId}`,
    });
  },
};
