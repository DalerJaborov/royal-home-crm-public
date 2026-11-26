/**
 * «Не отвечает» — переработка 12.08.2026 (ТЗ владельца, «Логика Статус + Итог»).
 *
 * Было: одно напоминание перезвонить через 15 минут, и дальше тишина — три недозвона
 * подряд слали пуш руководству, но не давали цепочке никакого продолжения (клиент
 * просто зависал, слот у агента не освобождался, никто не решал, что дальше).
 *
 * Стало: до `noAnswerMaxAttempts` (по умолчанию 3) попыток с интервалом
 * `noAnswerRetryMinutes` (по умолчанию 15) — каждая следующая попытка снова ставит
 * агенту задачу «Перезвонить». После последней неудачной — не сама задача, а пуш
 * руководству «Проверить контакт с клиентом»: дальше решение за человеком (сам
 * дозвонится и снимет клиента с недозвонов, либо оставит агенту переводить его в
 * Неактивный/Передачу). Числа настраиваемые (Settings), потому что это ровно то, что
 * владелец в ТЗ пометил «например».
 */

import { formatClientCode, formatClientName, type ClientKind } from "@royal-home/shared";
import { prisma } from "../db.js";
import { closeLeadPushNotifications } from "../push.js";
import { findAgentsWithPermission } from "./recipients.js";
import { loadDisciplineRules } from "./disciplineRules.js";
import { logSystemError } from "./systemError.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { logTimeline } from "./timeline.js";
import { upsertAutoTask } from "./autoTasks.js";

/**
 * РУБИЛЬНИК «НЕДОЗВОН — РУКОВОДСТВУ» (владелец 26.11.2026, уточнено 27.11.2026).
 *
 * Владелец получал пуш «Агент X не может дозвониться — проверьте контакт с
 * клиентом» и справедливо спросил: «я как это исправлю?». 27.11: «уведомление
 * можешь не отправлять никому больше». Поэтому по умолчанию (переменная не
 * задана или ≠ "1") после N недозвонов подряд НЕ шлётся ничего и никому: ни
 * пуша, ни колокольчика, ни задачи. Причина каждого недозвона словами
 * («занято», «номер выключен»…) и так ложится заметкой в историю клиента
 * (telephony/callTracker.ts::describeNoAnswerReason). Вернуть старое поведение
 * (задача и пуш всем с правом clients.assign) — `NO_ANSWER_LEADERSHIP_ALERTS=1`.
 */
export function noAnswerLeadershipAlertsEnabled(): boolean {
  return process.env.NO_ANSWER_LEADERSHIP_ALERTS === "1";
}


/** Сколько звонков подряд клиент не поднял трубку — считая от самого свежего звонка
 *  вниз. Любой звонок с другим исходом обрывает серию (см. clientAutoStatus.ts —
 *  та же логика, здесь отдельная копия ради независимого вызова без остальных фактов
 *  автостатуса). */
