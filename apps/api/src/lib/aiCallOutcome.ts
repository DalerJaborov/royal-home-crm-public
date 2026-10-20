/**
 * Автозаполнение исхода звонка искусственным интеллектом — без окна «Как прошёл
 * звонок» для агента.
 *
 * ЗАЧЕМ (владелец 17-18.08.2026): агенты в Таджикистане неохотно заполняют окно
 * после каждого звонка, а само окно временами не открывалось вовсе («ИИ слушает
 * разговор — сейчас подставит итог» висело вечно — это и был симптом того, что
 * aiDraft мог не дождаться разбора и человеку нечего было подтверждать). Разбор
 * звонка (ai/callAnalysis.ts) уже понимает исход разговора — пусть он сам
 * записывает его в карточку, а не предлагает человеку нажать кнопку.
 *
 * ЧТО ПОВТОРЯЕТ, А ЧТО НЕТ. Ветка ниже — та же самая «АКТИВНЫЙ» ветка формы
 * «Как прошёл звонок» (routes/me.ts, completeCallResultSummary), только без
 * участия человека. TRANSFER сюда намеренно не входит — передача другому агенту
 * остаётся решением человека, модель её никогда не предлагает.
 *
 * INACTIVE — ИСКЛЮЧЕНИЕ, СВОИМ ПУТЁМ (владелец 20.08.2026, после того как этот
 * абзац был написан 17-18.08: «ИИ также имеет право перевести в неактивный
 * клиента, продавца, покупателя, если по разговорам это ясно»). Проверяется НЕ
 * здесь, а в ai/callAnalysis.ts — ДО вызова applyAiCallOutcome, через
 * analysisSchema.inactiveReason и lib/clientWorkStatus.ts::deactivateClient
 * (тот же гейт «след работы», что и у человека). Если сработало — applyAiCallOutcome
 * не вызывается вовсе, статусы взаимоисключимы.
 *
 * ОБЕ ВЕТКИ ДОЛЖНЫ МЕНЯТЬСЯ ВМЕСТЕ. Если в completeCallResultSummary меняется
 * логика «АКТИВНОГО» исхода (недозвон, показ, приём объекта), то же самое нужно
 * поправить и здесь — второй путь к тем же полям, который тесты routes/me.ts
 * не увидят.
 */

import { CALL_OUTCOME_CHOICES, SELLER_CALL_OUTCOME_CHOICES, MIN_ANALYZED_TRANSCRIPT_CHARS } from "@royal-home/shared";
import { prisma } from "../db.js";
import { notifyNoAnswerEscalation, planNoAnswerStep } from "./noAnswerStreak.js";

/**
 * ПОРОГ ДОВЕРИЯ СТРОЖЕ, ЧЕМ ПОРОГ РАЗБОРА (MIN_ANALYZED_TRANSCRIPT_CHARS).
 *
 * Разбор запускается уже на коротких разговорах — там всё ещё есть смысл (кто
 * звонил, зачем). Но короткий разговор — плохая почва для решения «записать в
 * карточку без подтверждения человеком»: модели проще ошибиться на паре фраз,
 * чем на содержательном разговоре. Порог для автозаполнения выше порога для
 * самого разбора, а не равен ему.
 */
const MIN_TRANSCRIPT_CHARS_FOR_AUTO_APPLY = MIN_ANALYZED_TRANSCRIPT_CHARS * 3;

export interface AiOutcomeCandidate {
  interactionId: string;
  agentId: string;
  clientId: string;
  transcriptLength: number;
  /** Уже провалидированный по analysisSchema исход — WAITING_CALL/WAITING_OPTIONS/
   *  WAITING_SHOWING/NEGATIVE/NO_ANSWER, или null, если модель не дала исход. */
  outcome: string | null;
  nextAction: string | null;
  /** Уже разобранная и провалидированная дата встречи (parseShowingAt), или null. */
  showingAt: Date | null;
  /**
   * Время, на которое договорились СОЗВОНИТЬСЯ (владелец 19.09.2026), уже
   * разобранное и проверенное тем же parseShowingAt, или null. Не встреча:
   * созвон никакой записи в календаре сам по себе не заводит, он живёт
   * напоминанием в nextActionDate — см. применение ниже.
   */
  callbackAt: Date | null;
  summary: string;
}

interface ConfidenceVerdict {
  confident: boolean;
  reason: string;
}

/**
 * Годится ли разбор для автозаписи в карточку — чистая функция, ничего не
 * читает и не пишет, поэтому её удобно проверять отдельно от базы.
 */
