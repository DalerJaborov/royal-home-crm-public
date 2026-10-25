/**
 * «Без сделки» — общая бизнес-логика отказа клиента (ТЗ п. 16-18), вынесенная
 * из routes/clients/lifecycle.ts::POST /:id/refuse (03.09.2026, план D/E,
 * docs/audit-02-09-2026/19-plan-03-09-evening.md).
 *
 * ДВА ВЫЗЫВАЮЩИХ. Кнопка агента «Завершить сделку → Без сделки» (сам роут —
 * права, зод-валидация, HTTP-ответ) и детектор явного отказа в переписке
 * (lib/explicitRefusalDetector.ts — клиент сам написал «уже купил»/«передумал»).
 * Раньше вся логика жила внутри роута; чтобы детектор не завёл вторую, слегка
 * иную версию того же самого (переход следующему агенту, проверка СБ, Royal
 * Score, пуши), она вынесена сюда один раз — ОБА пути зовут ровно эту функцию.
 *
 * АУДИТ — ЗАБОТА ВЫЗЫВАЮЩЕГО, не этой функции (тот же приём, что и
 * clientTransfer.ts/transferClientByAgent, только там аудит уже внутри — здесь
 * оставлен снаружи, потому что у роута есть req для logAudit, а у детектора его
 * нет и он пишет logSystemAudit сам под тем же action="CLIENT_REFUSE" — чтобы
 * problemReport.ts и другие читатели AuditLog продолжали считать оба вида
 * отказов вместе, не заводя вторую цифру для «отказов, обнаруженных ботом»).
 */
