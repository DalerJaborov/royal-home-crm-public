import { TRANSFER_REASON_LABELS, type TransferReason } from "@royal-home/shared";
import { prisma } from "../db.js";
import { pickNextAgentByKpiQueue, isAgentAvailableForLead, pickStrongestAvailableAgent } from "../leads.js";
import { findMatchingPropertiesForClient } from "../routes/matching.js";
import { loadMaxTransfers, transfersExhausted } from "./leadTransfers.js";
import { classifyClientLossFault } from "./clientLossFault.js";
import { loadEventPoints, recordScoreEvent } from "./scoreJournal.js";
import { sendPushToAgent, closeLeadPushNotification } from "../push.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { hadConductedShowing } from "./conductedShowing.js";
import { cancelPendingClientDeleteRequestOnTransfer } from "./trashClient.js";
import { countContactTrace, loadTrafficLightSettings } from "./inactiveTrafficLight.js";
import { noteAgentHandoffAndAlarmIfAnomalous } from "./agentHandoffAnomalyAlarm.js";
import { changeClientAgent, ClientOwnerRaceError, throwIfNotClaimed } from "./changeClientAgent.js";
import { publishClientUpdated } from "./livePublish.js";
import { closeOwnershipSatellites } from "./ownershipSatellites.js";
import { logTimeline } from "./timeline.js";

const MS_PER_DAY = 86_400_000;

export type TransferGate = { allowed: true } | { allowed: false; reason: string };

/**
 * МОЖНО ЛИ передать клиента ПРЯМО СЕЙЧАС (мозговой штурм владельца 20-21.08.2026,
 * «рубеж 2: дверь передачи, которой сейчас нет»).
 *
 * До этого дня «Передача» открывалась только ПОСЛЕ первого проведённого показа
 * — между «принял лид» и «сходил на показ» агент, понявший, что не тянет
 * клиента (языковой барьер, не его район, слишком сложный человек), не мог ни
 * передать его, ни честно бездействовать: либо тащить клиента на заведомо
 * бессмысленную встречу, либо молчать до звонка руководителя.
 *
 * Порог снижен до ОДНОЙ попытки реального контакта — той же метрики, что
 * решает светофор неактивных (см. lib/inactiveTrafficLight.ts::countContactTrace,
 * переиспользуем её же, а не заводим вторую версию «что считать контактом»):
 * доведённый до клиента дозвон, ручная запись о звонке с исходом или ответ
 * клиента в переписке. Берём именно `attempts`, а не `talked`: текст отказа
 * ниже обещает «попытку связаться», и держать за ним тридцатисекундный порог
 * разговора значило бы обещать одно, а проверять другое (27.08.2026 — тем же
 * разбором, что и у гейта Неактивных).
 * Ноль контактов передавать не даёт НАРОЧНО — иначе «Передача» стала бы
 * способом отказаться от клиента, ни разу ему не позвонив, тем же путём, каким
 * canDeactivateWithReason закрывает аналогичную лазейку у «Неактивных».
 *
 * Проведённый показ по-прежнему пропускает без дополнительной проверки —
 * реальный контакт и показ не исключают друг друга, но требовать оба избыточно:
 * если показ состоялся, контакт заведомо был.
 */
export async function canTransferClient(clientId: string): Promise<TransferGate> {
  if (await hadConductedShowing(clientId)) return { allowed: true };
  const settings = await loadTrafficLightSettings();
  const { attempts } = await countContactTrace(clientId, settings.leadCallMinSeconds);
  if (attempts >= 1) return { allowed: true };
  return {
    allowed: false,
    reason:
      "Передача доступна после первого проведённого показа или хотя бы одной попытки связаться с клиентом (звонок с ответом или переписка)",
  };
}

