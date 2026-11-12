import { CUSTOMER_LEAD_ONLY_INTAKE_JOB, customerLeadOnlyIntakeSchema, runCustomerLeadOnlyIntake,
  type CustomerLeadOnlyIntake } from "../lib/customerLeadOnlyCore.js";
import { logSystemError } from "../lib/systemError.js";
import type { JobHandler } from "./registry.js";

/** Заявка из ядра в режиме «только заявки» (lib/customerLeadOnlyCore.ts): ждёт, пока ход отпустит ответ. */
export const customerLeadOnlyIntakeJob: JobHandler<CustomerLeadOnlyIntake> = {
  type: CUSTOMER_LEAD_ONLY_INTAKE_JOB, schema: customerLeadOnlyIntakeSchema,
  backoff: attempt => Math.min(2 ** attempt, 3) * 5000,
  async run(payload) {
    const result = await runCustomerLeadOnlyIntake(payload);
    // Ход ещё отправляет ответ: повторим через несколько секунд (до 24 попыток).
    if (result.status === "wait") throw new Error(result.reason);
  },
  async onGiveUp(payload) {
    await logSystemError("background-jobs", `[alarm] Режим «только заявки»: заявка из переписки не оформлена (диалог ${payload.conversationId}). Откройте переписку и заведите карточку руками.`, {
      dedupKey: `${CUSTOMER_LEAD_ONLY_INTAKE_JOB}:${payload.eventKey}`,
    });
  },
};
