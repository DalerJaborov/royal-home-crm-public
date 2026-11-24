import { formatClientCode, formatClientName, maskPhones } from "@royal-home/shared";
import { prisma } from "../db.js";
import { sendPushToAgents } from "../push.js";
import { investigationRecipients } from "./investigationNotifications.js";
import { reportSecuritySignal, securityAutomationOn } from "./securityAutomation.js";
import { describeError } from "./describeError.js";
import { logSystemError } from "./systemError.js";

/**
 * «АГЕНТ УВОДИТ КЛИЕНТА МИМО CRM» — БЕЗ ИИ (23.11.2026).
 *
 * До 23.11 этот сигнал давал только ночной судья диалогов (ai/botAudit.ts, тип
 * находки agent_bypassed_crm): модель читала случайные переписки за месяц и, найдя
 * «пишите мне в личку», ставила карточку на проверку СБ. Судью удалили вместе с
 * «Обучением бота», а сам сигнал нужен: это прямой признак увода сделки.
 *
 * Теперь — дешёвые шаблоны прямо на отправке реплики сотрудника (текст и
 * расшифровка голосового в переписке с клиентом), рядом с детектором «агент
 * спросил номер» (lib/agentPhoneAskDetector.ts, он и зовёт эту проверку). Каждая
 * реплика, а не выборка за месяц, — и без токенов.
 *
 * ЧТО ЛОВИМ: сотрудник зовёт клиента в СВОЙ канал — «пишите мне в личку / в
 * ватсап / в телеграм», «на мой номер», «мой ватсап +992…»; по-русски,
 * по-таджикски и латиницей. ЧТО НЕ ЛОВИМ НАРОЧНО:
 *  - канал компании: «пишите нам в WhatsApp», «наш номер», «в ватсап компании»;
 *  - «напишите в WhatsApp» без «мне/мой/личку» — чей это канал, не понять;
 *  - слова клиента: проверяются только реплики сотрудника клиенту. Заметки в
 *    карточке («клиент просил писать в ватсап») и расшифровки звонков (там говорят
 *    обе стороны) сюда не идут.
 *
 * Действие — то же, что было у судьи: при включённой автоматике СБ карточка
 * встаёт на проверку и получатели дел СБ получают пуш; при выключенной (так на
 * проде с 18.11) — сигнал в дело и уведомление директору и РОП без изменения
 * карточки (lib/securityAutomation.ts — одна дверь).
 */

/** Чужой канал связи: мессенджеры по-русски, по-таджикски и латиницей. */
const CHANNEL = String.raw`(?:личк\S*|лс|ватсап\S*|вотсап\S*|вацап\S*|whats\s?app|watsapp|vatsap|телеграм\S*|телегу|телегр\S*|telegram|tg|тг|вайбер\S*|viber|имо|imo)`;
/** Глагол «напиши/позвони/скинь» в любой вежливой форме (ru). */
const VERB_RU = String.raw`(?:на)?пиш(?:и|ите)|черкни(?:те)?|скин(?:ь|ьте)|отправ(?:ь|ьте)|присыла(?:й|йте)|пришли(?:те)?|звони(?:те)?|позвони(?:те)?|перезвони(?:те)?|добав(?:ь|ьте)(?:\s+меня)?|стучи(?:те)?`;