/**
 * Передача клиента другому агенту — одним куском.
 *
 * Появилось 11.08.2026 вместе с правилом «свой объект»: когда агент берёт лид по
 * своему объекту сверх лимита, один из его обычных лидов уходит другому агенту,
 * и этот перенос обязан выглядеть ровно так же, как любой другой, — иначе в
 * хронологии клиента возникает третий, слегка иной вариант одного и того же
 * события.
 *
 * ЧТО ОБЯЗАТЕЛЬНО ПЕРЕЕЗЖАЕТ ВМЕСТЕ С КЛИЕНТОМ. Незакрытые задачи. Клиент у
 * нового агента, а «перезвонить ему в четверг» у старого — худший из возможных
 * промежуточных исходов: новый не знает, что обещано, а старый видит задачу по
 * чужому клиенту и разумно её игнорирует. Поэтому и клиент, и задачи, и запись в
 * хронологии — одной транзакцией.
 *
 * acceptedAt сбрасывается: для нового агента это НЕ принятый лид. Он должен
 * принять его сам — иначе карточка молча повисает у человека, который о ней не
 * знает, а таймер автопередачи (leadAcceptMinutes) по ней не идёт.
 */
export interface ClientTransferResult {
  /** Сколько незакрытых задач переехало вместе с клиентом. */
  movedTasks: number;
}

export type TransferByAgentResult =
  | { ok: true; nextAgentId: string; lost?: false }
  | { ok: true; lost: true; nextAgentId?: undefined }
  | { ok: false; error: string; status: number };

type TransferRouting =
  | { kind: "agent"; agentId: string; explain: string }
  | { kind: "escalate" }
  | { kind: "queue" };

/**
 * Слова, по которым в обязательном комментарии причины OTHER распознаётся
 * конфликт/недовольство клиента. В TRANSFER_REASONS такой причины нет явно
 * (владелец, мозговой штурм 20-21.08.2026: «если такой ещё нет явно, используй
 * OTHER с обязательным комментарием») — комментарий для OTHER и так обязателен
 * (см. clientTransferSchema), так что распознавание ничего не требует
 * дополнительно от агента, лишь читает то, что он и так обязан написать.
 *
 * Список слов — Settings.transferConflictKeywords, правится в Настройках →
 * Лиды без участия программиста (владелец 22.08.2026, первая версия слов была
 * прикидкой без сверки с реальными случаями). Пустой список в базе — осознанное
 * решение выключить это распознавание, а не повод подставлять дефолт из кода
 * (см. память "Промт — просьба, а не гарантия" / "Один источник правды"): DEFAULT
 * ниже нужен только на случай, если строка Settings ещё не мигрирована.
 */
const DEFAULT_CONFLICT_KEYWORDS = ["конфликт", "жалоб", "недовол", "оскорб", "груб", "агресс", "скандал", "хам"];

async function looksLikeConflict(comment?: string): Promise<boolean> {
  if (!comment) return false;
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { transferConflictKeywords: true },
  });
  const keywords = settings?.transferConflictKeywords ?? DEFAULT_CONFLICT_KEYWORDS;
  const lower = comment.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

/** Шаг 1 routeTransferTarget: агент, чей объект лучше всего подходит клиенту —
 *  тот же матчинг и тот же порог, что у «своего объекта» при обычном
 *  распределении (leads.ts::pickByPropertyMatch), только среди уже
 *  подобранных объектов ищем не хозяина сверх очереди, а конкретного
 *  получателя передачи. Свой собственный объект не в счёт: если бы он подходил,
 *  агент не передавал бы клиента по этой причине вовсе. */
async function pickAgentByPropertyMatch(
  clientId: string,
  excludeAgentId: string
): Promise<{ agentId: string; propertyShortId: number; score: number } | null> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { ownPropertyMatchThreshold: true },
  });
  const threshold = settings?.ownPropertyMatchThreshold ?? 90;
  const candidates = (await findMatchingPropertiesForClient(clientId)).filter(
    (c) => c.intakeAgentId !== excludeAgentId && c.score >= threshold
  );
  // Уже отсортированы по убыванию балла (findMatchingPropertiesForClient) —
  // берём первого попавшегося доступного, а не пересортировываем заново.
  for (const c of candidates) {
    if (await isAgentAvailableForLead(c.intakeAgentId, true)) {
      return { agentId: c.intakeAgentId, propertyShortId: c.shortId, score: c.score };
    }
  }
  return null;
}

