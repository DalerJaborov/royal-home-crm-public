import type { ClientKind, InactiveReason } from "@royal-home/shared";
import { prisma } from "../db.js";
import { callAiText } from "../ai/client.js";
import { isReactionOnly } from "../ai/replyGuards.js";
import { KIND_LABELS_RU } from "../leads.js";
import { dushanbeDateTimeString, dushanbeInputToDate } from "./dushanbeTime.js";
import { deactivateClient } from "./clientWorkStatus.js";
import { logSystemError } from "./systemError.js";
import { logTimeline } from "./timeline.js";

/**
 * ДЕТЕКТОР НЕАКТИВНОСТИ ПО ПЕРЕПИСКЕ (план docs/audit-02-09-2026/19-plan-03-09-evening.md,
 * раздел B, 03.09.2026 вечер).
 *
 * Сейчас автоперевод в Неактивные по ИИ есть только для звонков (см.
 * ai/callAnalysis.ts, «ИИ ПРИОСТАНАВЛИВАЕТ РАБОТУ С КЛИЕНТОМ» — это модель для
 * копирования, взятая за основу здесь). Здесь то же самое для переписки: финальная
 * реплика уже принятого клиента (Instagram/WhatsApp/Telegram/сайт) проверяется на
 * признаки одной из причин INACTIVE_REASONS — либо на конкретную дату/час связи.
 *
 * ПОЧЕМУ ИИ, А НЕ REGEX. Фразы разнообразны и звучат на двух языках (русский,
 * таджикская кириллица), «не могу говорить» и «нет денег» можно сказать десятком
 * способов — держать словарь регулярок означало бы либо ловить полреальности, либо
 * захватывать обычные вопросы по ошибке. Модель получает дословные примеры
 * владельца как подсказку (см. SYSTEM_PROMPT), а не как жёсткий список для
 * совпадения по подстроке.
 *
 * ДВЕ ВЗАИМОИСКЛЮЧАЮЩИЕ ВЕТКИ ОТВЕТА МОДЕЛИ:
 *  - `reason` — клиент прямо просит паузу без указания даты → deactivateClient
 *    (тот же путь, тот же гейт «след работы», тот же светофор, что и у ручного
 *    перевода и у разбора звонка);
 *  - `scheduledContactAt` — клиент назвал КОНКРЕТНЫЙ день/час связи → клиент
 *    остаётся ACTIVE, вместо паузы заводится задача-напоминание агенту
 *    (Interaction.nextAction/nextActionDate — тот же приём, что у
 *    lib/noAnswerStreak.ts и lib/aiCallOutcome.ts). Если после этой даты агент
 *    позвонит и не дозвонится — отдельного кода не нужно: это обычный недозвон,
 *    дальше работает автоматика раздела C (lib/noAnswerTrafficLight.ts) и обычный
 *    ход светофора по фактической истории (решение владельца, зафиксировано в
 *    задании на эту сессию — намеренно НЕ реализовано отдельной 9-й причиной).
 *
 * Обе ветки — ЗАКОНОДАТЕЛЬНО одно исключает другое: если названа дата, reason не
 * смотрим вообще, даже если модель зачем-то вернула оба поля разом.
 */

/** Слишком короткая реплика физически не может нести содержательный сигнал —
 *  не тратим вызов ИИ. Ниже, чем в lib/newInquiryDetector.ts (12): там фильтр
 *  «это новый повод обратиться», здесь короткие фразы владельца («подумаю» — 7
 *  знаков) сами по себе уже полный сигнал. */
const MIN_TEXT_CHARS = 3;

/**
 * ТЕ ЖЕ 6 ПРИЧИН, ЧТО У ai/callAnalysis.ts::AI_INACTIVE_REASONS, — НАРОЧНО ОТДЕЛЬНАЯ
 * КОПИЯ, А НЕ ИМПОРТ ОТТУДА. Тот же приём, что у lib/noAnswerStreak.ts::countTrailingNoAnswer
 * относительно lib/clientAutoStatus.ts::collectFacts (см. комментарий там): в этом
 * репозитории уже был документированный случай, когда цикл импортов через
 * messengers/conversation.ts → leads.js → ... собирал модули в кольцо
 * (lib/telephony/callTracker.ts, комментарий у самого верхнего импорта) — этот
 * файл ТОЖЕ висит на conversation.ts, а ai/callAnalysis.ts тянет за собой
 * lib/scheduleShowing.ts и routes/matching.ts. Отдельная копия шести строк дешевле,
 * чем риск нового кольца через самый нагруженный файл бэкенда.
 *
 * STOPPED_RESPONDING и OTHER исключены по той же причине, что и в callAnalysis.ts:
 * «перестал отвечать» противоречит самому факту, что клиент только что написал, а
 * «другое» — не то, что ИИ должен выбирать сам не глядя (для этого есть explicit
 * отказ раздела D, не эта задача).
 */