import {
  REFUSAL_REASON_LABELS,
  REFUSAL_INITIATOR_LABELS,
  REASONS_REQUIRING_SECURITY_REVIEW,
  REASONS_REQUIRING_COMPETITOR,
  isClientCardFilled,
  type RefusalReason,
  type RefusalInitiator,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { refusalNeedsManagementDecision } from "./assignmentCompletion.js";
import { logTimeline } from "./timeline.js";
import { pickNextAgentByKpiQueue } from "../leads.js";
import { hadConductedShowing } from "./conductedShowing.js";
import { loadHotScoreThreshold } from "./hotScoreThreshold.js";
import { loadMaxTransfers, transfersExhausted } from "./leadTransfers.js";
import { classifyClientLossFault } from "./clientLossFault.js";
import { loadEventPoints, recordScoreEvent } from "./scoreJournal.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { sendPushToAgent } from "../push.js";
import { alertRefusedHighScoreBuyer } from "./buyerNoCallAlarm.js";
import { dushanbeDateTimeString } from "./dushanbeTime.js";
import { changeClientAgent, ClientOwnerRaceError, throwIfNotClaimed } from "./changeClientAgent.js";
import { publishClientUpdated } from "./livePublish.js";
import { lastConductedShowingPropertyId } from "./propertyVoice/showingProperty.js";

export interface RefuseClientInput {
  clientId: string;
  reason: RefusalReason;
  initiator: RefusalInitiator;
  /**
   * Кто оформляет отказ (П-10, 17.09.2026) — НЕ то же самое, что `initiator`
   * (тот про причину «кто виноват в реальной жизни», не про то, кто сейчас
   * нажимает кнопку). `req.agent.id` роута — обычно совпадает с
   * `client.assignedAgentId`, но НЕ ВСЕГДА: руководитель (ownAgentId=null у
   * него) может оформить отказ за чужого клиента, и раньше запись всё равно
   * подписывалась ответственным агентом, будто это сделал он. Не передан
   * (детектор явного отказа в переписке) — актор "ai".
   */
  actorAgentId?: string | null;
  comment?: string;
  competitorName?: string;
  boughtWhat?: string;
  voiceNoteUrl?: string;
  voiceNoteTranscript?: string;
  /**
   * Гейты «был показ» (BUYER) / «карточка хоть немного заполнена» (SELLER) ниже
   * существуют, чтобы АГЕНТ не мог фиктивно закрыть клиента без реальной работы
   * (ТЗ п. 16: «это предотвращает фиктивное закрытие клиента без реальной
   * работы»). Когда отказ запускает не решение агента, а прямые слова САМОГО
   * КЛИЕНТА в переписке («уже купил», «не буду продавать») — фиктивного закрытия
   * тут нет по определению, а показа вполне может не быть вовсе (клиент способен
   * написать «уже купил» ДО первого показа). Детектор явного отказа передаёт
   * true; кнопка агента — не передаёт вовсе (по умолчанию false), поведение
   * кнопки не меняется ни на бит.
   */
  bypassPreCloseGates?: boolean;
  /**
   * LAW П-5 (закон о владении клиентом, 17.09.2026): кто нажал кнопку «Без
   * сделки» — обязателен для кнопки агента, ОТСУТСТВУЕТ у детектора явного
   * отказа (тот срабатывает по словам самого клиента, автоматика). До этой
   * правки функция ВСЕГДА звала `changeClientAgent` с `actorId: null` для
   * обоих вызывающих — новый общий сторож `changeClientAgent` (закон П-3:
   * принят+контакт → автопередача запрещена) начал бы ошибочно блокировать и
   * САМУ КНОПКУ агента, приравнивая её к автоматике. `routes/clients/lifecycle.ts`
   * (кнопка) передаёт `req.agent!.id`; `explicitRefusalDetector.ts` (детектор)
   * намеренно НЕ передаёт — это и есть автоматика, для которой П-3 должен
   * действовать (мозговой штурм 17.09, разбор `docs/audit/recon-17-09/
   * 02-auto-transfer-mechanisms.md`, механизм №12: «автодетект... нарушает: ДА»).
   */
  actorId?: string | null;
}

export type RefuseClientResult =
  | {
      ok: true;
      isHot: boolean;
      refusalCount: number;
      transferred: boolean;
      securityReview: boolean;
      nextAgentId: string | null;
      message: string;
    }
  | { ok: false; status: number; error: string };

/** assignedAgentId сужен до string: гейт ниже уже отверг клиента без агента. */
export type ClientWithAgent = Omit<
  NonNullable<Awaited<ReturnType<typeof prisma.client.findUnique>>>,
  "assignedAgentId"
> & { assignedAgentId: string };

export type PreconditionsResult =
  | {
      ok: true;
      client: ClientWithAgent;
      settingsRow: { autoRouteRefusedLeads: boolean } | null;
      hadShowing: boolean;
      cardFilled: boolean;
      isHot: boolean;
    }
  | { ok: false; status: number; error: string };

/**
 * ГЕЙТЫ ПЕРЕД ЗАКРЫТИЕМ КАРТОЧКИ — вынесены отдельно от остальной логики
 * `refuseClient` (04.09.2026, найдено при интеграции): «Отложенные»
 * (lib/deferredClients.ts::deferClient, задача G) вызываются ВМЕСТО
 * refuseClient для причин EXPENSIVE/FINANCE_ISSUE/WRONG_OBJECT — если гейты
 * живут только ВНУТРИ refuseClient, отложенная ветка их вообще не проходит,
 * и агент может «отложить» клиента без единого показа/заполненной карточки —
 * та самая фиктивная закрытие карточки, от которой гейты защищают (ТЗ п. 16),
 * просто через другую дверь. deferredClients.ts::deferClient сам об этом
 * прямо предупреждает в комментарии («гейты уже пройдены вызывающим кодом») —
 * вызывающий код (routes/clients/lifecycle.ts) обязан вызвать эту функцию
 * ПЕРЕД веткой и на «Отложенные», и на обычный refuseClient.
 */
export async function checkRefusalPreconditions(
  clientId: string,
  input: { reason: RefusalReason; bypassPreCloseGates?: boolean; comment?: string; voiceNoteUrl?: string }
): Promise<PreconditionsResult> {
  const [client, settingsRow] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId } }),
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { autoRouteRefusedLeads: true } }),
  ]);
  if (!client) return { ok: false, status: 404, error: "Клиент не найден" };
  if (client.assignmentRefusedAt) {
    return { ok: false, status: 409, error: "Отказ по этому назначению уже оформлен" };
  }
  if (client.kind === "OTHER" || !client.assignedAgentId) {
    return { ok: false, status: 409, error: "У этого обращения нет агента — отказ ему не оформляется" };
  }
  /**
   * Работа с клиентом уже завершена — второй раз завершать нечего (раньше эта
   * проверка отсутствовала: форму «Без сделки» можно было отправить по уже
   * потерянной карточке ещё раз, и refusalCount рос на каждом повторе).
   */
  if (client.status === "LOST") {
    return { ok: false, status: 409, error: "Работа с этим клиентом уже завершена" };
  }

  const hadShowing = await hadConductedShowing(client.id);
  if (client.kind === "BUYER") {
    // «Завершить сделку» доступна только после первого проведённого показа (ТЗ п. 16) —
    // до этого используется «Передача»/«Неактивный». Детектор явного отказа снимает
    // это ограничение (см. bypassPreCloseGates выше).
    if (!hadShowing && !input.bypassPreCloseGates) {
      return { ok: false, status: 409, error: "«Завершить сделку» доступна после первого проведённого показа" };
    }
  } else {
    /**
     * ОБЯЗАТЕЛЬНОЕ ЗАПОЛНЕНИЕ КАРТОЧКИ ПЕРЕД ЗАВЕРШЕНИЕМ — только для SELLER
     * (спецификация, «Путь продавца»). Мягче, чем isClientCardFilled («горячий»
     * ниже) — тот критерий решает совсем другой вопрос. Тем же bypassPreCloseGates
     * снимается для детектора по той же причине, что и гейт показа выше.
     */
    if (!input.bypassPreCloseGates) {
      const hasAnyCardData =
        client.budgetMin != null ||
        client.budgetMax != null ||
        client.desiredDistrictId != null ||
        client.desiredRooms != null ||
        (client.requirementsNotes ?? "").trim().length > 0;
      if (!hasAnyCardData) {
        return {
          ok: false,
          status: 409,
          error: "Заполните карточку клиента (бюджет, район, комнаты или пожелания), прежде чем оформлять отказ",
        };
      }
    }
  }
  const cardFilled = isClientCardFilled(client);
  const isHot = hadShowing || cardFilled;

  /**
   * РЕШЕНИЕ ВЛАДЕЛЬЦА 03.09.2026 (вариант «2в»): комментарий к отказу обязателен
   * ТОЛЬКО для клиента с высоким скорингом — текст от 20 символов или голосовая
   * заметка. Детектор явного отказа не обходит эту проверку отдельным флагом: он
   * всегда пишет дословную цитату клиента с поясняющим префиксом (см.
   * explicitRefusalDetector.ts), что естественно проходит порог в 20 символов.
   */
  const hotScoreThreshold = await loadHotScoreThreshold();
  const explained = (input.comment?.trim().length ?? 0) >= 20 || !!input.voiceNoteUrl?.trim();
  if ((client.aiScore ?? 0) >= hotScoreThreshold && !explained) {
    return {
      ok: false,
      status: 400,
      error: `Клиент с высоким скорингом (${client.aiScore}) — объясните отказ: комментарий от 20 символов или голосовая заметка`,
    };
  }

  // assignedAgentId уже проверен выше (!client.assignedAgentId возвращает раньше) —
  // приведение типа отражает эту проверку, а не обходит её.
  return { ok: true, client: client as ClientWithAgent, settingsRow, hadShowing, cardFilled, isHot };
}