export function assessAiOutcomeConfidence(
  input: AiOutcomeCandidate,
  clientKind: "BUYER" | "SELLER" | "OTHER"
): ConfidenceVerdict {
  if (!input.outcome) return { confident: false, reason: "модель не предложила исход" };
  const allowed = clientKind === "SELLER" ? SELLER_CALL_OUTCOME_CHOICES : CALL_OUTCOME_CHOICES;
  if (!(allowed as readonly string[]).includes(input.outcome)) {
    return { confident: false, reason: "исход не подходит для этого типа клиента" };
  }
  if (input.transcriptLength < MIN_TRANSCRIPT_CHARS_FOR_AUTO_APPLY) {
    return { confident: false, reason: "разговор слишком короткий для автозаписи" };
  }
  if (!input.summary.trim()) {
    return { confident: false, reason: "пустой пересказ" };
  }
  // WAITING_SHOWING/SELLER_MEETING без даты — модель предложила исход, но нечего
  // показывать агенту как назначенную встречу: пусть решает человек.
  if ((input.outcome === "WAITING_SHOWING" || input.outcome === "SELLER_MEETING") && !input.showingAt) {
    return { confident: false, reason: "исход про встречу без распознанной даты" };
  }
  return { confident: true, reason: "" };
}

/**
 * Записывает исход в Interaction ровно так, как делает человек через форму
 * «Как прошёл звонок» (АКТИВНАЯ ветка, без TRANSFER/INACTIVE — см. шапку файла),
 * но с outcomeSource="AI_AUTO". Возвращает false, если по пути обнаружилась
 * причина не применять автоматически (гонка с ручным заполнением, удалённый
 * клиент) — тогда карточку должен заполнить человек, как раньше.
 */