const TEXT_INACTIVE_REASONS: readonly InactiveReason[] = [
  "THINKING",
  "NO_MONEY_YET",
  "POSTPONED",
  "NOT_READY_YET",
  "ASKED_LATER",
  "FAMILY_CIRCUMSTANCES",
];

/** Ниже этого порога решению ИИ не доверяем — просто ничего не делаем. Выше, чем
 *  можно было бы для звонка (там расшифровка на несколько минут разговора), потому
 *  что здесь ставки те же (деактивация клиента), а материала для решения — одна
 *  короткая реплика. */
const REASON_CONFIDENCE_THRESHOLD = 0.7;

/** Не даём модели утащить задачу в прошлое (ошибка распознавания) или на другой
 *  конец календаря (перепутанный год). Шире, чем SHOWING_MAX_DAYS_AHEAD в
 *  ai/callAnalysis.ts (90 дней, там про показ на днях) — здесь «через три месяца
 *  буду в городе» вполне реальная фраза продавца. */
const SCHEDULED_CONTACT_MAX_DAYS_AHEAD = 365;

/** Не заводим вторую такую же задачу, если один и тот же ход обработался дважды
 *  (повтор оплаченного хода, см. retryOfPaidTurn в messengers/conversation.ts). */
const REMINDER_NOTE_PREFIX = "Клиент назначил дату связи";
const REMINDER_DEDUPE_MS = 10 * 60 * 1000;

interface TextInactiveExtract {
  reason?: string | null;
  confidence?: number;
  scheduledContactAt?: string | null;
}

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    reason: {
      type: "string",
      enum: TEXT_INACTIVE_REASONS as unknown as string[],
      description:
        "Заполняй, ТОЛЬКО если клиент в ЭТОМ сообщении прямо и недвусмысленно просит паузу, без " +
        "конкретной даты: THINKING — «подумаю»; NO_MONEY_YET — денег пока нет, будут позже; " +
        "POSTPONED — сам отложил покупку/продажу; NOT_READY_YET — пока не готов; ASKED_LATER — " +
        "просит связаться попозже БЕЗ конкретного дня/даты («позвоните позже», «перезвоните», " +
        "«не могу сейчас говорить»); FAMILY_CIRCUMSTANCES — семейные обстоятельства. Обычное " +
        "продолжение разговора (вопрос о цене/районе, просьба показать ещё варианты, согласие, " +
        "благодарность) — НЕ повод, оставь пустым.",
    },
    confidence: {
      type: "number",
      description: "0-1 — насколько уверенно определена reason. Не заполняй, если reason пуст.",
    },
    scheduledContactAt: {
      type: "string",
      description:
        "Если клиент назвал КОНКРЕТНЫЙ день/дату/время, когда с ним можно связаться или он сам выйдет " +
        "на связь («буду 20-го в 20:00», «через неделю буду в городе», «в понедельник», «завтра») — " +
        "переведи в YYYY-MM-DDTHH:MM (местное время Душанбе, вычисли относительно текущей даты ниже). " +
        "Время не названо — поставь 12:00. В этом случае reason оставь пустым: названная дата — это " +
        "не пауза, а договорённость. Даты не было — оставь поле пустым.",
    },
  },
} as const;