export async function refuseClient(input: RefuseClientInput): Promise<RefuseClientResult> {
  const { reason, initiator, comment, competitorName, boughtWhat, voiceNoteUrl, voiceNoteTranscript } = input;

  // Защита на уровне функции, а не только зод-схемы HTTP-роута (её здесь не
  // было бы для второго вызывающего — детектора, у которого нет схемы между
  // ним и этой функцией).
  if (REASONS_REQUIRING_COMPETITOR.includes(reason) && !competitorName?.trim()) {
    return { ok: false, status: 400, error: "Укажите, через какое агентство прошла сделка" };
  }

  const pre = await checkRefusalPreconditions(input.clientId, input);
  if (!pre.ok) return pre;
  const { client, settingsRow, hadShowing, cardFilled, isHot } = pre;

  const reasonLabel = REFUSAL_REASON_LABELS[reason];
  const refusalCount = client.refusalCount + 1;
  const maxTransfers = await loadMaxTransfers();
  const transferLimitReached = transfersExhausted(refusalCount, maxTransfers);

  /**
   * ПРОВЕРКА СБ (03.09.2026, план §E: решает ТОЛЬКО причина, не инициатор).
   *
   * До этой правки формула была `initiator === "CLIENT" || REASONS...includes(reason)`
   * — «дорого» со слов самого клиента уходило в СБ наравне с «купил сам», а
   * «передумал»/«снял с продажи» требовали проверки при любом инициаторе, хотя
   * это обычный отказ рынка, а не увод сделки. См. актуальный список и полное
   * обоснование в REASONS_REQUIRING_SECURITY_REVIEW (packages/shared/src/schemas.ts).
   * Тот же фикс синхронно внесён в routes/me.ts::refuseSellerClient — второе
   * место с точно такой же формулой для отказа продавца через «Итог объекта».
   */
  const needsSecurityReview = REASONS_REQUIRING_SECURITY_REVIEW.includes(reason);
  const openDeal = await prisma.deal.findFirst({
    where: { clientId: client.id, stage: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true },
  });
  const needsManagementDecision = refusalNeedsManagementDecision(client, !!openDeal);
  const escalate = !needsManagementDecision && transferLimitReached;
  // Отказавший агент не получает лид обратно; после эскалации выбор делает руководитель.
  // На проверке СБ передача не происходит вовсе: пока не разобрались, кому именно
  // ушла сделка, отдавать карточку следующему агенту незачем.
  const nextAgentId =
    needsManagementDecision || escalate || needsSecurityReview || !settingsRow?.autoRouteRefusedLeads
      ? null
      : await pickNextAgentByKpiQueue([client.assignedAgentId]);
  const unassignToQueue = !needsManagementDecision && !nextAgentId && !escalate && !needsSecurityReview;

  const noteParts = [
    `Клиент отказался (${reasonLabel})`,
    `Инициатор: ${REFUSAL_INITIATOR_LABELS[initiator]}`,
    competitorName?.trim() ? `Агентство-конкурент: ${competitorName.trim()}` : null,
    reason === "BOUGHT_SELF" && boughtWhat?.trim() ? `Что приобрёл клиент: ${boughtWhat.trim()}` : null,
    comment?.trim() ? `Комментарий: ${comment.trim()}` : null,
    hadShowing ? "Был показ — клиент горячий" : cardFilled ? "Карточка заполнена — клиент горячий" : null,
    needsManagementDecision
      ? `Отказ №${refusalCount} зафиксирован. Текущая работа сохранена до решения руководителя`
      : needsSecurityReview
      ? `Отказ №${refusalCount} — работа по назначению завершена`
      : escalate
      ? `Отказ №${refusalCount} — предел передач (${maxTransfers}) исчерпан, карточка помечена «Потерянный» и больше не распределяется автоматически`
      : !nextAgentId
        ? `Отказ №${refusalCount} — снят с агента, передан руководству`
        : `Отказ №${refusalCount}`,
  ].filter(Boolean);

  // toAgentId: nextAgentId — реальная передача; unassignToQueue — снятие в
  // очередь руководителя; иначе (СБ/эскалация LOST) агент НЕ меняется — только
  // escalatedAt/статус. changeClientAgent сам проставит lastAgentId, когда
  // владелец действительно меняется (nextAgentId/unassignToQueue); для LOST
  // (аудит владения 11.09.2026, дыра №2 — три пути в LOST по-разному обращались
  // с агентом) lastAgentId ставим явно ниже, хотя assignedAgentId сохраняется.
  const toAgentId = nextAgentId ?? (unassignToQueue ? null : client.assignedAgentId);

  // Объект отказа читается ДО транзакции: это справочное чтение, ему незачем держать её.
  const refusalPropertyId = hadShowing ? await lastConductedShowingPropertyId(client.id) : null;
  const lossSnapshot: { kind: Awaited<ReturnType<typeof classifyClientLossFault>> } = { kind: "client_lost_no_fault" };

  /**
   * ГОНКА С «/assign» (ночная проверка 24.09.2026, находка №5): снимок клиента
   * прочитан в checkRefusalPreconditions, дальше показ/порог/предел/очередь —
   * и только потом запись. Если руководитель за это время отдал карточку
   * другому агенту, `guardWhere` по владельцу из снимка не даёт записать
   * поверх его решения: транзакция откатывается вместе с хронологией, а
   * нажавший кнопку получает 409 «обновите страницу».
   */
  try {
    await prisma.$transaction(async (tx) => {
      // Serialize refusals and recheck the exception under the same client lock.
      await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${client.id} FOR UPDATE`;
      const current = await tx.client.findUnique({ where: { id: client.id } });
      const currentDeal = await tx.deal.findFirst({
        where: { clientId: client.id, stage: { notIn: ["COMPLETED", "CANCELLED"] } }, select: { id: true },
      });
      if (!current || current.assignmentRefusedAt || current.assignedAgentId !== client.assignedAgentId ||
          current.assignedAt.getTime() !== client.assignedAt.getTime() ||
          refusalNeedsManagementDecision(current, !!currentDeal) !== needsManagementDecision) {
        throw new ClientOwnerRaceError("race");
      }
      if (!needsManagementDecision) {
        if (escalate && !needsSecurityReview) lossSnapshot.kind = await classifyClientLossFault(client.id, new Date(), tx);
        await tx.interaction.updateMany({
          where: { clientId: client.id, OR: [{ nextAction: { not: null } }, { nextActionDate: { not: null } }], completedAt: null, taskCancelledAt: null },
          data: { taskCancelledAt: new Date() },
        });
      }
      // Актор — реальный человек, оформивший отказ (обычно ответственный агент,
      // но не всегда — см. actorAgentId выше), либо ИИ-детектор явного отказа в
      // переписке, когда actorAgentId не передан (П-10, 17.09.2026).
      await logTimeline({
        clientId: client.id,
        actor: input.actorAgentId
          ? { kind: "agent", agentId: input.actorAgentId }
          : { kind: "ai", source: "explicit-refusal-detector", subjectAgentId: client.assignedAgentId },
        type: "SYSTEM",
        outcome: "NEGATIVE",
        notes: noteParts.join(". "),
        // «Голос рынка»: к какой квартире относится отказ — объект последнего
        // свежего показа (null, если показа не было или у него нет объекта).
        propertyId: refusalPropertyId,
        voiceNoteUrl: voiceNoteUrl ?? null,
        voiceNoteTranscript: voiceNoteTranscript ?? null,
        tx,
      });
      if (needsSecurityReview) {
        await logTimeline({
          clientId: client.id,
          actor: { kind: "system", source: "refusal-investigation", subjectAgentId: client.assignedAgentId },
          type: "SYSTEM",
          investigationOnly: true,
          notes: `Причина отказа требует внутренней проверки: ${reasonLabel}`,
          tx,
        });
      }
      const changed = await changeClientAgent({
        clientId: client.id,
        toAgentId,
        reason: noteParts.join(". "),
        actorId: input.actorId ?? null,
        source: "refuse",
        // Interaction содержательная уже написана выше (текст отказа, голосовая
        // заметка) — системная запись changeClientAgent стала бы дублем.
        skipInteraction: true,
        guardWhere: { assignedAgentId: client.assignedAgentId, assignedAt: client.assignedAt,
          assignmentRefusedAt: null, refusalCount: client.refusalCount },
        data: {
          refusalReason: reason,
          refusalCount,
          assignmentRefusedAt: new Date(),
          assignmentRefusedByAgentId: client.assignedAgentId,
          assignmentCompletedAt: needsManagementDecision ? null : new Date(),
          // «Потерянный» перебивает и «горячего», и «холодного»: это не оценка
          // клиента, а факт про нас — предел передач исчерпан, автоматика с этой
          // карточкой закончила. Проверка СБ идёт ПЕРВОЙ по приоритету: пока
          // человек не решил, карточка на проверке, а не «потерянная»/«холодная».
          ...(needsSecurityReview
            ? { securityReview: "PENDING" as const, securityReviewedAt: null, securityReviewedById: null }
            : needsManagementDecision ? {}
            : escalate
              ? {
                  status: "LOST" as const,
                  lostAt: new Date(),
                  // LOST не занимает слот в портфеле (leadLimits.ts::TERMINAL_STATUSES) —
                  // agent сохраняется, но lastAgentId всё равно ставим (решение
                  // владельца 11.09.2026, см. markClientLost).
                  ...(client.assignedAgentId ? { lastAgentId: client.assignedAgentId } : {}),
                }
              : isHot
                ? { hotSince: client.hotSince ?? new Date(), status: "HOT" as const }
                : { status: "COLD" as const }),
          ...(needsManagementDecision ? {} : nextAgentId ? { assignedAt: new Date(), acceptedAt: null } : { escalatedAt: new Date() }),
        },
        tx,
      });
      throwIfNotClaimed(changed);
    });
  } catch (err) {
    if (err instanceof ClientOwnerRaceError) return { ok: false, status: 409, error: err.userMessage };
    throw err;
  }

  // A review or a preserved second role is not a lost client and earns no loss event.
  if (escalate && !needsSecurityReview && client.assignedAgentId) {
    const lostAgentId = client.assignedAgentId;
    void (async () => {
      const kind = lossSnapshot.kind;
      const points = await loadEventPoints();
      recordScoreEvent({
        agentId: lostAgentId,
        kind,
        delta: points[kind],
        reason:
          kind === "client_lost_agent_fault"
            ? `Клиент потерян: на момент потери были просроченные обязательные окна/задачи — ${client.fullName}`
            : `Клиент потерян без просрочек со стороны агента — ${client.fullName}`,
        sourceId: `client-lost-${client.id}`,
      });
    })();
  }

  if (nextAgentId) {
    void sendPushToAgent(nextAgentId, {
      title: isHot ? `🔥 Горячий клиент передан вам` : `🤝 Отказной лид передан вам`,
      body: `${client.fullName}: ${reasonLabel}${comment?.trim() ? ` — ${comment.trim().slice(0, 80)}` : ""}`,
      url: `/clients/${client.shortId}`,
      tag: `refusal-${client.id}`,
    }).catch(() => {});
  } else if (needsSecurityReview) {
    // Зовём тех, у кого есть право проверять, — по праву, а не по роли.
    // Часы алармов (владелец 07.09.2026): карточка уже ушла в очередь СБ прямо
    // сейчас (securityReview=PENDING), откладывается только уведомление о ней.
    void enqueueDirectorAlert({
      title: `⚠️ ${client.fullName}: закрытие требует проверки`,
      body: `${reasonLabel}${comment?.trim() ? ` — ${comment.trim().slice(0, 80)}` : ""}`,
      url: `/clients/${client.shortId}`,
      tag: `security-review-${client.id}`,
      recipientRoles: ["ADMIN", "DIRECTOR"],
    });
  } else {
    // Некому передать или третий отказ — владельцу и всем, кто назначает лидов.
    void enqueueDirectorAlert({
      title: `⚠️ ${client.fullName}: отказ №${refusalCount}`,
      body: needsManagementDecision
        ? `${reasonLabel}. У клиента вторая роль или открытая сделка: работа сохранена, требуется решение руководителя.`
        : `${reasonLabel}. Передача остановлена — назначьте агента вручную.`,
      url: `/clients/${client.shortId}`,
      tag: `refusal-escalated-${client.id}`,
      ...(needsManagementDecision ? { recipientRoles: ["ADMIN", "DIRECTOR"] as const } : { recipientPermission: "clients.assign" as const }),
    });
  }

  // Директору — ОТДЕЛЬНЫЙ пуш при любой неуспешной сделке покупателя, не только
  // при эскалации/СБ. SELLER-отказ «сделкой» в этом смысле не считается.
  if (client.kind === "BUYER") {
    void (async () => {
      const now = new Date();
      /**
       * ОЧЕРЕДЬ АЛАРМОВ ВМЕСТО «НЕ СЛАТЬ НОЧЬЮ» (владелец 07.09.2026, заменило
       * гейт isWithinWorkingHours, стоявший здесь с 03.09). Сделка уже
       * остановлена, откладывается ТОЛЬКО уведомление директору: ночное событие
       * не теряется, а уходит с началом ближайшего окна алармов
       * (lib/directorAlertQueue.ts, Settings.alarmHoursStart/End).
       */
      const agent = client.assignedAgentId
        ? await prisma.agent.findUnique({ where: { id: client.assignedAgentId }, select: { fullName: true } })
        : null;
      void enqueueDirectorAlert({
        title: `❌ Сделка не состоялась: ${client.fullName}`,
        // Когда/от кого(агент)/про кого(клиент)/что — одним текстом, без перехода по ссылке.
        body: `${dushanbeDateTimeString(now)}, агент ${agent?.fullName ?? "неизвестен"}: ${reasonLabel}${comment?.trim() ? ` — ${comment.trim().slice(0, 80)}` : ""}`,
        url: `/clients/${client.shortId}`,
        tag: needsSecurityReview ? `investigation-deal-failed-${client.id}` : `deal-failed-${client.id}`,
        recipientRoles: needsSecurityReview ? ["DIRECTOR", "ADMIN"] : ["DIRECTOR", "ADMIN", "HEAD_OF_SALES"],
      });

      void alertRefusedHighScoreBuyer(client).catch((err) =>
        console.error("[alarm] refused-high-score:", err instanceof Error ? err.message : err)
      );
    })();
  }

  // Отказ меняет и исполнителя, и статус: адресуем прежнему агенту и новому.
  publishClientUpdated({
    clientId: client.id,
    agentIds: [client.assignedAgentId, nextAgentId],
    actorId: client.assignedAgentId,
  });

  return {
    ok: true,
    isHot,
    refusalCount,
    transferred: !!nextAgentId,
    securityReview: needsSecurityReview,
    nextAgentId,
    message: needsManagementDecision
      ? "Отказ сохранён. Текущая работа сохранена до решения руководителя"
      : "Отказ сохранён",
  };
}
