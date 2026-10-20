/**
 * Детектор ЯВНОГО ОТКАЗА в переписке — план 03.09.2026, §D
 * (docs/audit-02-09-2026/19-plan-03-09-evening.md).
 *
 * НЕ ПУТАТЬ с детектором неактивности (§B того же плана, inactiveTrafficLight.ts/
 * clientWorkStatus.ts) — это разные вещи. Неактивность — пауза («сейчас не отвечает,
 * подождём»), отказ — окончательный ответ («сделка не состоится»). У этого детектора
 * планка уверенности ВЫШЕ: только прямые, недвусмысленные фразы клиента, без
 * интерпретации намёков или вежливых отговорок — те по-прежнему идут через
 * светофор неактивных.
 *
 * ОБРАЗЕЦ — agentPhoneAskDetector.ts: дешёвый regex без вызова ИИ, работает
 * синхронно и не блокирует ответ бота клиенту (вызывается фоном, `void`),
 * дедупликация через постоянное хранилище (AuditLog, не Notification.tag:
 * см. recentlySuspectedRefusal ниже за обоснованием).
 *
 * РЕШЕНИЕ Р-6 (17.09.2026, `docs/audit/lead-ownership-17-09.md` §4): детектор
 * больше НЕ зовёт lib/clientRefuse.ts::refuseClient сам. До этой правки
 * regex/AI-совпадение немедленно закрывало карточку («Без сделки») мимо
 * агента — а ирония, сарказм или цитата из чужого разговора закрывали живого
 * клиента без единого клика человека. Владельцу объяснили и он решил по
 * умолчанию: детектор только ПОДСКАЗЫВАЕТ — SYSTEM-запись с цитатой и кнопкой
 * подтверждения + уведомление держателю, статус клиента не меняется. Кнопочный
 * отказ агента (refuseClient, initiator="AGENT" или "CLIENT" по кнопке) не
 * тронут — вся механика передачи/СБ/Royal Score остаётся там же.
 */
import { REFUSAL_REASON_LABELS, type RefusalReason } from "@royal-home/shared";
import { prisma } from "../db.js";
import { sendPushToAgent } from "../push.js";
import { logSystemAudit } from "./audit.js";
import { logTimeline } from "./timeline.js";
import { refreshPropertiesOfSeller } from "./propertyAutoStatus.js";

/**
 * СНЯТИЕ ОБЪЕКТА — ЭТО ФАКТ ПРО ОБЪЕКТ, НЕ РЕШЕНИЕ О КЛИЕНТЕ (17.09.2026,
 * `docs/audit/lead-ownership-17-09.md`). «Продавец написал «уже продал»» — это
 * снятие объекта с продажи ПО СУТИ, независимо от того, закрыт ли ещё сам
 * клиент (Р-6 запретил детектору закрывать клиента автоматически, а не
 * трогать статус объекта). Импорт `refreshPropertiesOfSeller` был случайно
 * убран из этого файла отдельной правкой сборки — возвращён здесь.
 */
const PROPERTY_STATUS_REFUSAL_REASONS: ReadonlySet<RefusalReason> = new Set([
  "SOLD_SELF",
  "SOLD_VIA_OTHER_AGENCY",
  "WITHDRAWN_FROM_SALE",
]);

// ─── Паттерны ────────────────────────────────────────────────────────────────

interface RefusalPattern {
  re: RegExp;
  reason: RefusalReason;
}

/**
 * Слова рядом с «передумал», которые говорят «речь о ВРЕМЕНИ показа/встречи, а
 * не об отказе от сделки» — «передумал ехать в 5, приеду в 6» не должно закрывать
 * карточку. Голое «передумал»/«передумала» ловим ТОЛЬКО когда оно составляет
 * практически всё сообщение (см. isBareChangedMind) — короткое сообщение без
 * этих слов рядом с большой вероятностью и есть тот самый окончательный ответ,
 * который описал владелец («передумал» — литерал из ТЗ).
 */