const SYSTEM_PROMPT =
  "Ты смотришь на ОДНО сообщение клиента агентства недвижимости Royal Home (Душанбе) своему агенту в " +
  "переписке (Instagram/WhatsApp/Telegram/чат сайта). Разговор может идти на русском, таджикском " +
  "(кириллицей) или их смеси — понимай СМЫСЛ, а не отдельные слова, и не путай оговорки автоматической " +
  "расшифровки/опечатки со смыслом сказанного.\n" +
  "Примеры фраз (дословно от владельца — ориентир по смыслу, не точное совпадение строки):\n" +
  "— покупатель и продавец: «не могу говорить», «позвоните позже», «перезвоните», «нет денег пока», " +
  "«деньги будут потом», «подумаю»;\n" +
  "— отдельно продавец: «не в городе», «приеду позже», «смогу показать позже», «ключей пока нет, как " +
  "будут — сообщу».\n" +
  "Определи ОДНО из трёх: (1) клиент просит паузу без даты — заполни reason и confidence; (2) клиент " +
  "называет конкретный день/дату/время связи — заполни ТОЛЬКО scheduledContactAt; (3) ни то, ни " +
  "другое (обычный вопрос, согласие, благодарность, разговор по существу) — оставь всё пустым. " +
  "Ошибаться в сторону «ничего не подошло» безопаснее: по reason клиента снимают с активной работы " +
  "агента, поэтому заполняй его, только если действительно уверен(а). " +
  "Ответ передавай через инструмент submit_reply.";

/** «2026-08-10T18:00» от модели → момент времени, которому можно верить. Тот же
 *  приём, что и parseShowingAt в ai/callAnalysis.ts (формат, час запаса в прошлое,
 *  потолок в будущее) — своя копия, потому что там завязано на время звонка
 *  (callAt), а здесь на «сейчас» и другой потолок дальности. */
function parseScheduledContactAt(raw: string | null | undefined, now: Date): Date | null {
  if (!raw) return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const at = dushanbeInputToDate(match[1], match[2]);
  if (Number.isNaN(at.getTime())) return null;
  if (at.getTime() < now.getTime() - 3600_000) return null;
  if (at.getTime() > now.getTime() + SCHEDULED_CONTACT_MAX_DAYS_AHEAD * 86_400_000) return null;
  return at;
}

interface EligibleClient {
  id: string;
  kind: ClientKind;
  assignedAgentId: string;
}

async function loadEligibleClient(clientId: string): Promise<EligibleClient | null> {
  const client = await prisma.client.findFirst({
    where: { id: clientId, deletedAt: null },
    select: { id: true, kind: true, workStatus: true, assignedAgentId: true },
  });
  // Уже неактивен, потерян, в архиве или без агента — переводить/напоминать некому
  // и незачем: WorkStatus.ACTIVE + assignedAgentId — минимум, без которого
  // deactivateClient и напоминание одинаково бессмысленны.
  if (!client || client.kind === "OTHER" || client.workStatus !== "ACTIVE" || !client.assignedAgentId) return null;
  return { id: client.id, kind: client.kind, assignedAgentId: client.assignedAgentId };
}

/**
 * Точка входа — вызывается из messengers/conversation.ts фоново (void) на каждую
 * финальную реплику уже принятого клиента, сразу после того как она сохранена в
 * переписку. Не бросает наружу и не задерживает ответ бота: сбой здесь не должен
 * стоить клиенту ответа.
 */