/**
 * ПРИЧИНА = МАРШРУТ, а не просто текст в хронологии (владелец дословно,
 * мозговой штурм 20-21.08.2026: «нет подходящих объектов → агенту, у которого
 * объект подходит; сложный клиент → сильному по счёту; конфликт → руководителю»).
 *
 *  - CANT_MATCH_PROPERTY — агенту, чей объект подходит клиенту не хуже порога
 *    из Настроек (тот же ownPropertyMatchThreshold, что у обычного «своего
 *    объекта»). Нет такого — обычная очередь по KPI, как раньше.
 *  - NEEDS_DIFFERENT_APPROACH — «сильному» агенту: наивысший текущий Royal
 *    Score среди доступных. Нет доступных — тоже очередь.
 *  - OTHER с явным признаком конфликта в обязательном комментарии — НЕ
 *    автоматический подбор получателя, а прямая эскалация руководителю: с
 *    недовольным клиентом решает человек, не алгоритм.
 *  - Остальные причины (CANT_HANDLE, NOT_INTERESTED_IN_OFFERS, NOT_ENOUGH_TIME,
 *    AT_LEAD_LIMIT, BETTER_FIT, OTHER без признаков конфликта) — без изменений,
 *    обычная очередь по KPI.
 */
async function routeTransferTarget(
  reason: TransferReason,
  clientId: string,
  excludeAgentId: string,
  comment?: string
): Promise<TransferRouting> {
  if (reason === "OTHER" && (await looksLikeConflict(comment))) return { kind: "escalate" };

  if (reason === "CANT_MATCH_PROPERTY") {
    const match = await pickAgentByPropertyMatch(clientId, excludeAgentId);
    if (match) {
      return {
        kind: "agent",
        agentId: match.agentId,
        explain: `подходит объект №${match.propertyShortId} этого агента (совпадение ${match.score})`,
      };
    }
    return { kind: "queue" };
  }

  if (reason === "NEEDS_DIFFERENT_APPROACH") {
    const strongest = await pickStrongestAvailableAgent([excludeAgentId]);
    if (strongest) return { kind: "agent", agentId: strongest, explain: "агент с наивысшим текущим Royal Score" };
    return { kind: "queue" };
  }

  return { kind: "queue" };
}

/**
 * КВОТА ПЕРЕДАЧ В МЕСЯЦ (Settings.transferQuotaPerMonth, по умолчанию 3) — НЕ
 * БЛОКИРОВКА (владелец дословно: «решение остаётся за человеком, не
 * автоматика»), а сигнал руководителю, когда один агент передаёт клиентов
 * заметно чаще обычного.
 *
 * Считаем по AuditLog: пишем свою запись здесь же, при КАЖДОМ вызове
 * transferClientByAgent, независимо от исхода ниже (эскалация/предел/обычная
 * передача — решение «передать» уже произошло к этому моменту). Это
 * единственное место, куда стекаются все три входа передачи (карточка клиента,
 * «Итог показа», «Итог звонка») — раньше аудит писал только один из трёх
 * роутов (routes/clients.ts), и подсчёт по нему занижал бы реальное число
 * передач агента.
 */
async function noteTransferForQuota(
  agentId: string,
  client: { id: string; shortId: number; fullName: string }
): Promise<void> {
  try {
    const since = new Date(Date.now() - 30 * MS_PER_DAY);
    const priorCount = await prisma.auditLog.count({
      where: { action: "CLIENT_TRANSFER", agentId, createdAt: { gte: since } },
    });
    const ordinal = priorCount + 1;

    const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { fullName: true } });
    await prisma.auditLog.create({
      data: {
        action: "CLIENT_TRANSFER",
        entityType: "Client",
        entityId: client.id,
        agentId,
        agentName: agent?.fullName ?? "Неизвестно",
      },
    });

    const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { transferQuotaPerMonth: true } });
    const quota = settings?.transferQuotaPerMonth ?? 3;
    if (quota > 0 && ordinal > quota) {
      void enqueueDirectorAlert({
        title: "Много передач за месяц",
        body: `${agent?.fullName ?? "Агент"} передал «${client.fullName}» — ${ordinal}-я передача за 30 дней (обычно свободно ${quota}). Возможно, стоит поговорить.`,
        url: `/clients/${client.shortId}`,
        tag: `transfer-quota-${agentId}-${ordinal}`,
        recipientPermission: "clients.assign",
      });
    }
  } catch (err) {
    // Сигнал руководителю не важнее самой передачи — не роняем её из-за
    // непрочитанного счётчика.
    console.error("[clientTransfer] квота передач не посчитана:", err instanceof Error ? err.message : err);
  }
}

