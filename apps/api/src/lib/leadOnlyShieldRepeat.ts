import { renderOperatorReply, OPERATOR_PHRASES } from "../ai/operator/index.js";
import { leadOnlyOutgoing } from "../ai/leadOnlyMode.js";
import type { CustomerLeadOnlyTurnPlan } from "./customerLeadOnlyCore.js";

/**
 * ОТВЕТ ОПЕРАТОРА, КОТОРЫЙ ЩИТ ВЫРЕЖЕТ КАК ПОВТОР, НЕ УХОДИТ В ОЧЕРЕДЬ МОЛЧА (CRM-36, 26.11.2026).
 *
 * Корень. Живой путь ответа в WhatsApp, Instagram и Facebook — оператор приёма заявок (режим «только заявки»). Его
 * собственный сторож повтора (ai/operator/index.ts::withoutOwnRepeats) смотрит на ДВА последних ответа бота, а щит
 * исходящих (lib/outboundShield.ts) — на сутки: третий дословный повтор за 24 часа он не выпускает на транспорте.
 * Фраза «агент свяжется с вами», сказанная утром, днём и вечером через другие реплики, проходила сторож оператора,
 * ложилась в очередь, и на отправке щит её вырезал: часть уходила в «не отправлено», клиент не получал ничего, а в
 * памяти оператора ход считался отвеченным. Ядро свободной модели и страховочная дверь спрашивают щит заранее
 * (customerReplyRepeatBlocked, аудит молчания 16.11); путь оператора этого не делал.
 *
 * Правило теперь одно для всех путей ответа ядра: перед записью в очередь спросить щит. Вырежет — другая формулировка
 * тех же шагов (варианты фраз оператора, смысл не меняется). Все варианты уже звучали — тишина с сигналом человеку
 * («клиент повторяет, бот не может ответить другими словами»), как у собственного сторожа оператора, а не невидимый
 * отказ на транспорте. Заявка и пометка хода (intakes) не трогаются: они уходят в любом случае.
 */
export async function leadOnlyPlanAvoidingShieldRepeat(plan: CustomerLeadOnlyTurnPlan,
  repeatBlocked: (texts: string[]) => Promise<Set<string>>): Promise<CustomerLeadOnlyTurnPlan> {
  if (!plan.text) return plan;
  const { steps, language } = plan.operator;
  const variants = Math.max(1, ...steps.map(step => OPERATOR_PHRASES[step.key][language].length));
  const candidates = new Set<string>();
  // Сдвиг варианта у всех шагов разом: фразы оператора одного шага — синонимы, смысл ответа тот же.
  for (let shift = 1; shift < variants; shift++) {
    const text = renderOperatorReply(steps.map(step => ({ ...step, variant: step.variant + shift })), language);
    if (text) candidates.add(leadOnlyOutgoing(text, language));
  }
  candidates.delete(plan.text);
  const blocked = await repeatBlocked([plan.text, ...candidates]);
  if (!blocked.has(plan.text)) return plan;
  const other = [...candidates].find(text => !blocked.has(text));
  if (other) return { ...plan, text: other };
  return { ...plan, text: null, signal: plan.signal ?? { kind: "follow_up", reason: "repeat_question" } };
}