export async function countTrailingNoAnswer(clientId: string, limit = 20): Promise<number> {
  const recent = await prisma.interaction.findMany({
    where: { clientId, outcome: { not: null } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { outcome: true },
  });
  let streak = 0;
  for (const i of recent) {
    if (i.outcome === "NO_ANSWER") streak++;
    else break;
  }
  return streak;
}

export interface NoAnswerStep {
  /** Сколько подряд неудачных попыток уже было, включая только что записанную. */
  streak: number;
  /** Лимит попыток из Настроек. */
  maxAttempts: number;
  /** Достигнут ли лимит — дальше решает руководитель, а не автоматический перезвон. */
  escalated: boolean;
  /** Текст и время следующей задачи агенту (только пока не escalated). */
  nextAction: string | null;
  nextActionDate: Date | null;
}

/**
 * Что делать с очередным недозвоном: продолжить цепочку или отдать руководству.
 *
 * `clientId` — вызывать ДО вставки записи об этой попытке: `streak` считает предыдущие
 * подряд неудачные звонки, а `streak + 1` — это уже сама текущая попытка (её ещё нет
 * в базе). Эскалация наступает, когда ТЕКУЩАЯ попытка — последняя разрешённая, а не
 * когда их уже на одну больше: иначе агент получал бы на один звонок сверх лимита.
 */
export async function planNoAnswerStep(clientId: string, now: Date = new Date()): Promise<NoAnswerStep> {
  const rules = await loadDisciplineRules();
  const streak = await countTrailingNoAnswer(clientId);
  const attemptNumber = streak + 1;
  const escalated = attemptNumber >= rules.noAnswerMaxAttempts;
  return {
    streak,
    maxAttempts: rules.noAnswerMaxAttempts,
    escalated,
    nextAction: escalated ? null : `Перезвонить — клиент не ответил (попытка ${attemptNumber} из ${rules.noAnswerMaxAttempts})`,
    nextActionDate: escalated ? null : new Date(now.getTime() + rules.noAnswerRetryMinutes * 60_000),
  };
}

/**
 * Пуш и задача руководству, когда попытки дозвониться кончились — решение дальше за
 * человеком.
 *
 * До 13.08.2026 (п.23 ТЗ «Путь покупателя») уходил только пуш: если руководитель не
 * успел его увидеть (телефон разрядился, звук выключен), запись о недозвоне нигде не
 * оставалась — ни в его списке задач, ни в карточке клиента. Теперь тем же
 * руководителям, что получают пуш, заводится ещё и задача — обычный Interaction с
 * nextAction/nextActionDate (та же модель, что и «Перезвонить» у агента, см.
 * lib/tasks.ts, kpi.ts «Дисциплина CRM»): она попадёт в их список дел и останется в
 * истории клиента, даже если пуш потерян.
 */
export async function notifyNoAnswerEscalation(client: {
  id: string;
  fullName: string;
  shortId: number;
  /**
   * Тип карточки — чтобы в задаче и в пуше стояло «Покупатель Далер ПК-000227», а
   * не голое имя (владелец 30.08.2026). Необязателен только потому, что один из
   * четырёх вызывающих (lib/telephony/callTracker.ts) пока не выбирает `kind` из
   * базы; там, где он есть, передавать обязательно — иначе роль и приставка снова
   * пропадут ровно в том тексте, ради которого всё это делалось.
   */
  kind?: ClientKind | null;
}, agentId: string, maxAttempts: number): Promise<void> {
  if (!noAnswerLeadershipAlertsEnabled()) return;
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { fullName: true } });
  // Число — из Настроек (noAnswerMaxAttempts), не зашито: владелец пометил его
  // «например, три», а не жёстким правилом, и уже сегодня менял в UI.
  // Номер карточки — тем же форматом, что везде в CRM (ПК-000227), а не «№227»:
  // руководитель ищет по нему в поиске, и «№227» там не находился.
  const taskText = `Проверить контакт с клиентом ${formatClientName(client)} ${formatClientCode(client.shortId, client.kind)} — ${maxAttempts} недозвон${maxAttempts === 1 ? "" : maxAttempts < 5 ? "а" : "ов"} подряд`;
  try {
    /**
     * ОДНА ЗАПИСЬ НА КЛИЕНТА, А НЕ ОДНА НА КАЖДОГО РУКОВОДИТЕЛЯ (П-10, 17.09.2026,
     * тот же дефект и то же решение, что в lib/telephony/missedCallEscalation.ts::
     * notifyLeadership — docs/audit/recon-17-09/04-timeline-authorship.md §b.7).
     * Раньше на N руководителей заводилось N одинаковых Interaction с agentId
     * каждого как персональная задача — чистый спам в хронологии клиента.
     * Адресаты получают пуш и запись в колокольчике через enqueueDirectorAlert
     * ниже (createNotifications внутри неё) — здесь один системный след.
     *
     * `upsertAutoTask` (21.09.2026, lib/autoTasks.ts) — раньше здесь не было
     * `nextAction`/`nextActionDate` вовсе (регресс против собственного докстринга
     * выше «заводится ещё и задача»), а сама эскалация срабатывает каждый раз,
     * когда серия снова добирается до потолка попыток, — без дедупа это ровно
     * та же задача заново на каждую следующую серию недозвонов у одного клиента
     * (на проде 21.09.2026 — 6 задач на одного). upsertAutoTask обновляет уже
     * открытую задачу этого вида вместо второй копии.
     */
    await upsertAutoTask({
      clientId: client.id,
      kind: "no_answer_supervisor_check",
      // Общая задача руководству (одна на клиента, см. выше) — намеренно без
      // subjectAgentId; sharedTask гасит ложную тревогу logTimeline в журнале.
      actor: { kind: "system", source: "noAnswerStreak", sharedTask: true },
      type: "SYSTEM",
      notes: taskText,
      nextAction: taskText,
      nextActionDate: new Date(),
    });
  } catch (err) {
    // Отказ записи задачи не должен ронять обработку недозвона — пуш ниже всё равно
    // должен уйти (см. CLAUDE.md: внешние/побочные вызовы не глотать молча, но и не
    // давать им останавливать основной поток).
    await logSystemError(
      "api",
      `Задача о недозвонах (клиент ${client.shortId}): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Часы алармов (владелец 07.09.2026): задача выше уже назначена руководителям
  // прямо сейчас (реальный пункт в «Мои дела» с nextActionDate=сейчас — это не
  // уведомление, откладывать нельзя), а вот сам ПУШ о ней может подождать
  // часов алармов без вреда.
  await enqueueDirectorAlert({
    title: `⚠️ ${formatClientName(client)}: не отвечает`,
    body: `Агент ${agent?.fullName ?? "—"} не может дозвониться — проверьте контакт с клиентом.`,
    url: `/clients/${client.shortId}`,
    tag: `no-answer-${client.id}`,
    recipientPermission: "clients.assign",
  });

  // «Хвост» дозвона (маячки и отложенная задача «ещё раз дозвониться») удалён
  // 16.11.2026 вместе со светофором неактивных (владелец: «ничего лишнего»).
}

/** Клиент наконец ответил — эскалация «не отвечает» у руководителей больше не
 *  актуальна. Закрытие несуществующего пуша (серия недозвонов не доходила до
 *  эскалации) безопасно — closeLeadPushNotification молча закроет то, чего нет. */
export async function closeNoAnswerPush(clientId: string): Promise<void> {
  const supervisors = await findAgentsWithPermission("clients.assign");
  const tag = `no-answer-${clientId}`;
  await closeLeadPushNotifications(supervisors.map((id) => ({ agentId: id, tag })));
}