export async function checkClientInactiveSignal(clientId: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_CHARS || isReactionOnly(trimmed)) return;

  try {
    const client = await loadEligibleClient(clientId);
    if (!client) return;

    const now = new Date();
    const extract = await callAiText<TextInactiveExtract>({
      endpoint: "client-inactive-text-detect",
      system: SYSTEM_PROMPT,
      user:
        `Тип клиента в CRM: ${KIND_LABELS_RU[client.kind] ?? client.kind}. ` +
        `Текущая дата и время в Душанбе: ${dushanbeDateTimeString(now)}.\n` +
        `Сообщение клиента: ${trimmed}`,
      maxTokens: 150,
      schema: RESULT_SCHEMA,
    });
    // callAiText сам ретраит и логирует отказ поставщика через logSystemError
    // (см. ai/client.ts) — здесь просто нечего разбирать дальше.
    if (!extract) return;

    const scheduledAt = parseScheduledContactAt(extract.scheduledContactAt, now);
    if (scheduledAt) {
      await createScheduledContactReminder(client, trimmed, scheduledAt, now);
      return; // дата — это не пауза; reason (если модель всё же его вернула) намеренно игнорируем
    }

    const reason = TEXT_INACTIVE_REASONS.includes(extract.reason as never) ? (extract.reason as InactiveReason) : null;
    const confidence = typeof extract.confidence === "number" ? extract.confidence : 0;
    if (!reason || confidence < REASON_CONFIDENCE_THRESHOLD) return;

    /**
     * ПЕРЕПРОВЕРКА ПОСЛЕ ЗАПРОСА К ИИ (гонка с детектором явного отказа,
     * lib/explicitRefusalDetector.ts, найдено при интеграции 04.09.2026).
     *
     * loadEligibleClient выше проверял workStatus ДО обращения к ИИ — а это
     * сетевой вызов, реальные сотни миллисекунд-секунды. Оба детектора висят
     * на одной и той же финальной реплике клиента (messengers/conversation.ts)
     * и оба фоновые, ничем не синхронизированы: пока этот ждёт ответ модели,
     * быстрый regex-детектор отказа мог уже закрыть карточку (status=LOST/
     * DEAL_CLOSED, смена assignedAgentId) — refuseClient/deferClient НЕ трогают
     * workStatus, так что старая проверка это не поймает. deactivateClient сам
     * тоже не сверяет status — молча поставил бы «Неактивный» поверх уже
     * закрытой или переданной карточки. Не полагаемся на скорость regex против
     * ИИ как на гарантию: перечитываем статус явно, прямо перед действием.
     */
    const fresh = await prisma.client.findFirst({
      where: { id: client.id },
      select: { workStatus: true, status: true },
    });
    if (!fresh || fresh.workStatus !== "ACTIVE" || fresh.status === "LOST" || fresh.status === "DEAL_CLOSED") {
      console.log(`[неактив-переписка] карточка ${client.id} уже сменила состояние, пока ждали ИИ — пропускаем`);
      return;
    }

    const result = await deactivateClient({
      clientId: client.id,
      evidenceAt: now,
      expectedAgentId: client.assignedAgentId,
      // П-10: актор — ИИ, не держатель карточки (см. lib/clientWorkStatus.ts).
      actor: { kind: "ai", source: "client-inactive-text-detector", subjectAgentId: client.assignedAgentId },
      reason,
      initiator: "CLIENT",
      actualNeeds: trimmed.slice(0, 500),
      comment: `Причина определена ИИ по переписке (уверенность ${Math.round(confidence * 100)}%) — проверьте карточку, если что-то не так.`,
    });
    if (!result.ok) {
      /**
       * ГЕЙТ «СЛЕД РАБОТЫ» НЕ ПРОПУСТИЛ — ЭТО ЗАКОННЫЙ ОТКАЗ, НЕ ОШИБКА
       * (canDeactivateWithReason, lib/inactiveTrafficLight.ts: нет ни одной
       * зафиксированной попытки связаться). Пытаться дальше здесь нечем — тихо
       * логируем информационно и не переводим клиента, как и просил владелец.
       */
      console.log(
        `[неактив-переписка] гейт не пропустил перевод клиента ${client.id}: ${result.reason ?? "нет причины"}`
      );
    }
  } catch (err) {
    await logSystemError(
      "ai",
      `Детектор неактивности по переписке (клиент ${clientId}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function createScheduledContactReminder(
  client: EligibleClient,
  quote: string,
  scheduledAt: Date,
  now: Date
): Promise<void> {
  // Повтор оплаченного хода (см. retryOfPaidTurn в MessengerTurnInput) может
  // прогнать эту же реплику через детектор второй раз — не плодим вторую
  // одинаковую задачу агенту подряд.
  const recent = await prisma.interaction.findFirst({
    where: {
      clientId: client.id,
      type: "SYSTEM",
      notes: { startsWith: REMINDER_NOTE_PREFIX },
      createdAt: { gte: new Date(now.getTime() - REMINDER_DEDUPE_MS) },
    },
    select: { id: true },
  });
  if (recent) return;

  // Клиент ОСТАЁТСЯ ACTIVE (план, раздел B) — никакого workStatus/inactiveLevel
  // здесь не трогаем, только задача-напоминание тем же приёмом, что и у
  // lib/noAnswerStreak.ts/ai/aiCallOutcome.ts: обычный Interaction с
  // nextAction/nextActionDate, который подхватывают lib/tasks.ts (TASK_WHERE) и
  // напоминания агенту.
  // Автор — ИИ (детектор по тексту переписки, П-10, 17.09.2026), не агент:
  // subjectAgentId сохраняет задачу в его списке дел.
  await logTimeline({
    clientId: client.id,
    actor: { kind: "ai", source: "client-inactive-text-detector", subjectAgentId: client.assignedAgentId },
    type: "SYSTEM",
    notes: `${REMINDER_NOTE_PREFIX}: «${quote.slice(0, 300)}»`,
    nextAction: "Связаться с клиентом",
    nextActionDate: scheduledAt,
  });
}