/**
 * «Передача» (ТЗ п. 19-21, голосовое уточнение владельца 12.08.2026): агент сам
 * решает, что не может продолжить работу с клиентом, и объясняет почему — в
 * отличие от «Отказался»/«Без сделки» (REFUSAL_REASONS), здесь причина не про
 * итог сделки, а про самого агента. Доступна клиенту, у которого уже был показ,
 * ИЛИ (с 20-21.08.2026) есть хотя бы 1 реальный контакт — проверяет
 * canTransferClient, вызывающий код передаёт её результат.
 *
 * Предел — тот же Settings.leadMaxTransfers, что и у отказа (lib/leadTransfers.ts):
 * один общий счётчик переходов между агентами, а не два разных с разными числами.
 * Исчерпан — клиент не «потерян навсегда» в смысле ТЗ п. 21 («Потерянный клиент»
 * после третьей неудачной передачи), это тот же ClientStatus.LOST, что и у отказа.
 */
export async function transferClientByAgent(input: {
  clientId: string;
  agentId: string;
  reason: TransferReason;
  comment?: string;
  voiceNoteUrl?: string;
  voiceNoteTranscript?: string;
}): Promise<TransferByAgentResult> {
  /**
   * ГОНКА С «/assign» (ночная проверка 24.09.2026, находка №5). Между снимком
   * клиента ниже и записью проходят квота, подбор получателя, очередь по KPI —
   * сотни миллисекунд, за которые руководитель успевает отдать карточку
   * другому агенту. Все четыре записи ниже идут с `guardWhere` по владельцу из
   * снимка и бросают `ClientOwnerRaceError` изнутри транзакции (хронология
   * откатывается вместе с ней); здесь она становится 409 для нажавшего кнопку.
   */
  try {
    return await transferClientByAgentUnguarded(input);
  } catch (err) {
    if (err instanceof ClientOwnerRaceError) return { ok: false, error: err.userMessage, status: 409 };
    throw err;
  }
}