const LOGISTICS_WORDS = ["показ", "встреч", "приех", "приду", "прийти", "заеха", "выехат", "созвон", "врем"];

/** Голое «передумал(а)» — самостоятельным коротким сообщением, без слов про
 *  время/показ/встречу рядом (см. LOGISTICS_WORDS выше). */
function isBareChangedMind(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 60) return false;
  if (!/передумал[аи]?/iu.test(t)) return false;
  const lower = t.toLowerCase();
  return !LOGISTICS_WORDS.some((w) => lower.includes(w));
}

const BUYER_PATTERNS: RefusalPattern[] = [
  // «купили через другое агентство / у других риелторов» — проверяем ДО BOUGHT_SELF:
  // более специфичная формулировка выигрывает у общего «уже купил».
  //
  // \S* ВМЕСТО \w* (та же ловушка, что задокументирована в agentPhoneAskDetector.ts):
  // JS-регэксп считает \w только [A-Za-z0-9_] — таджикская/русская кириллица в него
  // не входит, и «друг\w*» не доедает окончание «-ое» в «другое», обрывая совпадение
  // прямо посреди слова. \S* берёт любые непробельные символы до конца слова —
  // работает для любой кириллицы без явного перечисления диапазона букв.
  { re: /купил(?:и|а)?\s+(?:у\s+других|через\s+друг\S*\s+(?:агентств\S*|риелтор\S*|компани\S*)|в\s+друг\S*\s+агентств\S*)/iu, reason: "BOUGHT_VIA_OTHER_AGENCY" },
  { re: /уже\s+купил(?:а)?/iu, reason: "BOUGHT_SELF" },
  // Без \b на конце — по той же причине: \b считает границу слова по \w, а кириллица
  // в \w не входит, и «сам» перед запятой/точкой (не-\w с обеих сторон для JS) вообще
  // не находит границы. «сам» — префикс «самостоятельно» тоже, оба варианта ниже
  // безопасно перекрываются: оба ведут к одной и той же причине.
  { re: /купил(?:и|а)?\s+сам(?:а|и)?(?:\s|,|\.|!|\?|$)/iu, reason: "BOUGHT_SELF" },
  { re: /купил(?:и|а)?\s+самостоятельно/iu, reason: "BOUGHT_SELF" },
  { re: /нашл[иа]\s+(?:уже\s+)?сами(?:\s|,|\.|!|\?|$)/iu, reason: "BOUGHT_SELF" },
  { re: /не\s+буду\s+покупать/iu, reason: "CHANGED_MIND" },
  { re: /расхотел(?:а)?\s+покупать/iu, reason: "CHANGED_MIND" },
  { re: /передумал(?:а)?\s+покупать/iu, reason: "CHANGED_MIND" },
  { re: /не\s+хочу\s+(?:с\s+вами\s+)?(?:больше\s+)?работать/iu, reason: "CHANGED_MIND" },
  { re: /не\s+буду\s+(?:с\s+вами\s+)?работать/iu, reason: "CHANGED_MIND" },
];

const SELLER_PATTERNS: RefusalPattern[] = [
  { re: /продал(?:и|а)?\s+через\s+друг\S*\s+(?:агентств\S*|риелтор\S*|компани\S*)/iu, reason: "SOLD_VIA_OTHER_AGENCY" },
  { re: /продал(?:и|а)?\s+(?:с\s+помощью\s+)?друг\S*\s+риелтор\S*/iu, reason: "SOLD_VIA_OTHER_AGENCY" },
  { re: /уже\s+продал(?:а)?/iu, reason: "SOLD_SELF" },
  { re: /продал(?:а)?\s+сам(?:а)?(?:\s|,|\.|!|\?|$)/iu, reason: "SOLD_SELF" },
  { re: /продал(?:а)?\s+самостоятельно/iu, reason: "SOLD_SELF" },
  { re: /нашл[иа]\s+покупателя\s+сами/iu, reason: "SOLD_SELF" },
  { re: /не\s+буду\s+продавать/iu, reason: "WITHDRAWN_FROM_SALE" },
  { re: /передумал(?:а)?\s+продавать/iu, reason: "WITHDRAWN_FROM_SALE" },
  { re: /снима(?:ю|ем)\s+(?:объект\s+)?с\s+продажи/iu, reason: "WITHDRAWN_FROM_SALE" },
  { re: /не\s+хочу\s+(?:с\s+вами\s+)?(?:больше\s+)?работать/iu, reason: "WITHDRAWN_FROM_SALE" },
  { re: /не\s+буду\s+(?:с\s+вами\s+)?работать/iu, reason: "WITHDRAWN_FROM_SALE" },
];