const OFF_CRM_PATTERNS: RegExp[] = [
  // «пишите мне в личку», «напиши мне в ватсап», «скиньте мне в телеграм»
  new RegExp(String.raw`(?:^|[^а-яёa-z])(?:${VERB_RU})\s+мне\s+(?:в|на|во|по)\s+${CHANNEL}`, "iu"),
  // «пишите в личку» — личка сама по себе личная, «мне» не обязательно
  new RegExp(String.raw`(?:^|[^а-яёa-z])(?:${VERB_RU})\s+(?:в|во)\s+(?:личк\S*|лс|личные\s+сообщения)`, "iu"),
  // «пишите на мой номер / в мой ватсап», «звоните на мой личный»
  new RegExp(String.raw`(?:^|[^а-яёa-z])(?:${VERB_RU})\s+(?:мне\s+)?(?:на|в)\s+мо(?:й|и|ю)\s+(?:личн\S*\s+)?(?:номер|телефон|${CHANNEL})`, "iu"),
  // «мой ватсап +992…», «мой телеграм @…»: сотрудник диктует личный канал
  new RegExp(String.raw`(?:^|[^а-яёa-z])мо(?:й|и)\s+(?:личн\S*\s+)?${CHANNEL}\s*[:\-–—]?\s*(?:\+?\d|@)`, "iu"),
  // Таджикский: «ба ман дар ватсап нависед», «ба ватсапи ман нависед», «ба рақами ман занг занед»
  /(?:^|\s)ба\s+ман\s+(?:дар|ба|тавассути)\s+(?:ватсап|вотсап|whatsapp|телеграм|telegram|имо|imo)\S*\s+(?:навис|занг)/iu,
  /(?:^|\s)(?:ба|дар)\s+(?:ватсап|вотсап|whatsapp|телеграм|telegram|рақам)\S*\s+(?:и\s+)?ман\s+(?:навис|занг)/iu,
  /(?:^|\s)ба\s+шахсӣ\s+(?:навис|нависед)/iu,
  // Латиница (транслит и английский): «napishite mne v whatsapp», «pishi v lichku», «write me on whatsapp»
  /(?:^|[^a-z])(?:na)?pish(?:i|ite)\s+(?:mne\s+)?(?:v|na)\s+(?:lichk\w*|ls|whats\s?app|watsapp|vatsap\w*|telegram\w*|telegu|moy\s+nomer|moi\s+nomer)/iu,
  /(?:^|[^a-z])(?:write|text|message|call)\s+me\s+(?:on|in|at|via)\s+(?:whats\s?app|telegram|viber|my\s+(?:number|phone|whats\s?app|telegram))/iu,
  /(?:^|[^a-z])ba\s+man\s+(?:dar|ba)\s+(?:whats\s?app|vatsap\w*|telegram\w*)\s+navis/iu,
];

/** Возвращает исходник сработавшего шаблона (для отладки) или null. Чистая функция. */
export function detectOffCrmLead(text: string): string | null {
  if (!text || text.length < 6) return null;
  for (const pattern of OFF_CRM_PATTERNS) {
    if (pattern.test(text)) return pattern.source;
  }
  return null;
}

/** Каналы реплики сотрудника клиенту. Заметки и звонки нарочно не входят (см. шапку). */
export type OffCrmLeadChannel = "text" | "voice";

export interface OffCrmLeadCheck {
  agentId: string;
  clientId: string | null;
  channel: OffCrmLeadChannel;
  text: string;
}

/**
 * Проверить реплику сотрудника и, если он зовёт клиента в личный канал, поднять
 * подозрение СБ. Звать фоном (void): отправка клиенту не ждёт и не падает от этого.
 * Один сигнал на клиента в сутки (Душанбе не важен — ключ дедупа, не отчёт).
 */
export async function checkAgentOffCrmLead(input: OffCrmLeadCheck): Promise<boolean> {
  if (!input.clientId) return false;
  if (!detectOffCrmLead(input.text)) return false;
  const clientId = input.clientId;
  try {
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: { id: true, shortId: true, fullName: true, kind: true, deletedAt: true, securityReview: true },
    });
    // Уже на проверке — не дублируем пуш (как lifecycle.ts и прежний судья).
    if (!client || client.deletedAt || client.securityReview === "PENDING") return false;

    // Цитата — с маской номера: дело СБ и уведомление видят не только директор.
    const quote = maskPhones(input.text.replace(/\s+/g, " ").trim()).text.slice(0, 160);
    const what = `сотрудник позвал клиента в личный канал (${input.channel === "voice" ? "голосовое" : "сообщение"}): «${quote}»`;

    if (!(await securityAutomationOn())) {
      await reportSecuritySignal({ clientId: client.id, subjectAgentId: input.agentId, source: "agent-off-crm-lead",
        dedupeKey: `agent-off-crm-lead:${client.id}:${input.agentId}:${new Date().toISOString().slice(0, 10)}`, what });
      return true;
    }

    await prisma.client.update({
      where: { id: client.id },
      data: { securityReview: "PENDING", securityReviewRequestedAt: new Date(), securityReviewedAt: null, securityReviewedById: null },
    });
    const reviewers = await investigationRecipients();
    await sendPushToAgents(reviewers, {
      title: `${formatClientName(client)}: подозрение на увод сделки`,
      body: `Сотрудник позвал клиента в личный канал мимо CRM — ${formatClientCode(client.shortId, client.kind)}. Требуется проверка СБ.`,
      url: `/clients/${client.shortId}`,
      tag: `security-review-${client.id}`,
    });
    return true;
  } catch (err) {
    void logSystemError("investigation", `Проверка СБ «увод мимо CRM» (клиент ${clientId}) не поставлена: ${describeError(err)}`);
    return false;
  }
}