async function transferClientByAgentUnguarded(input: {
  clientId: string;
  agentId: string;
  reason: TransferReason;
  comment?: string;
  voiceNoteUrl?: string;
  voiceNoteTranscript?: string;
}): Promise<TransferByAgentResult> {
  const client = await prisma.client.findFirst({
    where: { id: input.clientId, deletedAt: null },
    select: { id: true, fullName: true, shortId: true, assignedAgentId: true, refusalCount: true },
  });
  if (!client) return { ok: false, error: "Клиент не найден", status: 404 };
  if (client.assignedAgentId !== input.agentId) {
    return { ok: false, error: "Клиент закреплён за другим агентом", status: 403 };
  }

  // Квота — независимо от исхода передачи ниже (см. документацию функции).
  await noteTransferForQuota(input.agentId, client);
  // Счётчик аномалий F-2 — с сужением TRANSFER_REASONS до NO_TRUST (задача F-1)
  // каждая передача и есть случай «не сложился контакт»; защитная проверка
  // reason на случай, если список причин когда-нибудь снова расширят.
  if (input.reason === "NO_TRUST") {
    void noteAgentHandoffAndAlarmIfAnomalous({ agentId: input.agentId, client, kind: "TRANSFER_NO_TRUST" });
  }

  const refusalCount = client.refusalCount + 1;
  const maxTransfers = await loadMaxTransfers();
  const escalate = transfersExhausted(refusalCount, maxTransfers);
  const reasonLabel = TRANSFER_REASON_LABELS[input.reason];
  const note =
    `Передан другому агенту: ${reasonLabel}` +
    (input.comment?.trim() ? `. ${input.comment.trim()}` : "") +
    (escalate ? `. Предел передач (${maxTransfers}) исчерпан — карточка помечена «Потерянный»` : "");

  if (escalate) {
    // lostAt — владелец 30.08.2026: момент перехода в «Потерянный», отдельно
    // от updatedAt (см. Client.lostAt в schema.prisma) — по нему считается
    // «через 3 месяца в корзину» (lib/lostInactiveTrashSweep.ts). Агент НЕ
    // меняется (LOST не занимает слот в портфеле — leadLimits.ts::TERMINAL_STATUSES),
    // но lastAgentId проставляем явно (аудит владения 11.09.2026, дыра №2:
    // три пути в LOST раньше по-разному обращались с ним).
    await prisma.$transaction(async (tx) => {
      /**
       * outcome="NEGATIVE" обязателен: по нему раздел «Потерянные клиенты»
       * собирает цепочку «через кого прошёл и почему»
       * (routes/clients.ts, GET /lost). Передачи его не ставили, и клиент,
       * потерянный ровно после трёх передач, попадал в раздел с ПУСТОЙ
       * цепочкой — без того единственного, ради чего раздел и делался.
       */
      await logTimeline({
        clientId: client.id,
        actor: { kind: "agent", agentId: input.agentId },
        type: "SYSTEM",
        outcome: "NEGATIVE",
        notes: note,
        voiceNoteUrl: input.voiceNoteUrl ?? null,
        voiceNoteTranscript: input.voiceNoteTranscript ?? null,
        tx,
      });
      const changed = await changeClientAgent({
        clientId: client.id,
        toAgentId: client.assignedAgentId,
        reason: note,
        // Инициатор — агент, нажавший «Передать» (П-5/П-8, 17.09.2026): предел
        // передач исчерпан, но решение всё равно человеческое, а не автоматика.
        actorId: input.agentId,
        source: "lost.transfer",
        skipInteraction: true,
        data: {
          refusalCount,
          status: "LOST" as const,
          lostAt: new Date(),
          ...(client.assignedAgentId ? { lastAgentId: client.assignedAgentId } : {}),
        },
        // Владелец из снимка — иначе «Потерянный» ложился бы на карточку, которую
        // руководитель только что отдал другому (ночная проверка 24.09.2026).
        guardWhere: { assignedAgentId: input.agentId },
        tx,
      });
      throwIfNotClaimed(changed);
    });
    // Агент не меняется (LOST не занимает слот в портфеле), поэтому
    // changeClientAgent выше сам спутников не гасит — но пуш «новый лид» и
    // живое обновление экрана всё равно устарели (аудит 11.09.2026, второй
    // заход по осиротевшим спутникам: эта ветка не публиковала live вовсе).
    await closeOwnershipSatellites({
      clientId: client.id,
      clientShortId: client.shortId,
      fromAgentId: client.assignedAgentId,
      toAgentId: client.assignedAgentId,
      reason: note,
    });
    void (async () => {
      const kind = await classifyClientLossFault(client.id);
      const points = await loadEventPoints();
      recordScoreEvent({
        agentId: input.agentId,
        kind,
        delta: points[kind],
        reason: `Клиент потерян после ${maxTransfers}-й передачи — ${client.fullName}`,
        sourceId: `client-lost-${client.id}`,
      });
    })();
    // Открытые требования по потерянному клиенту гасим — тот же приём, что у
    // promoteToLost/refuse (docs/audit-02-09-2026/01-lifecycle.md, баг B14).
    // reassignClientSummaries с toAgentId=null гасит ВСЕ виды (аудит 02.09 §7 шаг 6):
    // call_result/showing_book и так гасятся, а meeting/property/card_fill теперь
    // тоже закрываются вместо того чтобы висеть на агенте, у которого клиент уже LOST.
    void enqueueDirectorAlert({
      title: `⚠️ ${client.fullName}: предел передач исчерпан`,
      body: `${reasonLabel}. Карточка помечена «Потерянный» — назначьте агента вручную.`,
      url: `/clients/${client.shortId}`,
      tag: `transfer-exhausted-${client.id}`,
      recipientPermission: "clients.assign",
    });
    return { ok: true, lost: true };
  }

  // ПРИЧИНА = МАРШРУТ (routeTransferTarget выше) — конфликт минует подбор
  // получателя вовсе и уходит прямо руководителю, тем же путём, что и «свободных
  // агентов нет» ниже, только с другой формулировкой в хронологии и пуше.
  const routing = await routeTransferTarget(input.reason, client.id, input.agentId, input.comment);
  if (routing.kind === "escalate") {
    await prisma.$transaction(async (tx) => {
      await logTimeline({
        clientId: client.id,
        actor: { kind: "agent", agentId: input.agentId },
        type: "SYSTEM",
        notes: `${note}. Конфликт с клиентом — передано руководству`,
        voiceNoteUrl: input.voiceNoteUrl ?? null,
        voiceNoteTranscript: input.voiceNoteTranscript ?? null,
        tx,
      });
      const changed = await changeClientAgent({
        clientId: client.id,
        toAgentId: client.assignedAgentId,
        reason: `${note}. Конфликт с клиентом — передано руководству`,
        actorId: input.agentId,
        source: "transfer.escalate",
        skipInteraction: true,
        data: { refusalCount, escalatedAt: new Date() },
        guardWhere: { assignedAgentId: input.agentId },
        tx,
      });
      throwIfNotClaimed(changed);
    });
    // Агент не меняется — та же причина, что у ветки «предел передач» выше:
    // closeOwnershipSatellites надо звать явно.
    await closeOwnershipSatellites({
      clientId: client.id,
      clientShortId: client.shortId,
      fromAgentId: client.assignedAgentId,
      toAgentId: client.assignedAgentId,
      reason: `${note}. Конфликт с клиентом — передано руководству`,
    });
    void enqueueDirectorAlert({
      title: `⚠️ ${client.fullName}: конфликт с клиентом`,
      body: `${reasonLabel}. Требуется решение руководителя, не автоматический подбор агента.`,
      url: `/clients/${client.shortId}`,
      tag: `transfer-conflict-${client.id}`,
      recipientPermission: "clients.assign",
    });
    return { ok: true, lost: true };
  }

  // respectLimit=true (найдено код-ревью 13.08.2026): «Передача» не единственный
  // способ клиенту получить агента, в отличие от раздачи портфеля увольняющегося —
  // получателя, уже перегруженного сверх лимита, здесь предпочитать не нужно.
  // Конкретного получателя routeTransferTarget уже проверил на доступность сам
  // (isAgentAvailableForLead/pickStrongestAvailableAgent) — вторая проверка не нужна.
  const nextAgentId = routing.kind === "agent" ? routing.agentId : await pickNextAgentByKpiQueue([input.agentId], true);
  const routedNote = routing.kind === "agent" ? `${note} — ${routing.explain}` : note;
  if (!nextAgentId) {
    // Некому передать прямо сейчас — не блокируем агента, эскалируем руководству,
    // как и при исчерпанном пределе передач (тот же путь, что и в /refuse).
    await prisma.$transaction(async (tx) => {
      await logTimeline({
        clientId: client.id,
        actor: { kind: "agent", agentId: input.agentId },
        type: "SYSTEM",
        notes: `${note}. Свободных агентов нет — передано руководству`,
        voiceNoteUrl: input.voiceNoteUrl ?? null,
        voiceNoteTranscript: input.voiceNoteTranscript ?? null,
        tx,
      });
      const changed = await changeClientAgent({
        clientId: client.id,
        toAgentId: client.assignedAgentId,
        reason: `${note}. Свободных агентов нет — передано руководству`,
        actorId: input.agentId,
        source: "transfer.pending",
        skipInteraction: true,
        data: { refusalCount, escalatedAt: new Date() },
        guardWhere: { assignedAgentId: input.agentId },
        tx,
      });
      throwIfNotClaimed(changed);
    });
    // Агент не меняется — та же причина, что у веток выше.
    await closeOwnershipSatellites({
      clientId: client.id,
      clientShortId: client.shortId,
      fromAgentId: client.assignedAgentId,
      toAgentId: client.assignedAgentId,
      reason: `${note}. Свободных агентов нет — передано руководству`,
    });
    void enqueueDirectorAlert({
      title: `⏳ ${client.fullName}: передача ждёт назначения`,
      body: `${reasonLabel}. Свободных агентов сейчас нет.`,
      url: `/clients/${client.shortId}`,
      tag: `transfer-pending-${client.id}`,
      recipientPermission: "clients.assign",
    });
    return { ok: true, lost: true };
  }

  // Открытые окна call_result/meeting/showing_book не трогаем — их subjectId это id
  // конкретного звонка/показа, а не клиента, и они по праву остаются за агентом,
  // который их провёл (в отличие от снятых kind="call"/"waiting_check", у которых
  // subjectId был клиентом и они «плыли» за карточкой).
  await transferClientToAgent({
    clientId: client.id,
    fromAgentId: input.agentId,
    toAgentId: nextAgentId,
    note: routedNote,
    refusalCount,
    voiceNoteUrl: input.voiceNoteUrl,
    voiceNoteTranscript: input.voiceNoteTranscript,
    // Кнопка самого агента (см. RefuseClientInput.actorId-style комментарий у
    // transferClientToAgent) — input.agentId здесь и есть actorId, гейт
    // POST /:id/transfer в routes/clients/lifecycle.ts уже проверил владение.
    actorId: input.agentId,
  });

  void sendPushToAgent(nextAgentId, {
    title: "🤝 Вам передали клиента",
    body: `${client.fullName}: ${reasonLabel}`,
    url: `/clients/${client.shortId}`,
    tag: `transfer-${client.id}`,
  }).catch(() => {});

  return { ok: true, nextAgentId };
}