export async function applyAiCallOutcome(input: AiOutcomeCandidate): Promise<boolean> {
  const interaction = await prisma.interaction.findUnique({
    where: { id: input.interactionId },
    select: { id: true, notes: true, outcome: true, outcomeSource: true, clientId: true },
  });
  if (!interaction) return false;
  /**
   * Кто-то уже записал ЖИВОЙ исход — не перезаписываем: агент руками (форма
   * «Как прошёл звонок», outcomeSource="HUMAN") или более ранний проход разбора
   * (outcomeSource="AI_AUTO") — правило то же, что у самого CallAnalysis.create:
   * кто первый, тот и записал.
   *
   * ИСКЛЮЧЕНИЕ — "SYSTEM_STUB" (найдено ревью 24.09.2026: у ВСЕХ отвеченных
   * входящих настоящий разбор ИИ никогда не применялся). lib/telephony/
   * incomingCalls.ts ставит отвеченному входящему outcome="NEUTRAL" с
   * outcomeSource="SYSTEM_STUB" ДО разбора — не решение человека и не решение
   * ИИ, а временная метка, чтобы `clientAutoStatus.ts` не читал пустой исход
   * как «связи не было» (см. докстринг там же). Эта функция обязана иметь
   * право переписать именно такую заглушку настоящим исходом — иначе она
   * навсегда остаётся «уже занятой», и разбор для входящих не пишется вовсе.
   */
  if (interaction.outcome && interaction.outcomeSource !== "SYSTEM_STUB") return false;

  const client = await prisma.client.findFirst({
    where: { id: input.clientId, deletedAt: null },
    select: { id: true, shortId: true, fullName: true, kind: true, firstOutcomeAt: true },
  });
  if (!client) return false;

  const verdict = assessAiOutcomeConfidence(input, client.kind as "BUYER" | "SELLER" | "OTHER");
  if (!verdict.confident) return false;

  const outcome = input.outcome!;

  // Показ автоматически назначается ТОЛЬКО когда у клиента ровно один активный
  // объект в работе — иначе выбор объекта остаётся агенту (см. Шаг 2 плана).
  // Здесь, в Шаге 1, WAITING_SHOWING без однозначного объекта просто не
  // считается уверенным исходом — applyAiCallOutcome для него не вызывается
  // вовсе (см. callAnalysis.ts), поэтому эта функция сама показ не создаёт.

  const noAnswerStep = outcome === "NO_ANSWER" ? await planNoAnswerStep(client.id) : null;
  const autoNextAction = noAnswerStep && !noAnswerStep.escalated ? noAnswerStep.nextAction : null;
  const autoNextActionDate = noAnswerStep && !noAnswerStep.escalated ? noAnswerStep.nextActionDate : null;

  const base = interaction.notes?.trim() || "";
  const noteText = `Итог (ИИ): ${input.summary.trim()}`;
  /**
   * SELLER_MEETING — встреча с продавцом на объекте (осмотр, видеосъёмка), но объект
   * ещё не принят в работу и Property под неё может не существовать вовсе (см.
   * enums.ts). У WAITING_SHOWING/показа календарной записью служит сам Interaction
   * type=SHOWING, который заводит callAnalysis.ts следом (см. комментарий выше) —
   * здесь такого шага нет, поэтому дата встречи кладётся сюда же, в nextAction/
   * nextActionDate, и попадает в календарь/«Задачи на сегодня» тем же путём, что и
   * любая другая договорённость (routes/calendar.ts читает по nextActionDate).
   */
  const nextActionForThisRecord =
    outcome === "WAITING_SHOWING"
      ? undefined
      : outcome === "SELLER_MEETING"
        ? "Встреча с продавцом на объекте (осмотр/видеосъёмка)"
        : input.nextAction?.trim() || autoNextAction || undefined;
  /**
   * КОГДА НАПОМНИТЬ О СЛЕДУЮЩЕМ ЗВОНКЕ (владелец 19.09.2026: «если клиент называл
   * определённое время, когда он сам позвонит или агент ему должен позвонить, то
   * тогда должно ставиться напоминание»).
   *
   * Порядок источников не случаен, от частного к общему:
   *  · WAITING_SHOWING — дата живёт в самом показе (Interaction type=SHOWING,
   *    его заводит callAnalysis.ts), второй раз дублировать её сюда незачем;
   *  · SELLER_MEETING — встреча с продавцом, календарной записи под неё нет, и
   *    дата встречи остаётся здесь, как и раньше;
   *  · дальше — время созвона из разговора, если оно прозвучало: ровно то, чего
   *    не хватало. Оно важнее авто-плана недозвона (`autoNextActionDate`), потому
   *    что названо живым человеком, а не рассчитано по лесенке попыток;
   *  · и только потом прежний авто-план.
   */
  const nextActionDateForThisRecord =
    outcome === "WAITING_SHOWING"
      ? undefined
      : outcome === "SELLER_MEETING"
        ? input.showingAt ?? undefined
        : input.callbackAt ?? autoNextActionDate ?? undefined;

  // Итог звонка и обе отметки клиента (firstOutcomeAt/propertyAcceptedAt) —
  // одной транзакцией: порознь падение между ними даёт итог без отметки
  // (антифрод «продавец без объекта» и метрика скорости первого итога живут
  // именно на этих полях) или наоборот.
  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.interaction.updateMany({
      // updateMany с условием "outcome не занят живым исходом" — тот же приём,
      // что уникальность у CallAnalysis.create: если агент успел записать итог
      // (или другой проход разбора) между чтением и записью, ни outcome:null,
      // ни outcomeSource:"SYSTEM_STUB" уже не совпадут, строка не найдётся и
      // count будет 0. Условие держим тем же, что и в проверке выше (interaction.outcome
      // && outcomeSource !== "SYSTEM_STUB"), иначе гонка проверяется в одном месте, а
      // защищается в другом.
      where: { id: interaction.id, OR: [{ outcome: null }, { outcomeSource: "SYSTEM_STUB" }] },
      data: {
        notes: base ? `${base}. ${noteText}` : noteText,
        outcome: outcome as never,
        outcomeSource: "AI_AUTO",
        nextAction: nextActionForThisRecord,
        nextActionDate: nextActionDateForThisRecord,
      },
    });
    if (res.count === 0) return false;

    if (!client.firstOutcomeAt) {
      await tx.client.update({ where: { id: client.id }, data: { firstOutcomeAt: new Date() } });
    }

    if (outcome === "PROPERTY_ACCEPTED" && client.kind === "SELLER") {
      await tx.client.update({ where: { id: client.id }, data: { propertyAcceptedAt: new Date() } });
      /* Требование «Итог объекта» здесь больше не заводится: механизм обязательных
         окон удалён 13.09.2026. Отметка propertyAcceptedAt остаётся — по ней живёт
         антифрод «продавец без объекта» (lib/sellerPropertyMissingAntifraud.ts), а
         он к окнам отношения не имел. */
    }
    return true;
  });
  if (!updated) return false;

  if (noAnswerStep?.escalated) {
    void notifyNoAnswerEscalation(client, input.agentId, noAnswerStep.maxAttempts).catch((err) =>
      console.error("[ии-итог] уведомление о недозвонах:", err instanceof Error ? err.message : err)
    );
  }

  return true;
}
