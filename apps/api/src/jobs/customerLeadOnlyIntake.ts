import { CUSTOMER_LEAD_ONLY_INTAKE_JOB, customerLeadOnlyIntakeSchema, runCustomerLeadOnlyIntake,
  type CustomerLeadOnlyIntake } from "../lib/customerLeadOnlyCore.js";
import { alarmLeadOnlyIntake } from "../lib/leadOnlyHandover.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import type { JobHandler } from "./registry.js";

/**
 * Заявка из ядра в режиме «только заявки» (lib/customerLeadOnlyCore.ts): ждёт, пока ход отпустит ответ.
 * Ответ так и не ушёл (Meta лежит дольше всех повторов отправки) — последняя попытка заводит заявку
 * всё равно: заявка не теряется никогда (ревью 13.11.2026, №9). Не вышло и это — тревога и человек.
 */
export const customerLeadOnlyIntakeJob: JobHandler<CustomerLeadOnlyIntake> = {
  type: CUSTOMER_LEAD_ONLY_INTAKE_JOB, schema: customerLeadOnlyIntakeSchema,
  backoff: attempt => Math.min(2 ** attempt, 6) * 5000,
  async run(payload) {
    const result = await runCustomerLeadOnlyIntake(payload);
    // Ход ещё отправляет ответ: повторим через несколько секунд.
    if (result.status === "wait") throw new Error(result.reason);
  },
  async onGiveUp(payload) {
    try {
      await runCustomerLeadOnlyIntake(payload, { force: true });
    } catch (err) {
      await logSystemError("background-jobs", `[alarm] Режим «только заявки»: заявка из переписки не оформлена (диалог ${payload.conversationId}): ` +
        `${describeError(err)}. Откройте переписку и заведите карточку руками.`, { dedupKey: `${CUSTOMER_LEAD_ONLY_INTAKE_JOB}:${payload.eventKey}` });
      // Задание ставится только для заявки с номером или пометки в карточке: сбой — тревога, а не «кто-то интересуется».
      await alarmLeadOnlyIntake({ conversationId: payload.conversationId, propertyId: payload.propertyId, reason: "intake_failed" })
        .catch(() => undefined);
    }
  },
};