/** Захват имени конкурента рядом со словом «агентство/риелтор/компания» — лучший
 *  случай, не гарантия. Не нашли — вызывающий код подставляет честную заглушку
 *  «не назвал(а) агентство» вместо того, чтобы придумывать имя. \S* — та же причина,
 *  что и в паттернах выше (Cyrillic вне \w). */
const COMPETITOR_NAME_RE = /(?:агентств\S*|риелтор\S*|компани\S*)(?:\s+\S+){0,2}?\s+([A-ZА-ЯЁ][A-Za-zА-Яа-яЁё-]{1,40})/u;

function extractCompetitorName(text: string): string | null {
  const m = text.match(COMPETITOR_NAME_RE);
  return m ? m[1] : null;
}

export interface DetectedRefusal {
  reason: RefusalReason;
  competitorName: string | null;
  /** Паттерн, который сработал — попадает в аудит для разбора ложных срабатываний. */
  pattern: string;
}

/**
 * Чистая функция без обращений к базе — намеренно, чтобы её было легко
 * протестировать отдельно от checkExplicitRefusal (тот же приём, что
 * detectPhoneAsk/checkAgentPhoneAsk в agentPhoneAskDetector.ts).
 */
export function detectExplicitRefusal(text: string, kind: "BUYER" | "SELLER"): DetectedRefusal | null {
  if (!text || text.trim().length < 3) return null;
  const patterns = kind === "BUYER" ? BUYER_PATTERNS : SELLER_PATTERNS;
  for (const { re, reason } of patterns) {
    if (re.test(text)) {
      const needsCompetitor = reason === "BOUGHT_VIA_OTHER_AGENCY" || reason === "SOLD_VIA_OTHER_AGENCY";
      return {
        reason,
        competitorName: needsCompetitor ? extractCompetitorName(text) : null,
        pattern: re.source,
      };
    }
  }
  if (isBareChangedMind(text)) {
    return {
      reason: kind === "BUYER" ? "CHANGED_MIND" : "WITHDRAWN_FROM_SALE",
      competitorName: null,
      pattern: "bare-передумал",
    };
  }
  return null;
}

// ─── Дедупликация ────────────────────────────────────────────────────────────

const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Дедуп через сам Interaction (маркер в notes), а не через AuditLog — 17.09.2026
 * (Р-6): AuditLog здесь пишется через logSystemAudit fire-and-forget (не ждёт
 * записи), и второй вызов checkExplicitRefusal ровно следом за первым (та же
 * гонка, что и у остальных детекторов дублей) мог не увидеть строку, которую
 * первый вызов ещё не успел закоммитить. Interaction создаётся `await` —
 * читать после него безопасно.
 */
const SUSPECTED_REFUSAL_MARKER = "[explicitRefusalSuspected]";

async function recentlySuspectedRefusal(clientId: string): Promise<boolean> {
  const recent = await prisma.interaction.findFirst({
    where: {
      clientId,
      type: "SYSTEM",
      notes: { startsWith: SUSPECTED_REFUSAL_MARKER },
      createdAt: { gte: new Date(Date.now() - DEDUP_WINDOW_MS) },
    },
    select: { id: true },
  });
  return recent !== null;
}

