/**
 * «БОТ ОТВЕЧАЕТ САМ» + ИЗВЕСТНЫЙ НОМЕР → ЗАЯВКА АГЕНТУ (ревью #283; сведено с оператором приёма заявок #311, 19.11.2026).
 *
 * Номер клиента известен (WhatsApp, номер в словах клиента) — это заявка (решение владельца 13.11: лид = номер). До #311
 * ядро брало для этого принудительный шаг «escalate» старой двери режима «только заявки»; оператор (#311) этот шаг убрал,
 * и в режиме ядро сюда не доходит вовсе (весь ход ведёт оператор, docs/bot-operator/SPEC.md). Вне режима заявка
 * оформляется тем же фоновым приёмом ядра, что и у оператора (`customer-lead-only-intake`, lib/customerLeadOnlyCore.ts):
 * задание ставится в одной транзакции с ответом, приём тихий, сбой приёма — тревога, «Прочие обращения» при обещанном
 * звонке — тревога. Время звонка из слов клиента («завтра после обеда») — в пометке карточки.
 *
 * Чистой части здесь нет: номер WhatsApp читается из базы (resolveWhatsAppLeadIdentity).
 */
import { clientOwnWords } from "../ai/untrustedContent.js";
import { leadOnlyCallbackTime } from "../ai/leadOnlyMode.js";
import { extractVolunteeredPhone } from "./shared/phoneText.js";
import { resolveWhatsAppLeadIdentity } from "./whatsappPhone.js";
import { sealCustomerLeadOnlyIntake, type CustomerLeadOnlyIntake } from "./customerLeadOnlyCore.js";

export interface SelfAnswerLeadInput {
  channel: string;
  peer: string;
  conversationId: string | null | undefined;
  eventKey: string;
  /** Слова клиента этого хода (с отложенными), без вложенного чужого текста. */
  inputText: string;
  turns: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  /** Модель не справилась с вопросом (не её собственная передача): пометка «бот не ответил», одна такая заявка на разговор. */
  modelFailed?: boolean;
}

/** Номер для звонка: названный в этом сообщении, иначе номер WhatsApp отправителя, иначе названный клиентом раньше. */
async function selfAnswerLeadPhone(input: SelfAnswerLeadInput, own: string): Promise<{ phone: string; whatsappPhone: string | null } | null> {
  const wa = input.channel === "WHATSAPP" ? await resolveWhatsAppLeadIdentity(input.channel, input.peer) : null;
  const named = extractVolunteeredPhone(own);
  if (named) return { phone: named, whatsappPhone: wa?.waPhone ?? null };
  if (wa?.leadPhone) return { phone: wa.leadPhone, whatsappPhone: wa.waPhone };
  const earlier = input.turns.filter(turn => turn.role === "user").reverse()
    .map(turn => extractVolunteeredPhone(clientOwnWords(turn.text))).find(Boolean);
  return earlier ? { phone: earlier, whatsappPhone: wa?.waPhone ?? null } : null;
}

/** Задание заявки для хода ядра или null, если номера нет (тогда — просьба номера, ai/botSelfAnswerText.ts). */
export async function selfAnswerLeadIntake(input: SelfAnswerLeadInput): Promise<CustomerLeadOnlyIntake | null> {
  if (!input.conversationId) return null;
  const own = clientOwnWords(input.inputText);
  const found = await selfAnswerLeadPhone(input, own);
  if (!found) return null;
  // Объект в заявку не кладём: вопрос к агенту не делает клиента покупателем объекта из фокуса (тот же довод, что у
  // прежней двери: «залипший» объект увёл бы заявку чужому агенту). Намерение решает классификатор приёма.
  return sealCustomerLeadOnlyIntake({ eventKey: input.eventKey, conversationId: input.conversationId, scenario: "escalate", propertyId: null,
    ...(input.modelFailed ? { modelFailed: true as const } : {}) },
  { phone: found.phone, whatsappPhone: found.whatsappPhone, clientText: own.slice(0, 1500), promised: "call", lead: true,
    callbackWhen: leadOnlyCallbackTime(own) });
}