export async function transferClientToAgent(input: {
  clientId: string;
  fromAgentId: string;
  toAgentId: string;
  /** Что записать в хронологию — своими словами, для человека. */
  note: string;
  /** Новое значение счётчика передач/отказов — та же транзакция, что и сам перенос. */
  refusalCount?: number;
  voiceNoteUrl?: string;
  voiceNoteTranscript?: string;
  /**
   * LAW П-5 (закон о владении клиентом, 17.09.2026). ДВА вызывающих с разной
   * природой действия: `transferClientByAgent` выше — САМ агент нажал «Передать»
   * (`input.agentId` там и есть actorId, гейт `POST /:id/transfer` уже проверил,
   * что это владелец карточки) — передаёт его; `lib/leadAccept.ts::releaseClient`
   * (портфель полон, освобождение места под свой объект) — автоматика, актора
   * НЕТ и не передаёт умышленно: это ровно механизм №11 из `docs/audit/recon-17-09/
   * 02-auto-transfer-mechanisms.md` («requiresRelease → transfer... минуя
   * canTransferClient. Нарушает: ДА безоговорочно») — с этой правкой общий
   * сторож `changeClientAgent` (П-3) наконец его прикрывает. Без явного поля
   * здесь пришлось бы угадывать актора по вызывающему коду — сторож принял
   * бы кнопку агента за ту же автоматику и ошибочно заблокировал бы её.
   */
  actorId?: string | null;
}): Promise<ClientTransferResult> {
  const tasks = await prisma.$transaction(async (tx) => {
    const t = await tx.interaction.updateMany({
      where: {
        clientId: input.clientId,
        agentId: input.fromAgentId,
        nextAction: { not: null },
        completedAt: null,
      },
      data: { agentId: input.toAgentId },
    });
    // ДЕФЕКТ П-10 (docs/audit/recon-17-09/04-timeline-authorship.md §b п.2):
    // раньше запись безусловно подписывалась agentId: input.toAgentId — ПОЛУЧАТЕЛЕМ,
    // который к передаче не имеет отношения ни как деятель, ни как автоматика.
    // input.actorId задан ТОЛЬКО когда передачу инициировал живой человек
    // (transferClientByAgent — кнопка агента/руководителя, см. докстринг поля
    // actorId выше); lib/leadAccept.ts::releaseClient (автоматическое
    // освобождение места под свой объект) actorId умышленно не передаёт —
    // это и есть автоматика без деятеля, actor: system, subjectAgentId — новый
    // держатель (получатель), тому в его ленте будет что смотреть.
    await logTimeline({
      clientId: input.clientId,
      actor: input.actorId
        ? { kind: "agent", agentId: input.actorId }
        : { kind: "system", source: "clientTransfer.release", subjectAgentId: input.toAgentId },
      type: "SYSTEM",
      notes: input.note,
      voiceNoteUrl: input.voiceNoteUrl ?? null,
      voiceNoteTranscript: input.voiceNoteTranscript ?? null,
      tx,
    });
    const changed = await changeClientAgent({
      clientId: input.clientId,
      toAgentId: input.toAgentId,
      reason: input.note,
      // Актор передачи: явный (кнопка руководителя) или сам передающий агент (П-5).
      actorId: input.actorId ?? input.fromAgentId,
      source: "transfer",
      skipInteraction: true,
      data: {
        assignedAt: new Date(),
        acceptedAt: null,
        ...(input.refusalCount !== undefined ? { refusalCount: input.refusalCount } : {}),
      },
      // Карточка всё ещё у того, от кого передаём (ночная проверка 24.09.2026,
      // находка №5): иначе перенос перезаписывал бы назначение руководителя,
      // сделанное через /assign за секунды до этой записи. Задачи, уже
      // переехавшие строкой выше, откатываются вместе с транзакцией. Для
      // `lib/leadAccept.ts::releaseClient` ошибка уходит в его catch —
      // reportReleaseFailure.
      guardWhere: { assignedAgentId: input.fromAgentId },
      tx,
    });
    throwIfNotClaimed(changed);
    return t;
  });
  // Прежний агент больше не держатель заявки — если у него на устройстве всё
  // ещё висит «🔔 Новый лид»/«🔄 Передан вам» по этому клиенту, гасим (владелец
  // 19.08.2026): не критично для работы CRM, поэтому не блокируем и не валим
  // передачу, если push не дошёл.
  closeLeadPushNotification(input.fromAgentId, `lead-${input.clientId}`).catch((err) =>
    console.error("[push] закрытие уведомления после передачи:", err)
  );

  // ПЕРЕВЕС / ГАШЕНИЕ ТРЕБОВАНИЙ (аудит 02.09.2026, §7 шаг 6, сценарии G/S13, K/S15).
  // Открытые PendingSummary у прежнего агента блокируют ему выдачу новых лидов
  // (selection.ts:36-45) и штрафуют за просрочку по клиенту, которого у него уже
  // нет. Новый агент окна не получает. call_result/showing_book гасим (привязаны
  // к конкретному звонку/показу старого агента), meeting/seller_showing/property/
  // card_fill перевешиваем на нового с dueAt=now.
  // Разведка 07.09.2026 (класс «осиротевшие спутники»): заявка на удаление
  // клиента, поданная прежним агентом, оставалась висеть после передачи новому —
  // см. заголовок cancelPendingClientDeleteRequestOnTransfer.
  await cancelPendingClientDeleteRequestOnTransfer(input.clientId);

  // ЕДИНСТВЕННАЯ точка смены исполнителя (сюда сходятся и передача агентом, и
  // назначение надзором). Адресуем ОБОИМ: прежний обязан увидеть, что карточка
  // ушла из его списка, а не работать по ней ещё пять минут.
  publishClientUpdated({
    clientId: input.clientId,
    agentIds: [input.fromAgentId, input.toAgentId],
    actorId: input.fromAgentId,
  });

  return { movedTasks: tasks.count };
}