// ─── Точка входа ─────────────────────────────────────────────────────────────

export interface CheckExplicitRefusalParams {
  clientId: string;
  text: string;
}

/**
 * Проверяет ПОСЛЕДНЕЕ сообщение клиента на явный отказ. Р-6 (17.09.2026):
 * детектор больше НЕ закрывает карточку сам — только подсказывает: SYSTEM-
 * запись с цитатой и уведомление держателю. Подтверждает отказ агент кнопкой
 * («Завершить сделку → Без сделки»), которая вызывает refuseClient без
 * изменений. Вызывать ФОНОМ (void) сразу после сохранения сообщения —
 * проверка не должна задерживать ответ бота клиенту.
 *
 * ГЕЙТЫ СОСТОЯНИЯ (до всякого regex — дёшево отсеивают карточки, где отказ либо
 * уже случился, либо оформить его прямо сейчас нечем):
 *  - карточка не в Корзине;
 *  - kind BUYER/SELLER — у OTHER своей механики отказа нет;
 *  - status не LOST — работа уже завершена;
 *  - securityReview не PENDING — уже на проверке, второй раз не открываем;
 *  - есть assignedAgentId — подсказывать не на кого.
 */
export async function checkExplicitRefusal(params: CheckExplicitRefusalParams): Promise<void> {
  const { clientId, text } = params;
  if (!text || text.trim().length < 3) return;

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      shortId: true,
      fullName: true,
      kind: true,
      status: true,
      securityReview: true,
      assignedAgentId: true,
      deletedAt: true,
    },
  });
  if (!client || client.deletedAt) return;
  if (client.kind !== "BUYER" && client.kind !== "SELLER") return;
  if (client.status === "LOST") return;
  if (client.securityReview === "PENDING") return;
  if (!client.assignedAgentId) return;

  const detected = detectExplicitRefusal(text, client.kind);
  if (!detected) return;

  if (await recentlySuspectedRefusal(client.id)) return;

  const holderAgentId = client.assignedAgentId;
  const quote = text.trim().slice(0, 300);
  const note = `${SUSPECTED_REFUSAL_MARKER} Похоже на отказ: «${quote}» — подтвердите кнопкой «Завершить сделку → Без сделки», если это правда отказ`;

  // SYSTEM/AI, а не держатель (П-10, 17.09.2026) — это подсказка автодетектора,
  // а не действие агента; subjectAgentId сохраняет задачу в его списке дел.
  await logTimeline({
    clientId: client.id,
    actor: { kind: "ai", source: "explicit-refusal-detector", subjectAgentId: holderAgentId },
    type: "SYSTEM",
    notes: note,
    nextAction: "Подтвердить или отклонить подозрение на отказ",
    nextActionDate: new Date(),
  });

  logSystemAudit("CLIENT_REFUSAL_SUSPECTED", "Client", client.id, {
    reason: detected.reason,
    matchedPattern: detected.pattern,
    assignedAgentId: holderAgentId,
  });

  if (client.kind === "SELLER" && PROPERTY_STATUS_REFUSAL_REASONS.has(detected.reason)) {
    void refreshPropertiesOfSeller(client.id).catch((err) =>
      console.error("[explicitRefusalDetector] автостатус объектов продавца:", err instanceof Error ? err.message : err)
    );
  }

  // Держатель узнаёт сразу — карточка НЕ закрыта, ждёт его решения, а не
  // тихой находки через неделю.
  void sendPushToAgent(holderAgentId, {
    title: "🤖 Похоже на отказ клиента",
    body: `${client.fullName}: «${quote.slice(0, 100)}» (${REFUSAL_REASON_LABELS[detected.reason]}) — подтвердите кнопкой, если это отказ`,
    url: `/clients/${client.shortId}`,
    tag: `explicit-refusal-notice-${client.id}`,
  }).catch(() => {});
}
